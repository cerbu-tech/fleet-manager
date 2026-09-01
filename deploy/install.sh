#!/usr/bin/env bash
# fleet-manager installer — Linux (systemd user unit). Other OSes: run `npm start` manually.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "== checking prerequisites"
command -v node >/dev/null || { echo "node not found (need >= 24)"; exit 1; }
node -e 'process.exit(parseInt(process.versions.node) >= 24 ? 0 : 1)' || { echo "node >= 24 required, found $(node --version)"; exit 1; }
command -v tmux >/dev/null || { echo "tmux not found"; exit 1; }
command -v git >/dev/null || { echo "git not found"; exit 1; }
command -v claude >/dev/null || { echo "claude CLI not found — install Claude Code and run 'claude auth login'"; exit 1; }
command -v openssl >/dev/null || { echo "openssl not found (needed to generate the API token)"; exit 1; }

echo "== building"
npm ci
npm run build

if [ "$(uname -s)" != "Linux" ]; then
  echo "== non-Linux host: skipping systemd unit. Start manually with: npm start"
  exit 0
fi

echo "== installing systemd user unit"
mkdir -p "$HOME/.config/systemd/user" "$HOME/.config/fleet-manager"
if [ ! -f "$HOME/.config/fleet-manager/env" ]; then
  umask 177
  echo "FLEET_API_TOKEN=$(openssl rand -hex 24)" > "$HOME/.config/fleet-manager/env"
  umask 022
  echo "   generated $HOME/.config/fleet-manager/env"
fi
sed "s|@WORKDIR@|$PWD|g" deploy/fleet-managerd.service > "$HOME/.config/systemd/user/fleet-managerd.service"
systemctl --user daemon-reload
echo "== done. Next:"
echo "   cp config.example.yaml config.yaml   # and edit"
echo "   systemctl --user enable --now fleet-managerd"
