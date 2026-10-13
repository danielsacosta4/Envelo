#!/usr/bin/env bash
# Install Envelo into a new LXC container on a Proxmox VE host.
#
# Run on the Proxmox host as root:
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/danielsacosta4/Envelo/main/scripts/install-proxmox.sh)"
#
# The container runs the Envelo server as a systemd service. Accounts and
# budgets are stored in /var/lib/envelo inside the container.
#
# Optional overrides (environment variables):
#   CTID=120            container ID (default: next free ID)
#   HOSTNAME_CT=envelo  container hostname
#   CORES=1  MEMORY=512  DISK_GB=2
#   STORAGE=local-lvm   storage for the root disk
#   BRIDGE=vmbr0        network bridge
#   PORT=80             port the app listens on inside the container
#   REF=main            Git branch or tag to install
set -Eeuo pipefail

CTID="${CTID:-}"
HOSTNAME_CT="${HOSTNAME_CT:-envelo}"
CORES="${CORES:-1}"
MEMORY="${MEMORY:-512}"
DISK_GB="${DISK_GB:-2}"
STORAGE="${STORAGE:-local-lvm}"
BRIDGE="${BRIDGE:-vmbr0}"
PORT="${PORT:-80}"
REF="${REF:-main}"
REPO="danielsacosta4/Envelo"
TEMPLATE_STORE="local"

msg()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mWarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run as root on the Proxmox host."
command -v pct >/dev/null   || die "pct not found. This script must run on a Proxmox VE host."
command -v pveam >/dev/null || die "pveam not found. This script must run on a Proxmox VE host."

if [[ -z "$CTID" ]]; then
  CTID="$(pvesh get /cluster/nextid)"
fi
if pct status "$CTID" >/dev/null 2>&1; then
  die "Container $CTID already exists. Set CTID to a free ID, or remove it first with: pct destroy $CTID"
fi

msg "Finding a Debian 12 template"
pveam update >/dev/null
TEMPLATE="$(pveam available --section system | awk '/debian-12-standard_.*_amd64\.tar\.zst/ {print $2}' | sort -V | tail -n 1)"
[[ -n "$TEMPLATE" ]] || die "No Debian 12 template found in pveam. Check your network connection."

if ! pveam list "$TEMPLATE_STORE" | grep -q "$TEMPLATE"; then
  msg "Downloading template $TEMPLATE"
  pveam download "$TEMPLATE_STORE" "$TEMPLATE"
fi

msg "Creating container $CTID ($HOSTNAME_CT)"
pct create "$CTID" "$TEMPLATE_STORE:vztmpl/$TEMPLATE" \
  --hostname "$HOSTNAME_CT" \
  --cores "$CORES" \
  --memory "$MEMORY" \
  --rootfs "$STORAGE:$DISK_GB" \
  --net0 "name=eth0,bridge=$BRIDGE,ip=dhcp" \
  --unprivileged 1 \
  --onboot 1 \
  --start 1

msg "Waiting for network in the container"
for _ in $(seq 1 60); do
  if pct exec "$CTID" -- getent hosts deb.debian.org >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
pct exec "$CTID" -- getent hosts deb.debian.org >/dev/null 2>&1 \
  || die "Container $CTID has no working network. Check the bridge and DHCP, then destroy it (pct destroy $CTID) and re-run."

msg "Installing Node.js and tools"
pct exec "$CTID" -- bash -c 'export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq nodejs curl ca-certificates tar >/dev/null'

msg "Installing Envelo ($REF)"
pct exec "$CTID" -- bash -c "cat > /usr/local/bin/envelo-update <<'UPDATER'
#!/usr/bin/env bash
# Fetch the latest Envelo code and restart the service. Data in /var/lib/envelo is kept.
set -Eeuo pipefail
REF=\"\${1:-$REF}\"
TMP=\"\$(mktemp -d)\"
trap 'rm -rf \"\$TMP\"' EXIT
curl -fsSL \"https://codeload.github.com/$REPO/tar.gz/refs/heads/\$REF\" | tar xz -C \"\$TMP\" --strip-components=1
rm -rf /opt/envelo.new && mkdir -p /opt/envelo.new
cp -r \"\$TMP/server\" \"\$TMP/src\" \"\$TMP/index.html\" /opt/envelo.new/
rm -rf /opt/envelo && mv /opt/envelo.new /opt/envelo
systemctl restart envelo
echo \"Envelo updated to \$REF.\"
UPDATER
chmod +x /usr/local/bin/envelo-update
id envelo >/dev/null 2>&1 || useradd --system --home /var/lib/envelo --shell /usr/sbin/nologin envelo
mkdir -p /var/lib/envelo && chown envelo:envelo /var/lib/envelo
/usr/local/bin/envelo-update '$REF'"

