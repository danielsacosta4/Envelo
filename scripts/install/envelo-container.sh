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

# Settings are read as KEY=VALUE lines, never run as shell code, and only
# known keys are taken.
load_env() {
  local file="$1" line key value
  [[ -f "$file" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^([A-Z_][A-Z0-9_]*)=(.*)$ ]] || continue
    key="${BASH_REMATCH[1]}"; value="${BASH_REMATCH[2]}"
    value="${value#\"}"; value="${value%\"}"
    case "$key" in
      REPO|REF|PORT|GITHUB_TOKEN|AUTOLOGIN|TRUST_PROXY|REGISTRATION|SECURE_COOKIES|RECEIPT_QUOTA_MB|DATA_DIR) export "$key=$value" ;;
    esac
  done < "$file"
}

MODE="${1:-install}"
if [[ "$MODE" == "--refresh" ]]; then
  load_env /etc/envelo/envelo.env
  load_env /etc/envelo/update.env
fi

: "${REPO:?REPO is not set}"
: "${REF:?REF is not set}"
: "${PORT:?PORT is not set}"
GITHUB_TOKEN="${GITHUB_TOKEN:-}"
# Console autologin: opt-in (anyone who may open the console gets root).
AUTOLOGIN="${AUTOLOGIN:-0}"
# Behind a reverse proxy (the usual setup): client addresses and HTTPS come
# from its X-Forwarded-* headers. Set TRUST_PROXY=0 when browsers reach
# Envelo directly.
TRUST_PROXY="${TRUST_PROXY:-1}"
REGISTRATION="${REGISTRATION:-invite}"

# Values end up in config files and URLs: only plain ones are accepted.
[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "REPO must look like owner/name." >&2; exit 1; }
[[ "$REF" =~ ^[A-Za-z0-9._/-]{1,100}$ && "$REF" != *..* ]] || { echo "REF must be a branch or tag name." >&2; exit 1; }
{ [[ "$PORT" =~ ^[0-9]{1,5}$ ]] && (( PORT >= 1 && PORT <= 65535 )); } || { echo "PORT must be a number from 1 to 65535." >&2; exit 1; }
[[ "$GITHUB_TOKEN" =~ ^[A-Za-z0-9_]*$ ]] || { echo "GITHUB_TOKEN has unexpected characters." >&2; exit 1; }
[[ "$AUTOLOGIN" =~ ^[01]$ && "$TRUST_PROXY" =~ ^[01]$ ]] || { echo "AUTOLOGIN and TRUST_PROXY must be 0 or 1." >&2; exit 1; }
[[ "$REGISTRATION" =~ ^(open|invite|closed)$ ]] || { echo "REGISTRATION must be open, invite or closed." >&2; exit 1; }

# The service reads envelo.env; only root reads update.env (the GitHub token
# for private repositories is never handed to the web server).
write_config() {
  mkdir -p /etc/envelo
  (
    umask 077
    {
      printf '%s\n' "REPO=$REPO" "REF=$REF" "PORT=$PORT" "AUTOLOGIN=$AUTOLOGIN" "TRUST_PROXY=$TRUST_PROXY" "REGISTRATION=$REGISTRATION"
      [[ -n "${SECURE_COOKIES:-}" ]] && printf '%s\n' "SECURE_COOKIES=$SECURE_COOKIES"
      [[ -n "${RECEIPT_QUOTA_MB:-}" ]] && printf '%s\n' "RECEIPT_QUOTA_MB=$RECEIPT_QUOTA_MB"
      true
    } > /etc/envelo/envelo.env.new
    printf '%s\n' "GITHUB_TOKEN=$GITHUB_TOKEN" > /etc/envelo/update.env.new
  )
  chmod 600 /etc/envelo/envelo.env.new /etc/envelo/update.env.new
  mv -f /etc/envelo/envelo.env.new /etc/envelo/envelo.env
  mv -f /etc/envelo/update.env.new /etc/envelo/update.env
}

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
# Settings are read as KEY=VALUE lines, never run as shell code, and only
# known keys are taken.
load_env() {
  local file="$1" line key value
  [[ -f "$file" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^([A-Z_][A-Z0-9_]*)=(.*)$ ]] || continue
    key="${BASH_REMATCH[1]}"; value="${BASH_REMATCH[2]}"
    value="${value#\"}"; value="${value%\"}"
    case "$key" in
      REPO|REF|PORT|GITHUB_TOKEN|AUTOLOGIN|TRUST_PROXY|REGISTRATION|SECURE_COOKIES|RECEIPT_QUOTA_MB|DATA_DIR) export "$key=$value" ;;
    esac
  done < "$file"
}
load_env /etc/envelo/envelo.env
load_env /etc/envelo/update.env
{ [[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ && "$REF" =~ ^[A-Za-z0-9._/-]{1,100}$ && "$REF" != *..* ]]; } \
  || { echo "REPO or REF in /etc/envelo/envelo.env is not valid." >&2; exit 1; }
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
AUTH=()
if [[ -n "${GITHUB_TOKEN:-}" ]]; then
  # The header goes through a private file, not the command line, so the
  # token does not show in the process list.
  printf 'header = "Authorization: Bearer %s"\n' "$GITHUB_TOKEN" > "$TMP/curl.conf"
  chmod 600 "$TMP/curl.conf"
  AUTH=(--config "$TMP/curl.conf")
