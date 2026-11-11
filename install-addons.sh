#!/bin/sh
# Installs the add-ons listed in addons.conf. Runs during the image build, as
# root, so add-ons land in the image and not in the home folder.
# Usage (from the Dockerfile): sh install-addons.sh /path/to/addons.conf
set -eu
set -f # package names are never glob patterns

conf=$1
if [ ! -f "$conf" ]; then
  echo "No addons.conf, so no add-ons."
  exit 0
fi

apt=''
npm=''
pip=''
while IFS= read -r line || [ -n "$line" ]; do
  line=${line%%#*}
  case $line in
    *[![:space:]]*) ;;
    *) continue ;;
  esac
  case $line in
    *:*) ;;
    *) echo "addons.conf: expected a line like 'apt: jq', got: $line" >&2; exit 1 ;;
  esac
  key=$(printf '%s' "${line%%:*}" | tr -d '[:space:]')
  packages=${line#*:}
  case $key in
    apt) apt="$apt $packages" ;;
    npm) npm="$npm $packages" ;;
    pip) pip="$pip $packages" ;;
    *) echo "addons.conf: unknown installer '$key'. Use apt, npm or pip." >&2; exit 1 ;;
  esac
done < "$conf"

# pip packages need Python and pip, so they come along without being listed.
if [ -n "${pip# }" ]; then
  apt="$apt python3 python3-pip"
fi

if [ -n "$(echo $apt)" ]; then
  echo "Add-ons from apt:$apt"
  apt-get update
  apt-get install -y --no-install-recommends $apt
  rm -rf /var/lib/apt/lists/*
fi

if [ -n "$(echo $npm)" ]; then
  echo "Add-ons from npm:$npm"
  npm install -g $npm
  npm cache clean --force
fi

# The image is the only Python here, so installing into the system Python
# (which Debian guards against by default) is what's wanted: every session
# can import these and run their commands.
if [ -n "$(echo $pip)" ]; then
  echo "Add-ons from pip:$pip"
  pip3 install --no-cache-dir --break-system-packages $pip
fi
