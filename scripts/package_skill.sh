#!/bin/sh
# Build dist-skill/studio.zip for upload to claude.ai. The top level of the zip is the skill folder.
set -eu

root="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$root"

rm -rf dist-skill
mkdir -p dist-skill/stage
cp -R skills/studio dist-skill/stage/studio
# The skill folder's LICENSE points to the repository's; the zip carries the full notice itself.
cp LICENSE dist-skill/stage/studio/LICENSE
(cd dist-skill/stage && zip -q -r -X ../studio.zip studio -x '*.DS_Store')
rm -rf dist-skill/stage
echo "dist-skill/studio.zip"
