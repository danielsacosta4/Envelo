#!/usr/bin/env bash
# Envelo LXC installer for Proxmox VE, in the style of community-scripts.
#
# Run on the Proxmox host as root:
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/danielsacosta4/Envelo/main/scripts/install-proxmox.sh)"
#
# Default: picks the next free ID, the first active storage, the first bridge,
# DHCP, 1 CPU, 512 MB RAM, 4 GB disk, port 80.
# Advanced: asks for each of those in a menu.
#
# Any value can be preset with an environment variable, for example:
#   CTID=120 PORT=8080 bash -c "$(curl -fsSL ...)"
#
# Private repository: set GITHUB_TOKEN to a token that can read the repo.
set -Eeuo pipefail

REPO="${REPO:-danielsacosta4/Envelo}"
REF="${REF:-main}"
GITHUB_TOKEN="${GITHUB_TOKEN:-}"
RAW="https://raw.githubusercontent.com/$REPO/$REF/scripts/install"

CTID="${CTID:-}"
HOSTNAME_CT="${HOSTNAME_CT:-envelo}"
CORES="${CORES:-1}"
MEMORY="${MEMORY:-512}"
DISK_GB="${DISK_GB:-4}"
PORT="${PORT:-80}"
STORAGE="${STORAGE:-}"
BRIDGE="${BRIDGE:-}"
TEMPLATE_STORE="${TEMPLATE_STORE:-}"

msg_info() { printf '  \033[1;33m…\033[0m %s\n' "$*"; }
msg_ok()   { printf '  \033[1;32m✔\033[0m %s\n' "$*"; }
msg_err()  { printf '  \033[1;31m✘\033[0m %s\n' "$*" >&2; }
header()   { printf '\n\033[1m%s\033[0m\n' "$*"; }
die()      { msg_err "$*"; exit 1; }

on_error() {
  msg_err "Installation stopped at line $1."
  if [[ -n "$CTID" ]] && pct status "$CTID" >/dev/null 2>&1; then
    echo "    Container $CTID exists. To start over: pct destroy $CTID, then run the installer again." >&2
  fi
}
trap 'on_error $LINENO' ERR

# Download a URL, sending the token for private repositories.
fetch() {
  if [[ -n "$GITHUB_TOKEN" ]]; then
    curl -fsSL -H "Authorization: Bearer $GITHUB_TOKEN" "$1"
  else
    curl -fsSL "$1"
  fi
}

# First active storage of a content type, preferring the given name.
pick_storage() {
  local list
  list="$(pvesm status -content "$1" | awk 'NR>1 && $3=="active" {print $1}')"
  if grep -qx "$2" <<<"$list"; then
    echo "$2"
  else
    head -n 1 <<<"$list"
  fi
}

pick_bridge() {
  local list
  list="$(ls /sys/class/net | grep '^vmbr' || true)"
  if grep -qx vmbr0 <<<"$list"; then
    echo vmbr0
  else
    head -n 1 <<<"$list"
  fi
}

is_number() { [[ "$1" =~ ^[0-9]+$ ]]; }

[[ $EUID -eq 0 ]] || die "Run as root on the Proxmox host."
for cmd in pct pveam pvesh pvesm; do
  command -v "$cmd" >/dev/null || die "$cmd not found. Run this on a Proxmox VE host."
done

header "Envelo for Proxmox VE"

# Choose the mode. Default needs no input; Advanced opens menus.
MODE="default"
if [[ -r /dev/tty ]] && command -v whiptail >/dev/null; then
  MODE="$(whiptail --title "Envelo" --menu "How do you want to install Envelo?" 14 70 2 \
    default  "Automatic: next free ID, storage and bridge found for you" \
    advanced "Choose the ID, resources, storage, bridge and port" \
    3>&1 1>&2 2>&3)" || die "Installation cancelled."
fi

# Automatic values, used as defaults in both modes.
[[ -n "$CTID" ]] || CTID="$(pvesh get /cluster/nextid)"
[[ -n "$STORAGE" ]] || STORAGE="$(pick_storage rootdir local-lvm)"
[[ -n "$TEMPLATE_STORE" ]] || TEMPLATE_STORE="$(pick_storage vztmpl local)"
[[ -n "$BRIDGE" ]] || BRIDGE="$(pick_bridge)"
[[ -n "$STORAGE" ]] || die "No active storage found for containers."
[[ -n "$TEMPLATE_STORE" ]] || die "No active storage found for templates."
[[ -n "$BRIDGE" ]] || die "No network bridge found (expected vmbr0)."

