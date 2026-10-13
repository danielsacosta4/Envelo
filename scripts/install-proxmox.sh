#!/usr/bin/env bash
# Install Envelo into a new LXC container on a Proxmox VE host.
#
# Run on the Proxmox host as root:
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/danielsacosta4/Envelo/main/scripts/install-proxmox.sh)"
#
# Optional overrides (environment variables):
#   CTID=120            container ID (default: next free ID)
#   HOSTNAME_CT=envelo  container hostname
#   CORES=1  MEMORY=512  DISK_GB=2
#   STORAGE=local-lvm   storage for the root disk
#   BRIDGE=vmbr0        network bridge
#   REF=main            Git branch or tag to install
set -Eeuo pipefail

CTID="${CTID:-}"
HOSTNAME_CT="${HOSTNAME_CT:-envelo}"
CORES="${CORES:-1}"
MEMORY="${MEMORY:-512}"
DISK_GB="${DISK_GB:-2}"
STORAGE="${STORAGE:-local-lvm}"
BRIDGE="${BRIDGE:-vmbr0}"
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
  || die "Container $CTID has no working network. Check the bridge and DHCP, then re-run with CTID=$CTID after destroying it."

msg "Installing nginx"
pct exec "$CTID" -- bash -c 'export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq nginx curl ca-certificates tar >/dev/null'

msg "Fetching Envelo ($REF)"
pct exec "$CTID" -- bash -c "
  set -Eeuo pipefail
  rm -rf /var/www/envelo && mkdir -p /var/www/envelo
  curl -fsSL 'https://codeload.github.com/$REPO/tar.gz/refs/heads/$REF' | tar xz -C /var/www/envelo --strip-components=1
  cd /var/www/envelo
  # Serve only the app. Tests, design mockups and repo metadata stay out of the web root.
  rm -rf test design scripts .git .github package.json README.md
"

msg "Configuring nginx"
pct exec "$CTID" -- bash -c 'cat > /etc/nginx/sites-available/envelo <<EOF
server {
    listen 80 default_server;
    server_name _;
    root /var/www/envelo;
    index index.html;
    location / {
        try_files \$uri \$uri/ =404;
    }
    location ~* \.(css|js)\$ {
        expires 1h;
    }
}
EOF
rm -f /etc/nginx/sites-enabled/default
ln -sf /etc/nginx/sites-available/envelo /etc/nginx/sites-enabled/envelo
nginx -t >/dev/null
systemctl enable --now nginx >/dev/null
systemctl reload nginx'

IP="$(pct exec "$CTID" -- hostname -I | awk '{print $1}')"
msg "Envelo is installed in container $CTID."
echo "    Open: http://${IP:-<container-ip>}/"
echo "    Update later: re-run this script with CTID=$CTID after 'pct destroy $CTID', or run:"
echo "    pct exec $CTID -- bash -c 'cd /tmp && curl -fsSL https://codeload.github.com/$REPO/tar.gz/refs/heads/$REF | tar xz && rm -rf /var/www/envelo && mv /tmp/Envelo-* /var/www/envelo && cd /var/www/envelo && rm -rf test design scripts .git .github package.json README.md'"
echo
warn "Budget data is stored in each browser (localStorage), not on this server. Export a backup regularly from the app footer."