msg "Starting the Envelo service"
pct exec "$CTID" -- bash -c "cat > /etc/systemd/system/envelo.service <<EOF
[Unit]
Description=Envelo budgeting server
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/bin/node /opt/envelo/server/server.js
Environment=PORT=$PORT
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
systemctl enable --now envelo"

msg "Setting automatic console login and the address banner"
PORT_SUFFIX=""
[[ "$PORT" == "80" ]] || PORT_SUFFIX=":$PORT"
pct exec "$CTID" -- mkdir -p /etc/systemd/system/console-getty.service.d /etc/systemd/system/container-getty@.service.d

# Log in as root on the container console without a password prompt.
# Anyone who can open the console already has root access to the Proxmox host,
# so this adds no exposure beyond that.
AUTOLOGIN_TMP="$(mktemp -d)"
cat > "$AUTOLOGIN_TMP/console-getty.conf" <<'EOF'
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin root --noclear --keep-baud console 115200,38400,9600 $TERM
EOF
cat > "$AUTOLOGIN_TMP/container-getty.conf" <<'EOF'
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin root --noclear --keep-baud %I 115200,38400,9600 $TERM
EOF
pct push "$CTID" "$AUTOLOGIN_TMP/console-getty.conf" /etc/systemd/system/console-getty.service.d/autologin.conf
pct push "$CTID" "$AUTOLOGIN_TMP/container-getty.conf" /etc/systemd/system/container-getty@.service.d/autologin.conf

# Show the internal IP and app address on login (shell banner).
BANNER_TMP="$(mktemp -d)"
cat > "$BANNER_TMP/envelo-banner.sh" <<'EOF'
# Installed by the Envelo installer. Shows the address of this container on login.
if [ -t 1 ]; then
  ENVELO_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
  printf '\n  Envelo is running.\n  Internal IP: %s\n  Open in a browser: http://%s__PORT_SUFFIX__\n\n' "${ENVELO_IP:-unknown}" "${ENVELO_IP:-<container-ip>}"
fi
EOF
sed -i "s|__PORT_SUFFIX__|$PORT_SUFFIX|" "$BANNER_TMP/envelo-banner.sh"
pct push "$CTID" "$BANNER_TMP/envelo-banner.sh" /etc/profile.d/envelo-banner.sh

# Show the same address on the console before login (the pre-login screen).
cat > "$BANNER_TMP/issue" <<EOF
Envelo container \n \l
Envelo: http://\4{eth0}$PORT_SUFFIX

EOF
pct push "$CTID" "$BANNER_TMP/issue" /etc/issue
rm -rf "$AUTOLOGIN_TMP" "$BANNER_TMP"

pct exec "$CTID" -- systemctl daemon-reload
pct exec "$CTID" -- systemctl restart console-getty.service >/dev/null 2>&1 || true

IP="$(pct exec "$CTID" -- hostname -I | awk '{print $1}')"
msg "Envelo is installed in container $CTID."
if [[ "$PORT" == "80" ]]; then
  echo "    Open: http://${IP:-<container-ip>}/"
else
  echo "    Open: http://${IP:-<container-ip>}:$PORT/"
fi
echo "    Update later:  pct exec $CTID -- envelo-update"
echo "    Backups:       data is in /var/lib/envelo inside the container; include it in your Proxmox backups."
echo
warn "Traffic is plain HTTP. Put it behind HTTPS (for example a reverse proxy with a certificate) before using it outside your home network, then set SECURE_COOKIES=1 in the service."
