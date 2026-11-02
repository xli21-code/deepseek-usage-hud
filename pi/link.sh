#!/bin/sh
# Link this checkout's pi extension into pi's user extension directory.
#
# Two links, not one: pi resolves relative imports from the extension's symlink
# path, so `import "./deepseek-hud-lib/…"` needs that directory linked next to it
# as well. Idempotent; safe to re-run after moving or re-cloning the checkout.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/.." && pwd)
agent_dir="${PI_AGENT_DIR:-$HOME/.pi/agent}"
dest="$agent_dir/extensions"

mkdir -p "$dest"
ln -sfn "$repo/pi/extensions/deepseek-hud.ts" "$dest/deepseek-hud.ts"
ln -sfn "$repo/pi/extensions/deepseek-hud-lib" "$dest/deepseek-hud-lib"

printf 'linked into %s\n' "$dest"
printf '  deepseek-hud.ts      -> %s\n' "$repo/pi/extensions/deepseek-hud.ts"
printf '  deepseek-hud-lib/    -> %s\n' "$repo/pi/extensions/deepseek-hud-lib"
printf '\nstart a new pi session to load it; /ds opens the report\n'
