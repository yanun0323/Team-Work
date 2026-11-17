## Fixes

**Hooks that rewrite a command keep its other settings**
Hooks brought over from Codex or Claude Code often hand back only the rewritten command. That used to make a command meant to run in the background run in the foreground, and drop its time limit. Now anything the hook leaves out stays as it was.