fi
echo "Downloading Envelo ($REF)..."
TMP_CODE="$TMP/code"
mkdir -p "$TMP_CODE"
curl -fsSL "${AUTH[@]}" "https://codeload.github.com/$REPO/tar.gz/refs/heads/$REF" \
  | tar xz -C "$TMP_CODE" --strip-components=1
# Keep a copy of the data from just before this update (the last 5 are kept).
DATA_DIR="${DATA_DIR:-/var/lib/envelo}"
if [[ -f "$DATA_DIR/db.json" ]]; then
  install -d -m 0700 -o envelo -g envelo "$DATA_DIR/backups"
  OLD_VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' /opt/envelo/package.json 2>/dev/null || true)"
  cp -p "$DATA_DIR/db.json" "$DATA_DIR/backups/pre-update-${OLD_VERSION:-unknown}-$(date +%Y%m%d-%H%M%S).json"
  chown -R envelo:envelo "$DATA_DIR/backups" 2>/dev/null || true
  ls -1t "$DATA_DIR"/backups/pre-update-*.json 2>/dev/null | tail -n +6 | xargs -r rm -f
fi
rm -rf /opt/envelo.new && mkdir -p /opt/envelo.new
cp -r "$TMP_CODE/server" "$TMP_CODE/src" "$TMP_CODE/index.html" /opt/envelo.new/
[[ -f "$TMP_CODE/package.json" ]] && cp "$TMP_CODE/package.json" /opt/envelo.new/
rm -rf /opt/envelo && mv /opt/envelo.new /opt/envelo
# Re-apply the container setup from the new version (autologin, banner, this
# command). A problem here must never stop the restart below.
if [[ -f "$TMP_CODE/scripts/install/envelo-container.sh" ]]; then
  bash "$TMP_CODE/scripts/install/envelo-container.sh" --refresh \
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
Environment=KEY_FILE=/etc/envelo/secret.key
Restart=on-failure
User=envelo
Group=envelo
UMask=0077
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
ProtectSystem=strict
PrivateTmp=true
ReadWritePaths=/var/lib/envelo

[Install]
WantedBy=multi-user.target
EOF
}

remove_autologin() {
  if [[ -d /etc/systemd/system/container-getty@1.service.d || -d /etc/systemd/system/console-getty.service.d ]]; then
    rm -rf /etc/systemd/system/container-getty@1.service.d /etc/systemd/system/console-getty.service.d
    systemctl daemon-reload
    systemctl restart container-getty@1.service >/dev/null 2>&1 || true
    systemctl restart console-getty.service >/dev/null 2>&1 || true
  fi
}

# Extra sandboxing in a drop-in, so it can be taken back on containers where
# a setting is not supported (the service would not start).
HARDENING=/etc/systemd/system/envelo.service.d/hardening.conf
install_hardening() {
  mkdir -p "$(dirname "$HARDENING")"
  cat > "$HARDENING" <<'CONF'
[Service]
ProtectHome=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
CONF
}
# Restart with the sandboxing; without it if Envelo does not come up.
check_hardening() {
  systemctl cat envelo >/dev/null 2>&1 || return 0
  systemctl daemon-reload
  systemctl restart envelo || true
  for _ in $(seq 1 15); do
    curl -fsS -o /dev/null "http://127.0.0.1:${PORT}/api/version" 2>/dev/null && return 0
    sleep 1
  done
  echo "Envelo did not start with the extra sandboxing on this container; running without it."
  rm -f "$HARDENING"
  systemctl daemon-reload
  systemctl restart envelo || true
}

