#!/bin/sh
# Build dist-skill/studio.zip for upload to claude.ai. The top level of the zip is the skill folder.
set -eu

root="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$root"

rm -rf dist-skill
mkdir -p dist-skill
(cd skills && zip -q -r -X ../dist-skill/studio.zip studio -x '*.DS_Store')
echo "dist-skill/studio.zip"
