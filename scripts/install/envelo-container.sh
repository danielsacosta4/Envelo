#!/usr/bin/env bash
# Runs inside the Envelo container.
#
#   envelo-container.sh            full install (called by scripts/install-proxmox.sh)
#   envelo-container.sh --refresh  re-apply system setup only (called by `update`)
#
# Full install: Node.js, the envelo user, config, app code, then the system
# setup. System setup: the `update` command, the systemd service, console
# autologin and the address banner. `update` runs --refresh after fetching new
# code, so fixes to the setup reach existing containers too.
set -Eeuo pipefail
export LC_ALL=C.UTF-8 LANG=C.UTF-8

MODE="${1:-install}"
if [[ "$MODE" == "--refresh" ]]; then
  set -a
  # shellcheck disable=SC1091
  . /etc/envelo/envelo.env
  set +a
fi

: "${REPO:?REPO is not set}"
: "${REF:?REF is not set}"
: "${PORT:?PORT is not set}"
GITHUB_TOKEN="${GITHUB_TOKEN:-}"

msg_info() { printf '  \033[1;33m…\033[0m %s\n' "$*"; }
msg_ok()   { printf '  \033[1;32m✔\033[0m %s\n' "$*"; }
die()      { printf '  \033[1;31m✘\033[0m %s\n' "$*" >&2; exit 1; }

install_update_command() {
  # Written to a temp file and moved into place, so a running `update` is
  # never overwritten mid-run.
  cat > /usr/local/bin/update.new <<'UPDATER'
#!/usr/bin/env bash
# Update Envelo to the latest code on the configured branch. Your data is kept.
set -Eeuo pipefail
set -a
. /etc/envelo/envelo.env
set +a
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
AUTH=()
if [[ -n "${GITHUB_TOKEN:-}" ]]; then
  AUTH=(-H "Authorization: Bearer $GITHUB_TOKEN")
fi
echo "Downloading Envelo ($REF)..."
curl -fsSL "${AUTH[@]}" "https://codeload.github.com/$REPO/tar.gz/refs/heads/$REF" \
  | tar xz -C "$TMP" --strip-components=1
rm -rf /opt/envelo.new && mkdir -p /opt/envelo.new
cp -r "$TMP/server" "$TMP/src" "$TMP/index.html" /opt/envelo.new/
[[ -f "$TMP/package.json" ]] && cp "$TMP/package.json" /opt/envelo.new/
rm -rf /opt/envelo && mv /opt/envelo.new /opt/envelo
# Re-apply the container setup from the new version (autologin, banner, this
# command). A problem here must never stop the restart below.
if [[ -f "$TMP/scripts/install/envelo-container.sh" ]]; then
  bash "$TMP/scripts/install/envelo-container.sh" --refresh \
    || echo "Warning: refreshing the container setup failed; Envelo itself is still updated."
fi
VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' /opt/envelo/package.json 2>/dev/null || true)"
# On first install the service does not exist yet; the installer starts it.
if systemctl cat envelo >/dev/null 2>&1; then
  systemctl daemon-reload
  systemctl restart envelo
  # Make sure the new server is the one answering.
  for _ in $(seq 1 15); do
    if curl -fsS -o /dev/null "http://127.0.0.1:${PORT}/api/version" 2>/dev/null; then
      echo "Envelo updated${VERSION:+ to $VERSION} and running."
      exit 0
    fi
    sleep 1
  done
  echo "Envelo was updated but did not start. See: journalctl -u envelo -n 50" >&2
  exit 1
fi
echo "Envelo updated${VERSION:+ to $VERSION}."
UPDATER
  chmod +x /usr/local/bin/update.new
  mv -f /usr/local/bin/update.new /usr/local/bin/update
  ln -sf /usr/local/bin/update /usr/local/bin/envelo-update
  # pct exec does not search /usr/local/bin, so also link it into /usr/bin.
  ln -sf /usr/local/bin/update /usr/bin/update
}

install_service() {
  cat > /etc/systemd/system/envelo.service <<EOF
[Unit]
Description=Envelo budgeting server
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/bin/node /opt/envelo/server/server.js
EnvironmentFile=/etc/envelo/envelo.env
Environment=HOST=0.0.0.0
Environment=DATA_DIR=/var/lib/envelo
Restart=on-failure
User=envelo
Group=envelo
AmbientCapabilities=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/envelo

[Install]
WantedBy=multi-user.target
EOF
}

