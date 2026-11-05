#!/usr/bin/env bash
# Retakes the help page's screenshots: builds the frontend on mock data, serves it, and runs help-shots.mjs on it.
# Playwright and its headless Chromium live in ~/.cache/team-work-shots, outside the project, and are fetched on first use.
# Topic names given as arguments retake only those.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
tools="${SHOTS_TOOLS:-$HOME/.cache/team-work-shots}"
port=5199

if [ ! -d "$tools/node_modules/playwright-core" ]; then
  mkdir -p "$tools"
  [ -f "$tools/package.json" ] || echo '{"private":true}' > "$tools/package.json"
  npm --prefix "$tools" install --no-audit --no-fund playwright-core@1.64.1
fi
"$tools/node_modules/.bin/playwright-core" install chromium-headless-shell >/dev/null

site="$(mktemp -d)"
trap 'kill "${server:-}" 2>/dev/null || true; rm -rf "$site"' EXIT
(cd "$root/frontend" && npx vite build --mode mock --outDir "$site" --emptyOutDir >/dev/null)
(cd "$root/frontend" && exec npx vite preview --outDir "$site" --port "$port" --strictPort >/dev/null) &
server=$!
for _ in $(seq 50); do curl -sf "http://localhost:$port/" >/dev/null && break; sleep 0.2; done

SHOTS_TOOLS="$tools" node "$root/scripts/help-shots.mjs" "http://localhost:$port/" "$@"
