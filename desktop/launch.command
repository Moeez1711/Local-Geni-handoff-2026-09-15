#!/bin/zsh
cd -- "$(dirname -- "$0")/.." || exit 1
unset ELECTRON_RUN_AS_NODE
if [[ ! -x node_modules/.bin/electron ]]; then
  printf 'Desktop dependencies are missing. Run npm install in this project first.\n'
  read -r '?Press Return to close.'
  exit 1
fi
exec npm run desktop
