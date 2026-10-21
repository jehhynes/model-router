#!/usr/bin/env bash
# Installs and starts the model-router systemd user service.
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

if [[ "${1:-}" == "--uninstall" ]]; then
  systemctl --user disable --now model-router.service || true
  rm -f "$unit_dir/model-router.service"
  systemctl --user daemon-reload
  exit 0
fi

[[ -f "$repo/.env" ]] || { echo "Create $repo/.env from .env.example first." >&2; exit 1; }
node="$(command -v node)" || { echo "node is not on PATH." >&2; exit 1; }

mkdir -p "$unit_dir"
sed -e "s|@NODE@|$node|" -e "s|@REPO@|$repo|" "$repo/install/model-router.service" > "$unit_dir/model-router.service"
systemctl --user daemon-reload
systemctl --user enable --now model-router.service
systemctl --user is-active --quiet model-router.service
echo "Installed and started model-router.service."
