#!/usr/bin/env bash
# Looks for traces of Team Work in a project it handled: who git says wrote each commit, what the messages name, and
# whether any tracked file carries the app's own strings. Run it on a company's folder before publishing it.
#
#   make trace-check FOLDER=~/code/my-project NAMES="Sushi 通才,Ada"
#
# NAMES is the company's employee names, as the app knows them, separated by commas; a name may hold spaces and is
# matched as plain text, whole. Git history is where they used to leak.
set -euo pipefail
folder=${FOLDER:-}
[ -n "$folder" ] || { echo "usage: make trace-check FOLDER=<project folder> [NAMES=\"name,name\"]"; exit 2; }

names_file=$(mktemp)
trap 'rm -f "$names_file"' EXIT
printf '%s\n' "${NAMES:-}" | tr ',' '\n' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' | { grep -v '^$' || true; } >"$names_file"

found=0
say() { printf '%s\n' "  $*"; found=1; }
# matches prints the lines of its input that carry what $1 matches (a regex) or any of the names (plain text). It reads
# all of its input first: a grep that quits early would kill git with SIGPIPE, and pipefail would read that as no match.
matches() {
	local text
	text=$(cat)
	{
		printf '%s\n' "$text" | grep -iE "$1" || true
		if [ -s "$names_file" ]; then printf '%s\n' "$text" | grep -iF -f "$names_file" || true; fi
	} | sort -u
}

echo "checking $folder"
if ! git -C "$folder" rev-parse -q --verify HEAD >/dev/null; then
	echo "no commits yet"
	exit 0
fi

# commits: whose they are. An employee's name, or any address of the app's, must not be there.
identities=$(git -C "$folder" log --format='%an <%ae>|%cn <%ce>' | sort -u)
if bad=$(printf '%s\n' "$identities" | matches "mho-company|team work") && [ -n "$bad" ]; then
	say "a commit is someone else's, not the user's:"
	printf '%s\n' "$bad" | sed 's/^/    /'
fi

# commits: what the messages name. The app's own tool names, or a branch of its own in a merge. Words such as
# "blueprint" or "work tree" are left out: plenty of projects use them for things of their own.
messages=$(git -C "$folder" log --format='%h %s%n%b')
if words=$(printf '%s\n' "$messages" | { grep -iE "submit_handoff|send_back|handoff from" || true; }) && [ -n "$words" ]; then
	say "a commit message talks about the app's own workings:"
	printf '%s\n' "$words" | sed 's/^/    /'
fi
merges=$(git -C "$folder" log --merges --format='%h %s')
if task=$(printf '%s\n' "$merges" | { grep -E "task/[0-9]+" || true; }) && [ -n "$task" ]; then
	say "a merge names a branch of the app's own:"
	printf '%s\n' "$task" | sed 's/^/    /'
fi

# tracked files: the app's own strings, and the employee names it was given
hits=$(git -C "$folder" grep -lIi -e 'mho-company\.local' HEAD || true)
if [ -s "$names_file" ]; then
	hits=$(printf '%s\n%s\n' "$hits" "$(git -C "$folder" grep -lIiF -f "$names_file" HEAD || true)" | { grep -v '^$' || true; } | sort -u)
fi
if [ -n "$hits" ]; then
	say "a tracked file carries a name or address of the app:"
	printf '%s\n' "$hits" | sed 's/^/    /'
fi

if [ "$found" = 0 ]; then
	echo "no traces found"
else
	exit 1
fi
