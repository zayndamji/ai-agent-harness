#!/usr/bin/env bash
# Starts the web UI: builds the image if anything changed, starts the `web`
# container, waits until it answers, and prints the address to open.
# Usage: ./start.sh
set -euo pipefail
cd "$(dirname "$0")"

if ! docker info >/dev/null 2>&1; then
  if [ "$(uname)" = "Darwin" ] && [ -d /Applications/Docker.app ]; then
    echo "Starting Docker Desktop…"
    open -a Docker
    for _ in $(seq 1 60); do
      docker info >/dev/null 2>&1 && break
      sleep 2
    done
  fi
  docker info >/dev/null 2>&1 || { echo "Docker isn't running. Start it and try again." >&2; exit 1; }
fi

if [ ! -f .env ]; then
  echo "No .env yet. Copy .env.example to .env and set HARNESS_PASSWORD (8 characters or more)." >&2
  exit 1
fi
password=$(grep -E '^HARNESS_PASSWORD=' .env | cut -d= -f2- || true)
if [ "${#password}" -lt 8 ]; then
  echo "Set HARNESS_PASSWORD in .env to 8 characters or more." >&2
  exit 1
fi

# The workspace folder must already exist: Docker would otherwise make an
# empty one, and a typo would hide your projects. Never the whole home folder.
workspace=$(grep -E '^HARNESS_WORKSPACE=' .env | cut -d= -f2- || true)
if [ -n "$workspace" ]; then
  case $workspace in "~"|"~/"*) workspace=$HOME${workspace#\~} ;; esac
  if [ ! -d "$workspace" ]; then
    echo "HARNESS_WORKSPACE in .env is $workspace, which isn't a folder. Make it first." >&2
    exit 1
  fi
  real=$(cd "$workspace" && pwd -P)
  if [ "$real" = "$(cd "$HOME" && pwd -P)" ] || [ "$real" = / ]; then
    echo "HARNESS_WORKSPACE can't be your home folder or /. Use a folder made for Claude." >&2
    exit 1
  fi
fi

docker compose up -d --build web

# The address from .env, the same values compose.yaml publishes.
bind=$(grep -E '^HARNESS_BIND=' .env | cut -d= -f2- || true)
port=$(grep -E '^HARNESS_PORT=' .env | cut -d= -f2- || true)
bind=${bind:-127.0.0.1}
port=${port:-8080}
host=$bind
[ "$host" = "0.0.0.0" ] && host=127.0.0.1
url="http://$host:$port"

for _ in $(seq 1 30); do
  if curl -fs -o /dev/null "$url/login"; then
    echo "The web UI is running at $url"
    [ -n "$workspace" ] && echo "Claude works in $workspace (/workspace in the container)."
    [ "$bind" = "0.0.0.0" ] && echo "It also listens on this machine's network address, port $port."
    exit 0
  fi
  sleep 1
done
echo "The container started but $url isn't answering yet. Check: docker compose logs web" >&2
exit 1
