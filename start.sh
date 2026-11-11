#!/usr/bin/env bash
# Starts the web UI: builds the image if anything changed, starts the `web`
# container, waits until it answers, and prints the address to open.
# Usage: ./start.sh          only this computer can open the web UI
#        ./start.sh --lan    other machines on the local network can too
set -euo pipefail
cd "$(dirname "$0")"

bind=127.0.0.1
for arg in "$@"; do
  case $arg in
    --lan) bind=0.0.0.0 ;;
    *) echo "Usage: ./start.sh [--lan]" >&2; exit 1 ;;
  esac
done
# compose.yaml publishes the port on this address. Set here on every start,
# so the web UI is open to the network only when --lan is given.
export HARNESS_BIND=$bind

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

# The port from .env, the same value compose.yaml publishes.
port=$(grep -E '^HARNESS_PORT=' .env | cut -d= -f2- || true)
port=${port:-28471}
url="http://127.0.0.1:$port"

for _ in $(seq 1 30); do
  if curl -fs -o /dev/null "$url/login"; then
    echo "The web UI is running at $url"
    [ -n "$workspace" ] && echo "Claude works in $workspace (/workspace in the container)."
    if [ "$bind" = 0.0.0.0 ]; then
      echo "It is also open to the local network, on this machine's address, port $port."
    else
      echo "Only this computer can open it. Use ./start.sh --lan to open it to the local network."
    fi
    exit 0
  fi
  sleep 1
done
echo "The container started but $url isn't answering yet. Check: docker compose logs web" >&2
exit 1
