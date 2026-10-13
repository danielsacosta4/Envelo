#!/usr/bin/env bash
# Runs inside the Envelo container. Called by scripts/install-proxmox.sh.
# Installs Node.js, fetches Envelo, sets up the systemd service, the `update`
# command, console autologin and the address banner.
set -Eeuo pipefail
export LC_ALL=C.UTF-8 LANG=C.UTF-8

: "${REPO:?REPO is not set}"
: "${REF:?REF is not set}"
: "${PORT:?PORT is not set}"
GITHUB_TOKEN="${GITHUB_TOKEN:-}"

msg_info() { printf '  \033[1;33m…\033[0m %s\n' "$*"; }
msg_ok()   { printf '  \033[1;32m✔\033[0m %s\n' "$*"; }
die()      { printf '  \033[1;31m✘\033[0m %s\n' "$*" >&2; exit 1; }

# Wait for the network (the host script waits too, this is a second check).
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
apt-get install -y -qq nodejs curl ca-certificates tar >/dev/null
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
cat > /usr/local/bin/update <<'UPDATER'
#!/usr/bin/env bash
# Update Envelo to the latest code on the configured branch. Your data is kept.
set -Eeuo pipefail
. /etc/envelo/envelo.env
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
AUTH=()
if [[ -n "$GITHUB_TOKEN" ]]; then
  AUTH=(-H "Authorization: Bearer $GITHUB_TOKEN")
fi
echo "Downloading Envelo ($REF)..."
curl -fsSL "${AUTH[@]}" "https://codeload.github.com/$REPO/tar.gz/refs/heads/$REF" \
  | tar xz -C "$TMP" --strip-components=1
rm -rf /opt/envelo.new && mkdir -p /opt/envelo.new
cp -r "$TMP/server" "$TMP/src" "$TMP/index.html" /opt/envelo.new/
rm -rf /opt/envelo && mv /opt/envelo.new /opt/envelo
# On first install the service does not exist yet; the installer starts it.
if systemctl cat envelo >/dev/null 2>&1; then
  systemctl restart envelo
fi
echo "Envelo updated."
UPDATER
chmod +x /usr/local/bin/update
ln -sf /usr/local/bin/update /usr/local/bin/envelo-update
msg_ok "Run 'update' to get the latest version"

msg_info "Downloading Envelo ($REF)"
/usr/local/bin/update >/dev/null
msg_ok "Envelo code installed in /opt/envelo"

msg_info "Starting the Envelo service"
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
systemctl daemon-reload
systemctl enable --now envelo
for _ in $(seq 1 15); do
  curl -fsS -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null && break
  sleep 1
done
curl -fsS -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null || die "Envelo did not start. See: journalctl -u envelo"
msg_ok "Envelo is responding on port $PORT"

msg_info "Enabling console autologin and the address banner"
PORT_SUFFIX=""
[[ "$PORT" == "80" ]] || PORT_SUFFIX=":$PORT"

# Log in as root on the container console without a password prompt. Anyone
# who can open the console already has root on the Proxmox host.
mkdir -p /etc/systemd/system/console-getty.service.d /etc/systemd/system/container-getty@.service.d
cat > /etc/systemd/system/console-getty.service.d/autologin.conf <<'EOF'
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin root --noclear --keep-baud console 115200,38400,9600 $TERM
EOF
cat > /etc/systemd/system/container-getty@.service.d/autologin.conf <<'EOF'
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin root --noclear --keep-baud %I 115200,38400,9600 $TERM
EOF

cat > /etc/profile.d/envelo-banner.sh <<EOF
# Installed by the Envelo installer. Shows the address of this container on login.
if [ -t 1 ]; then
  ENVELO_IP="\$(hostname -I 2>/dev/null | awk '{print \$1}')"
  printf '\n  Envelo is running.\n  Internal IP: %s\n  Open in a browser: http://%s$PORT_SUFFIX\n  Update Envelo:     update\n\n' "\${ENVELO_IP:-unknown}" "\${ENVELO_IP:-<container-ip>}"
fi
EOF

cat > /etc/issue <<EOF
Envelo container \n \l
Envelo: http://\4{eth0}$PORT_SUFFIX

EOF

systemctl daemon-reload
systemctl restart console-getty.service >/dev/null 2>&1 || true
msg_ok "Console logs in automatically and shows the address"