install_console() {
  local port_suffix=""
  [[ "$PORT" == "80" ]] || port_suffix=":$PORT"

  # Log in as root on the container console without a password (opt-in with
  # AUTOLOGIN=1). The Proxmox console attaches to tty1 (container-getty@1) or
  # the console device (console-getty). Anyone allowed to open this
  # container's console in Proxmox gets root in it.
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
  printf '\n  Envelo is running.\n  Internal IP:        %s\n  Open in a browser:  http://%s$port_suffix\n  Update Envelo:      update\n  Admin commands:     envelo\n\n' "\${ENVELO_IP:-unknown}" "\${ENVELO_IP:-<container-ip>}"
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

# Encryption key for the data at rest. It lives in /etc/envelo, outside the
# data folder and its backups. A key an older version created next to the
# data is moved here, so data encrypted with it stays readable.
install_key() {
  local key=/etc/envelo/secret.key old=/var/lib/envelo/secret.key
  mkdir -p /etc/envelo
  if [[ ! -f "$key" ]]; then
    if [[ -f "$old" ]]; then
      mv "$old" "$key"
    else
      (umask 077; head -c 32 /dev/urandom | base64 > "$key")
    fi
  fi
  chown root:envelo "$key"
  chmod 640 "$key"
}

# `envelo` admin command: users, reset-password, reset-2fa, delete-user.
install_cli() {
  cat > /usr/local/bin/envelo <<'CLI'
#!/usr/bin/env bash
# Envelo admin commands. Run `envelo` for help.
# Settings are read as KEY=VALUE lines, never run as shell code, and only
# known keys are taken.
load_env() {
  local file="$1" line key value
  [[ -f "$file" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^([A-Z_][A-Z0-9_]*)=(.*)$ ]] || continue
    key="${BASH_REMATCH[1]}"; value="${BASH_REMATCH[2]}"
    value="${value#\"}"; value="${value%\"}"
    case "$key" in
      REPO|REF|PORT|GITHUB_TOKEN|AUTOLOGIN|TRUST_PROXY|REGISTRATION|SECURE_COOKIES|RECEIPT_QUOTA_MB|DATA_DIR) export "$key=$value" ;;
    esac
  done < "$file"
}
load_env /etc/envelo/envelo.env
export PORT DATA_DIR="${DATA_DIR:-/var/lib/envelo}"
exec /usr/bin/node /opt/envelo/server/cli.js "$@"
CLI
  chmod +x /usr/local/bin/envelo
  ln -sf /usr/local/bin/envelo /usr/bin/envelo
}

# Node.js 18 or newer is needed. Debian 12 has it; older systems get Node 20
# from NodeSource.
ensure_node() {
  local major=0
  if command -v node >/dev/null 2>&1; then
    major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  fi
  if (( major < 18 )); then
    export DEBIAN_FRONTEND=noninteractive
    apt-get install -y -qq ca-certificates curl gnupg >/dev/null
    mkdir -p /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
    apt-get update -qq
    apt-get install -y -qq nodejs >/dev/null
  fi
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
  # Older installs kept the GitHub token in envelo.env and had no
  # TRUST_PROXY / REGISTRATION: rewrite both files with the current values.
  had_proxy="$(grep -c '^TRUST_PROXY=' /etc/envelo/envelo.env 2>/dev/null || true)"
  write_config
  if [[ "${had_proxy:-0}" == "0" ]]; then
    echo "Added TRUST_PROXY=1 to /etc/envelo/envelo.env (Envelo behind a reverse proxy). Set it to 0 if browsers reach Envelo directly."
  fi
  install_packages
  install_update_command
  install_key
  install_cli
  install_service
  install_hardening
  chmod 700 /var/lib/envelo 2>/dev/null || true
  check_hardening
  if [[ "$AUTOLOGIN" == "1" ]]; then install_console; else remove_autologin; fi
  echo "Setup refreshed."
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
ensure_node
msg_ok "Node.js $(node --version) installed"

msg_info "Creating the envelo user and config"
id envelo >/dev/null 2>&1 || useradd --system --home /var/lib/envelo --shell /usr/sbin/nologin envelo
install -d -m 0700 -o envelo -g envelo /var/lib/envelo
write_config
msg_ok "Config written to /etc/envelo/envelo.env"

msg_info "Installing the update command"
install_update_command
msg_ok "Type 'update' in the container to get the latest version"

msg_info "Downloading Envelo ($REF)"
/usr/local/bin/update >/dev/null
msg_ok "Envelo code installed in /opt/envelo"

msg_info "Setting up encryption and the admin command"
install_key
install_cli
msg_ok "Data is encrypted with /etc/envelo/secret.key; 'envelo' runs admin commands"

msg_info "Starting the Envelo service"
install_service
install_hardening
systemctl daemon-reload
systemctl enable envelo
check_hardening
for _ in $(seq 1 15); do
  curl -fsS -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null && break
  sleep 1
done
curl -fsS -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null || die "Envelo did not start. See: journalctl -u envelo"
msg_ok "Envelo is responding on port $PORT"

if [[ "$AUTOLOGIN" == "1" ]]; then
  msg_info "Enabling console autologin and the address banner"
  install_console
  msg_ok "Console logs in automatically and shows the address"
fi
