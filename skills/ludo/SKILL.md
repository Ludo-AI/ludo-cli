---
name: ludo
description: Generate game assets with the Ludo AI `ludo` CLI - sprites, spritesheet animations, images, background removal, 3D models (rigging, animation), video, sound effects, music and voices. Use when the user asks for game art, sprites, animations, 3D models, or game audio, or mentions Ludo.
---

# Ludo AI CLI

Use the `ludo` command (install: `npm install -g @ludoai/cli`, or prefix commands with `npx @ludoai/cli`).
It needs an API key in `LUDO_API_KEY` or a prior `ludo login`; if a command exits with code 3, ask the
user for their key from https://app.ludo.ai.

## Workflow

1. Run `ludo agent-help` once for the full guide, and `ludo <group> <command> --help` before using a
   command: it lists every flag, allowed values, defaults and the credit cost.
2. For a feature you have not used before, check Ludo's guidance first:
   `ludo docs search --query "<plain-language question>"`.
3. Pass local files by path (`--image ./knight.png`). Never base64-encode files.
4. Generations wait for the result and save files under `./ludo-output` (or `--out <dir>`). Read the
   JSON on stdout: `files[].path` are the saved files. Result URLs expire after 7 days, so use the
   saved files, not the URLs, in the user's project.
5. Every generation costs credits. Do not loop on generations or retry failures blindly; exit code 6
   means the job failed and its credits were refunded, 5 means not enough credits.

## Examples

```sh
ludo image create --prompt "a knight with a red cape, side view" --image-type sprite --out assets/sprites
ludo sprite animate --initial-image assets/sprites/knight.png --motion-prompt "walk cycle" --out assets/anim
ludo image remove-background --image photo.jpg
ludo audio sound-effect --description "coin pickup chime"
```
