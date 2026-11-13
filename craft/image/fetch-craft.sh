#!/bin/sh
# Download, verify and unpack every Craft CLI in craft.lock for one architecture.
# Usage: fetch-craft.sh <aarch64|x86_64> <lock file> <dest dir>
set -eu
arch="$1"; lock="$2"; dest="$3"
mkdir -p "$dest"
grep -v '^#' "$lock" | while read -r app ver a sha; do
  [ -n "$app" ] && [ "$a" = "$arch" ] || continue
  tgz="$app-$ver-linux-$arch.tar.gz"
  echo "fetch $tgz"
  curl -fsSL --retry 3 -o "/tmp/$tgz" "https://github.com/storytold/$app/releases/download/v$ver/$tgz"
  echo "$sha  /tmp/$tgz" | sha256sum -c -
  mkdir -p "$dest/$app"
  tar -xzf "/tmp/$tgz" -C "$dest/$app" --strip-components=1
  rm "/tmp/$tgz" "$dest/$app/bin/$app"   # headless image: keep the CLI, drop the desktop app
  "$dest/$app/bin/$app-cli" --version
done
