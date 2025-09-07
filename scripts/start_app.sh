#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENV_DIR="$PROJECT_ROOT/env"
PY="$VENV_DIR/bin/python"
MODE="${MODE:-dev}" # dev | prod | gunicorn
HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-5000}"
WORKERS="${WORKERS:-4}"
LOG_LEVEL="${LOG_LEVEL:-info}"
APP_MODULE="run:my_app"

if [ ! -x "$PY" ]; then
  echo "[run] Virtualenv python not found. Run scripts/setup_env.sh first." >&2
  exit 2
fi

source "$VENV_DIR/bin/activate"
cd "$PROJECT_ROOT"

export FLASK_APP=run.py
export FLASK_ENV=${FLASK_ENV:-development}

if [ "$MODE" = "dev" ]; then
  echo "[run] Starting Flask development server on $HOST:$PORT"
  "$PY" - <<PY
from app import create_app
import os
app = create_app()
app.run(host=os.environ.get('HOST','${HOST}'), port=int(os.environ.get('PORT','${PORT}')))
PY
elif [ "$MODE" = "prod" ]; then
  echo "[run] Starting production (gunicorn) server with sync workers=$WORKERS"
  exec "$VENV_DIR/bin/gunicorn" -w "$WORKERS" -b "$HOST:$PORT" --log-level "$LOG_LEVEL" "$APP_MODULE"
elif [ "$MODE" = "gunicorn" ]; then
  echo "[run] Starting explicit gunicorn module=$APP_MODULE"
  exec "$VENV_DIR/bin/gunicorn" -w "$WORKERS" -b "$HOST:$PORT" --log-level "$LOG_LEVEL" "$APP_MODULE"
else
  echo "[run] Unknown MODE=$MODE (expected dev|prod|gunicorn)" >&2
  exit 3
fi
