#!/usr/bin/env bash
# Install Envelo on any Debian or Ubuntu machine (a VM, a mini PC, a VPS, or
# an LXC container you made yourself). For Proxmox, use install-proxmox.sh,
# which also creates the container.
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/danielsacosta4/Envelo/main/scripts/install.sh)"
#
# Installs Node.js (18 or newer), SQLite, the Envelo service (systemd), the
# `update` and `envelo` commands, and an encryption key for the data.
# Settings, as environment variables:
#   PORT=3000            port for the web app (default 3000)
#   REF=main             branch to install, e.g. a test branch
#   GITHUB_TOKEN=...     for a private repository
set -Eeuo pipefail

REPO="${REPO:-danielsacosta4/Envelo}"
REF="${REF:-main}"
PORT="${PORT:-3000}"
GITHUB_TOKEN="${GITHUB_TOKEN:-}"

die() { printf '  \033[1;31m✘\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run as root (sudo -i first)."
command -v apt-get >/dev/null || die "This installer is for Debian and Ubuntu (apt)."
command -v systemctl >/dev/null || die "systemd is needed to run Envelo as a service."
[[ "$PORT" =~ ^[0-9]+$ ]] || die "PORT must be a number."
if [[ -f /etc/envelo/envelo.env ]]; then
  die "Envelo is already installed here. Run 'update' to get the latest version."
fi

printf '\n\033[1mEnvelo installer\033[0m  (branch %s, port %s)\n\n' "$REF" "$PORT"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates >/dev/null

AUTH=()
[[ -n "$GITHUB_TOKEN" ]] && AUTH=(-H "Authorization: Bearer $GITHUB_TOKEN")
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fsSL "${AUTH[@]}" "https://raw.githubusercontent.com/$REPO/$REF/scripts/install/envelo-container.sh" -o "$TMP/setup.sh" \
  || die "Could not download the installer for branch $REF."

REPO="$REPO" REF="$REF" PORT="$PORT" GITHUB_TOKEN="$GITHUB_TOKEN" AUTOLOGIN=0 bash "$TMP/setup.sh"

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
SUFFIX=""
[[ "$PORT" == "80" ]] || SUFFIX=":$PORT"
printf '\n  \033[1;32m✔\033[0m Envelo is running: http://%s%s\n' "${IP:-localhost}" "$SUFFIX"
printf '    Update later with: update\n    Admin commands:    envelo\n'
printf '    Put it behind HTTPS (a reverse proxy) to install it as an app on your phone.\n\n'
