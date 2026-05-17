#!/bin/bash
set -e

# Activate venv if it exists (Railpack installs here)
if [ -f /app/.venv/bin/activate ]; then
  source /app/.venv/bin/activate
fi

exec gunicorn --bind 0.0.0.0:$PORT --workers 2 --worker-class gthread --threads 4 --timeout 180 api:app
