#!/usr/bin/env bash
# Refreshes the copy of the official source the tests and the simulator read
# (backend/internal/usecase/testdata/official) from the newest version of its repo, or from REF when given. The app
# itself has no copy: it downloads the source like any other.
set -euo pipefail
cd "$(dirname "$0")/.."

repo=https://github.com/yanun0323/Team-Work-Source.git
dest=backend/internal/usecase/testdata/official
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

git clone --quiet ${REF:+--branch "$REF"} --depth 1 -- "$repo" "$tmp/source"
rm -rf "$dest/blueprints" "$dest/workflows"
mkdir -p "$dest"
for dir in blueprints workflows; do
	if [ -d "$tmp/source/$dir" ]; then cp -R "$tmp/source/$dir" "$dest/"; fi
done
git -C "$tmp/source" rev-parse HEAD >"$dest/commit"
echo "official source at $(cat "$dest/commit")"
