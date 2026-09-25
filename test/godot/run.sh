#!/usr/bin/env bash
# Real-Godot check of src/tty/godot.ts: builds the CLI, writes spritesheet
# fixtures + SpriteFrames .tres files with the compiled module, imports them
# into this Godot project and loads them with validate.gd.
#
# Usage: GODOT=/path/to/godot test/godot/run.sh   (default: `godot` on PATH)
# Needs node_modules (npm ci) for the TypeScript build; does not use npm.
#
# Godot quirk: a PNG is only loadable as a Texture2D after an import pass
# (.godot/imported/*.ctex). `--headless --import` (Godot >= 4.2) runs that pass
# and exits. The run fails on any ERROR/WARNING line Godot prints, so a .tres
# Godot merely tolerates (e.g. missing uid warnings) still fails the check.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
godot="${GODOT:-godot}"

"$godot" --version
"$repo/node_modules/.bin/tsc" -p "$repo/tsconfig.json"
node "$here/generate.mjs"

rm -rf "$here/.godot"
log="$(mktemp)"
all="$(mktemp)"
trap 'rm -f "$log" "$all"' EXIT

status=0
"$godot" --headless --path "$here" --import >"$log" 2>&1 || status=$?
tee -a "$all" <"$log"
if [ "$status" -ne 0 ]; then echo "godot --import exited $status" >&2; exit 1; fi

status=0
"$godot" --headless --path "$here" --script res://validate.gd >"$log" 2>&1 || status=$?
tee -a "$all" <"$log"
if [ "$status" -ne 0 ]; then echo "validate.gd exited $status" >&2; exit 1; fi

if grep -Eq '(^|[^A-Z_])(ERROR|WARNING|SCRIPT ERROR)[: ]' "$all"; then
  echo "Godot printed errors or warnings while importing or loading the fixtures" >&2
  exit 1
fi
grep -q "ALL .* CASES PASSED" "$log"
echo "Godot validation passed"
