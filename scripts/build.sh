#!/usr/bin/env bash
# Build the release files into dist/: the plugin (.xpi), the skill (.zip) and SHA256SUMS.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(python3 -c "import json;print(json.load(open('plugin/manifest.json'))['version'])")
mkdir -p dist
rm -f dist/review-with-claude-*.xpi dist/paper-review-skill.zip dist/SHA256SUMS
(cd plugin && zip -qr "../dist/review-with-claude-${VERSION}.xpi" manifest.json bootstrap.js prefs.js prefs.xhtml prefs-pane.js icon.svg lib locale content -x '*.DS_Store')
(cd skill && zip -qr ../dist/paper-review-skill.zip paper-review -x '*__pycache__*' -x '*.DS_Store' -x '*.pyc')
(cd dist && shasum -a 256 review-with-claude-${VERSION}.xpi paper-review-skill.zip > SHA256SUMS)
echo "Built version ${VERSION}:"; ls -l dist
