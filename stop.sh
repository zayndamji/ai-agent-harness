#!/usr/bin/env bash
# Stops the web UI and ends the running Claude Code session. The volumes
# (login, settings, conversation history and the workspace) are kept, so
# ./start.sh picks up where you left off.
# Usage: ./stop.sh
set -euo pipefail
cd "$(dirname "$0")"

if ! docker info >/dev/null 2>&1; then
  echo "Docker isn't running, so the web UI isn't either."
  exit 0
fi

docker compose down
echo "Stopped. Your login, conversations and workspace files are kept."
