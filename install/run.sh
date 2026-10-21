#!/usr/bin/env bash
# Runs the router for model-router.service. With nvm installed, it uses the node that nvm's default alias names, or the
# newest installed node when that alias names a removed version, so installing or removing Node versions does not
# break the service. Without nvm, it uses the node the installer found.
set -e

main="$(dirname "$0")/../src/main.mjs"
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [[ -s "$NVM_DIR/nvm.sh" ]]; then
  # nvm.sh fails under set -e, so it runs without it.
  set +e
  . "$NVM_DIR/nvm.sh" --no-use
  if ! nvm use --silent default >/dev/null 2>&1; then
    echo "nvm's default alias names no installed version; using the newest installed node. Run nvm alias default <version> to choose one." >&2
    nvm use --silent node >/dev/null || { echo "nvm has no installed node." >&2; exit 1; }
  fi
  set -e
  exec node "$main"
fi
exec "$MODEL_ROUTER_NODE" "$main"