if [[ "$MODE" == "advanced" ]]; then
  ask() {
    whiptail --title "Envelo" --inputbox "$1" 9 70 "$2" 3>&1 1>&2 2>&3 || die "Installation cancelled."
  }
  CTID="$(ask "Container ID" "$CTID")"
  HOSTNAME_CT="$(ask "Hostname" "$HOSTNAME_CT")"
  CORES="$(ask "CPU cores" "$CORES")"
  MEMORY="$(ask "Memory in MB" "$MEMORY")"
  DISK_GB="$(ask "Disk size in GB" "$DISK_GB")"
  STORAGE="$(ask "Storage for the container disk" "$STORAGE")"
  BRIDGE="$(ask "Network bridge (DHCP)" "$BRIDGE")"
  PORT="$(ask "Port for the Envelo web app" "$PORT")"
fi

is_number "$CTID" || die "Container ID must be a number."
is_number "$CORES" || die "CPU cores must be a number."
is_number "$MEMORY" || die "Memory must be a number of MB."
is_number "$DISK_GB" || die "Disk size must be a number of GB."
is_number "$PORT" || die "Port must be a number."
pct status "$CTID" >/dev/null 2>&1 && die "Container $CTID already exists. Choose another ID."

header "Preparing the container"
msg_info "Finding a Debian 12 template"
TEMPLATE="$(pveam available --section system | awk '/debian-12-standard_.*_amd64\.tar\.zst/ {print $2}' | sort -V | tail -n 1)"
[[ -n "$TEMPLATE" ]] || die "No Debian 12 template found. Check the host's internet access."
if ! pveam list "$TEMPLATE_STORE" | grep -q "$TEMPLATE"; then
  msg_info "Downloading $TEMPLATE"
  pveam download "$TEMPLATE_STORE" "$TEMPLATE" >/dev/null
fi
msg_ok "Template $TEMPLATE is ready"

msg_info "Creating container $CTID ($HOSTNAME_CT) on $STORAGE"
pct create "$CTID" "$TEMPLATE_STORE:vztmpl/$TEMPLATE" \
  --hostname "$HOSTNAME_CT" \
  --cores "$CORES" \
  --memory "$MEMORY" \
  --rootfs "$STORAGE:$DISK_GB" \
  --net0 "name=eth0,bridge=$BRIDGE,ip=dhcp" \
  --unprivileged 1 \
  --onboot 1 \
  --start 1 >/dev/null
msg_ok "Container $CTID created and started"

msg_info "Waiting for an IP address"
IP=""
for _ in $(seq 1 60); do
  IP="$(pct exec "$CTID" -- hostname -I 2>/dev/null | awk '{print $1}' || true)"
  [[ -n "$IP" ]] && break
  sleep 2
done
[[ -n "$IP" ]] || die "The container got no IP address. Check the bridge and DHCP, then: pct destroy $CTID"
msg_ok "Container address is $IP"

header "Installing Envelo inside the container"
CT_SCRIPT="$(mktemp)"
trap 'rm -f "$CT_SCRIPT"; on_error $LINENO' ERR
fetch "$RAW/envelo-container.sh" > "$CT_SCRIPT" || die "Could not download the container install script from $RAW."
pct push "$CTID" "$CT_SCRIPT" /root/envelo-container.sh
rm -f "$CT_SCRIPT"
pct exec "$CTID" -- env REPO="$REPO" REF="$REF" PORT="$PORT" GITHUB_TOKEN="$GITHUB_TOKEN" \
  bash /root/envelo-container.sh

PORT_SUFFIX=""
[[ "$PORT" == "80" ]] || PORT_SUFFIX=":$PORT"

header "Envelo is ready"
echo "  Open in a browser:  http://$IP$PORT_SUFFIX"
echo "  Create your account on that page, then start budgeting."
echo
echo "  Console:            pct enter $CTID   (logs in automatically)"
echo "  Update Envelo:      pct exec $CTID -- /usr/local/bin/update"
echo "  Data:               /var/lib/envelo inside the container; include it in Proxmox backups"
echo
echo "  Traffic is plain HTTP. Put it behind HTTPS before using it outside your home network,"
echo "  then set SECURE_COOKIES=1 in /etc/systemd/system/envelo.service and restart envelo."
