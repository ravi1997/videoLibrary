#!/usr/bin/env bash
set -euo pipefail
# Lightweight helper to activate the project's venv and run the Flask app
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VENV="$ROOT_DIR/env"
PY="$VENV/bin/python"
PORT_ENV="${PORT:-5000}"
if [ ! -x "$PY" ]; then
  echo "virtualenv python not found at $PY"
  echo "Activate manually or set up venv: python -m venv env && source env/bin/activate"
  exit 2
fi
export FLASK_APP=run.py
cd "$ROOT_DIR"
# Run the Flask app using a small python wrapper so we can honor PORT env var without editing run.py
exec "$PY" - <<PY
from app import create_app
import os
app = create_app()
port = int(os.environ.get('PORT', '${PORT_ENV}'))
app.run(host='0.0.0.0', port=port)
PY
