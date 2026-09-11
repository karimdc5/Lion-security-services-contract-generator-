#!/bin/bash
# Start vidsave on 127.0.0.1:8723 using the venv next to this script.
# Creates the venv on first run.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d .venv ]; then
  echo "Creating virtualenv in $(pwd)/.venv"
  python3 -m venv .venv
  ./.venv/bin/pip install --quiet --upgrade pip
  ./.venv/bin/pip install --quiet -r requirements.txt
fi

exec ./.venv/bin/python server.py --port "${VIDSAVE_PORT:-8723}" "$@"
