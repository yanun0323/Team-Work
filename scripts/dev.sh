#!/bin/sh
# Run the backend and the frontend together until Ctrl+C, or until either one stops.
set -eu

bin_dir=$(mktemp -d)
backend=""
frontend=""

stop() {
	trap - EXIT INT TERM
	# background jobs of a script ignore Ctrl+C, so each one is told to stop, then given time to save
	for pid in $backend $frontend; do
		kill "$pid" 2>/dev/null || true
	done
	wait 2>/dev/null || true
	rm -rf "$bin_dir"
}
trap stop EXIT
# Ctrl+C is the normal way to stop, not a failure
trap 'exit 0' INT
trap 'exit 143' TERM

# built first: the server stops with the signal, while `go run` could leave it running
(cd backend && go build -o "$bin_dir/server" ./cmd/server)
"$bin_dir/server" &
backend=$!
frontend/node_modules/.bin/vite --config frontend/vite.config.ts frontend &
frontend=$!

while kill -0 "$backend" 2>/dev/null && kill -0 "$frontend" 2>/dev/null; do
	sleep 1
done
echo "make dev: the backend or the frontend stopped; stopping the other one" >&2
exit 1
