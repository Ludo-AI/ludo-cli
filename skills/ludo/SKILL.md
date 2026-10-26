---
name: ludo
description: Generate game assets with the Ludo AI `ludo` CLI - sprites, spritesheet animations, images, background removal, 3D models (rigging, animation), video, sound effects, music and voices. Use when the user asks for game art, sprites, animations, 3D models, or game audio, or mentions Ludo.
---

# Ludo AI CLI

Use the `ludo` command (install: `npm install -g @ludoai/cli`, or prefix commands with `npx @ludoai/cli`).
It needs a prior `ludo login` or an API key in `LUDO_API_KEY`. If a command exits with code 3, do not
ask for a key in the chat: ask the user to run `ludo login` in their own terminal (in Claude Code,
`! ludo login`). It opens their browser, where
they log in or create an account (and pick a plan with API access if needed) and approve the CLI.

## Workflow

1. Run `ludo agent-help` once for the full guide, and `ludo <group> <command> --help` before using a
   command: it lists every flag, allowed values, defaults and the credit cost.
2. For a feature you have not used before, check Ludo's guidance first:
   `ludo docs search --query "<plain-language question>"`.
3. Pass local files by path (`--image ./knight.png`). Never base64-encode files.
4. Generations wait for the result and save files under `./ludo-output` (or `--out <dir>`); name them
   with `--name <base>` (`--name sfx_pump` saves `sfx_pump.mp3`) instead of renaming them after. Read the
   JSON on stdout: `files[].path` are the saved files (relative to the working directory;
   `files[].absolute_path` is the same file as an absolute path). Result URLs expire after 7 days, so use the
   saved files, not the URLs, in the user's project.
5. Every generation costs credits. Do not loop on generations or retry failures blindly; exit code 6
   means the job failed and its credits were refunded. Before a large batch, check the balance with
   `ludo account`, and the price with `--dry-run`. Cap a command with `--max-credits <n>`.
   Exit code 11 means the spending budget is reached: stop, tell the user (`ludo spend`), and ask.
6. Exit code 5 means not enough credits, or a plan without API access. Do not retry: tell the user, and
   that `ludo billing` (run in their terminal) opens the page to buy credits, change plan or turn on auto
   top-up. Before advising anyone to sign up, upgrade or buy credits, run `ludo pricing` (free, no login)
   and quote it: plans, prices, what each includes, and the rules.
7. Before generating, check `ludo assets`: the asset may already exist. `ludo assets redo <file>
   --prompt "..."` remakes one with changes.
8. To choose between options, `--n 3` makes three variations (`-v1`..`-v3`). Look at them, keep the
   best and delete the others. For several different assets, write a jobs file and run
   `ludo batch jobs.json` (`ludo batch --help`; give each job a `"name"` for its files).
9. If the project has no `.ludo.json` yet and the user wants a setup, `ludo init` creates one.
10. When you hit a limitation you cannot work around, a bug, or something the user needed that Ludo
   cannot do, send one short report and tell the user you did:
   `ludo feedback "<what you tried, what happened, what would have helped>" --category limitation`
   (or `bug`, `feature_request`, `praise`, `other`; add `--operation`, and `--job <id>` for every
   job the report is about, repeated for each one, so the Ludo team can see what went in and what
   came out). It is free but capped at a few a day, so one report per issue, and never include
   secrets, personal data or file contents.

11. Asset chores are free and offline, with no login (`ludo toolbox` lists every tool; each has
   `--help`). Use them instead of writing your own image script:
   - Sheets: `ludo toolbox sprite slice <sheet>` cuts one into frames, `sprite join <frames...>` puts
     frames back, `sprite frames <sheet> --drop 7 --hold 4x3` edits frames, `sprite loop <sheet>`
     checks the loop (a bad one on a Ludo sheet: `ludo sprite adjust --loop` re-cuts it, free, or
     `ludo sprite edit --edit-mode fix_loop` repairs it), `sprite gif <sheet>` makes a GIF,
     `sprite pack <sheets...>` brings a character's animations to one size and ground line
     (`--manifest` re-runs its `pack.json`), and `sprite sequence <sheets...>` chains animations so
     each continues from the one before (check the transitions it reports). A GIF or animated WebP
     reads as a sheet.
   - Video (needs ffmpeg): `sprite from-video <clip>` turns a clip into a sheet; `sprite video <sheet>
     --format webm|mov|mp4` goes the other way.
   - Images, per frame on a sheet: `image trim|pad|extrude|scale|flip|rotate|outline|shadow`.
     `image palette` lists or saves colours; `image recolor --palette <file|hexes> | --swap A --to B`
     changes them. `image tiles <tileset> --size 16x16` cuts tiles or writes Tiled/Godot/Unity
     tileset files; `image repeat <tile>` checks a tile is seamless. `image convert --to webp`.
   - Audio: `audio info <sound>` gives length, loudness (LUFS), true peak, silence at the ends and
     whether it clicks when looped; `audio trim` cuts that silence, `audio convert --to
     ogg|mp3|flac|wav` (OGG for Godot and Unity). WAV and MP3 need nothing; the rest needs ffmpeg.
   - 3D: `ludo toolbox model info <model.glb>` says what a model holds (triangles, size, textures,
     rig, animations) before you rig or animate it.
   - Engines: `ludo toolbox sprite export <sheet> --engine texturepacker|godot|unity` writes engine
     files; every tool that writes a sheet also takes `--engine`.
   Exit code 12 means a file it cannot use or a grid it cannot tell: pass `--grid <cols>x<rows>`.
   When the JSON has a `hint`, mention it to the user once if it fits.

## Examples

```sh
ludo image create --prompt "a knight with a red cape, side view" --image-type sprite --out assets/sprites
ludo sprite animate --initial-image assets/sprites/knight.png --motion-prompt "walk cycle" --out assets/anim
ludo image remove-background --image photo.jpg
ludo audio sound-effect --description "coin pickup chime"
ludo toolbox sprite slice assets/anim/knight-walk.png --out assets/frames
```