install_console() {
  local port_suffix=""
  [[ "$PORT" == "80" ]] || port_suffix=":$PORT"

  # Log in as root on the container console without a password. The Proxmox
  # console attaches to tty1 (container-getty@1) or the console device
  # (console-getty). Anyone who can open it already has root on the host.
  rm -rf /etc/systemd/system/container-getty@.service.d   # broken override from 0.1.0-alpha.1
  mkdir -p /etc/systemd/system/container-getty@1.service.d /etc/systemd/system/console-getty.service.d
  cat > /etc/systemd/system/container-getty@1.service.d/override.conf <<'EOF'
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin root --noclear --keep-baud tty%I 115200,38400,9600 $TERM
EOF
  cat > /etc/systemd/system/console-getty.service.d/override.conf <<'EOF'
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin root --noclear --keep-baud console 115200,38400,9600 $TERM
EOF
  rm -f /etc/systemd/system/console-getty.service.d/autologin.conf

  cat > /etc/profile.d/envelo-banner.sh <<EOF
# Installed by Envelo. Shows the address of this container on login.
if [ -t 1 ]; then
  ENVELO_IP="\$(hostname -I 2>/dev/null | awk '{print \$1}')"
  printf '\n  Envelo is running.\n  Internal IP:        %s\n  Open in a browser:  http://%s$port_suffix\n  Update Envelo:      update\n\n' "\${ENVELO_IP:-unknown}" "\${ENVELO_IP:-<container-ip>}"
fi
EOF

  cat > /etc/issue <<EOF
Envelo container \n \l
Envelo: http://\4{eth0}$port_suffix

EOF

  systemctl daemon-reload
  systemctl restart container-getty@1.service >/dev/null 2>&1 || true
  systemctl restart console-getty.service >/dev/null 2>&1 || true
}

install_packages() {
  # sqlite3 reads Actual Budget exports on Node versions without node:sqlite.
  if ! command -v sqlite3 >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    { apt-get update -qq && apt-get install -y -qq sqlite3 >/dev/null; } \
      || echo "Could not install sqlite3; importing Actual .zip files will not work until it is installed."
  fi
}

if [[ "$MODE" == "--refresh" ]]; then
  install_packages
  install_update_command
  install_service
  install_console
  echo "Container setup refreshed."
  exit 0
fi

# Full install

msg_info "Checking network"
for _ in $(seq 1 30); do
  getent hosts deb.debian.org >/dev/null 2>&1 && break
  sleep 2
done
getent hosts deb.debian.org >/dev/null 2>&1 || die "No network inside the container."
msg_ok "Network is up"

msg_info "Installing Node.js and tools"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq nodejs curl ca-certificates tar sqlite3 >/dev/null
msg_ok "Node.js $(node --version) installed"

msg_info "Creating the envelo user and config"
id envelo >/dev/null 2>&1 || useradd --system --home /var/lib/envelo --shell /usr/sbin/nologin envelo
mkdir -p /var/lib/envelo /etc/envelo
chown envelo:envelo /var/lib/envelo
(
  umask 077
  cat > /etc/envelo/envelo.env <<EOF
REPO=$REPO
REF=$REF
PORT=$PORT
GITHUB_TOKEN=$GITHUB_TOKEN
EOF
)
chmod 600 /etc/envelo/envelo.env
msg_ok "Config written to /etc/envelo/envelo.env"

msg_info "Installing the update command"
install_update_command
msg_ok "Type 'update' in the container to get the latest version"

msg_info "Downloading Envelo ($REF)"
/usr/local/bin/update >/dev/null
msg_ok "Envelo code installed in /opt/envelo"

msg_info "Starting the Envelo service"
install_service
systemctl daemon-reload
systemctl enable --now envelo
for _ in $(seq 1 15); do
  curl -fsS -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null && break
  sleep 1
done
curl -fsS -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null || die "Envelo did not start. See: journalctl -u envelo"
msg_ok "Envelo is responding on port $PORT"

msg_info "Enabling console autologin and the address banner"
install_console
msg_ok "Console logs in automatically and shows the address"
