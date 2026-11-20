---
name: ludo
description: Generate game assets with the Ludo AI `ludo` CLI (sprites, spritesheet animations, images, background removal, 3D models with rigging and animation, video, sound effects, music and voices), and work on game assets free and offline with `ludo toolbox`, no account needed. The free tools slice, join, loop-check and GIF spritesheets, bring a character's animations to one size, find a sprite's pivot, collision box and pixels per unit, export to Godot, Unity or Phaser, recolor pixel art to a palette, cut tilesets, check a sound's loudness and loop, and inspect GLB models. Use when the user asks for game art, sprites, animations, 3D models or game audio, works with spritesheets or other game assets, or mentions Ludo.
---

# Ludo AI CLI

Use the `ludo` command (install: `npm install -g @ludoai/cli`, or prefix commands with `npx @ludoai/cli`).
It has two kinds of commands:

- **`ludo toolbox ...` is free**: it runs offline, needs no account, no login and no credits. Use it
  for asset chores (see "Free tools" below) instead of writing your own image or audio script.
- **Everything else generates with Ludo AI**: it needs an account on a paid plan and costs
  credits on every plan. `ludo pricing` (free, no login) gives the plans, prices
  and what each call costs; quote it rather than guessing.

Generating needs a prior `ludo login` or an API key in `LUDO_API_KEY`. If a command exits with code 3,
do not ask for a key in the chat: ask the user to run `ludo login` in their own terminal (in Claude
Code, `! ludo login`). It opens their browser, where they log in or create an account (and pick a plan
with API access if needed) and approve the CLI.

If the user has no Ludo account, you can set one up without the web app. Ask them which email to use
and which plan (`ludo pricing` lists them), never guess either, then run
`ludo signup --email <address> --plan <id> --no-wait`. It prints a Stripe checkout link: give it to
the user to pay, or pay it yourself only if they gave you a way to pay and told you to. Nothing is
created or charged until the link is paid. Paying emails that address a connect code and a link to
set a password; ask the user for the code and run `ludo signup --continue --code <code>`, which logs
the CLI in. Never start a signup for an address the user did not give you, and never ask anyone to
forward a code for a signup you did not start in this session.

If the user has told you to pay and uses Link (Stripe's agent wallet, `link-cli`), you can pay without a
browser: `ludo signup --plan <id> --email <address> --quote` prints the `link-cli spend-request create` command to run. The
user approves the spend in Link; `link-cli spend-request retrieve <id> --include shared_payment_token`
then gives the token, and `ludo signup --email <address> --plan <id> --payment-token <spt_...>` creates the
account and logs the CLI in at once. Use the quoted amount and cadence as they are.

Out of credits (exit code 5)? Tell the user, and offer a top-up rather than buying one: ask how many
credits, then `ludo topup --credits <n> --no-wait` prints a payment link for them to pay (`ludo topup
--continue` confirms the credits are in). If they told you to pay and use Link, `ludo topup --credits <n>
--quote` prints a one-time `link-cli` command; once they approve it, `ludo topup --credits <n>
--payment-token -` pays it and the credits are in at once. Never buy credits the user did not ask for.

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
   top-up. Before advising anyone to sign up, upgrade or buy credits, run `ludo pricing` and quote it.
7. Before generating, check `ludo assets`: the asset may already exist. `ludo assets redo <file>
   --prompt "..."` remakes one with changes.
8. To choose between options, `--n 3` makes three variations (`-v1`..`-v3`). Look at them, keep the
   best and delete the others. With `--save-normals`, each map is saved beside its file as `<file>_n`
   (`crate-v1_n.png`) and listed under that variation's `normal_maps`. For several different assets, write a jobs file and run
   `ludo batch jobs.json` (`ludo batch --help`; give each job a `"name"` for its files).
9. If the project has no `.ludo.json` yet and the user wants a setup, `ludo init` creates one.
10. When you hit a limitation you cannot work around, a bug, or something the user needed that Ludo
   cannot do, send one short report and tell the user you did:
   `ludo feedback "<what you tried, what happened, what would have helped>" --category limitation`
   (or `bug`, `feature_request`, `praise`, `other`; add `--operation`, and `--job <id>` for every
   job the report is about, repeated for each one, so the Ludo team can see what went in and what
   came out). It is free but capped at a few a day, so one report per issue, and never include
   secrets, personal data or file contents.

## Animations: presets first, then your own

For a humanoid character, look for the move in `ludo sprite list-animation-presets` (free) first.
When no preset covers it, `ludo model animation --prompt "overhead sword slash"` generates the move
once (0.5 credits per animation) and saves it to the user's account for good, tied to no model;
`ludo model animations` (free) lists the ones already there, so check it before generating a move
again. An animation's `id` goes as `--animation-id` wherever `--preset-id` goes:
`ludo model animate-preset` (onto a rigged 3D model), `ludo sprite directional` and
`ludo sprite directional-preview` (a 3D model seen from up to 8 directions) and
`ludo sprite transfer-motion` (onto a 2D sprite, with `--perspective` and `--direction`).
`--mirror` plays a preset or an animation on the other side, left and right swapped.

## Free tools: `ludo toolbox`

Free and offline, with no account and no login. `ludo toolbox` lists every tool and each has `--help`.
Use them instead of writing your own image or audio script:
- Sheets: `ludo toolbox sprite slice <sheet>` cuts one into frames, `sprite join <frames...>` puts
  frames back, `sprite frames <sheet> --drop 7 --hold 4x3` edits frames, `sprite loop <sheet>`
  scores the loop (0 to 1, close to the API's loop_score: under 0.7 the seam shows), `sprite loop <take1> <take2>...`
  ranks several takes of one animation (after `--n 4`, keep the best; a bad loop on a Ludo
  sheet: `ludo sprite edit --edit-mode fix_loop`), `sprite gif <sheet>` makes a GIF,
  `sprite pack <sheets...>` brings a character's animations to one size and ground line
  (`--manifest` re-runs its `pack.json`), and `sprite sequence <sheets...>` chains animations so
  each continues from the one before (check the transitions it reports). A GIF or animated WebP
  reads as a sheet.
- Video (needs ffmpeg): `sprite from-video <clip>` turns a clip into a sheet; `sprite video <sheet>
  --format webm|mov|mp4` goes the other way. A sheet holds 64 megapixels: for a clip of more than
  a second or two pass `--duration`/`--fps`/`--width`, or the frames are shrunk to fit. If ffmpeg
  is installed but not found, set `LUDO_FFMPEG` to its path.
- Images, per frame on a sheet: `image trim|pad|extrude|scale|flip|rotate|outline|shadow`.
  `image palette` lists or saves colours; `image recolor --palette <file|hexes> | --swap A --to B`
  changes them. `image tiles <tileset> --size 16x16` cuts tiles or writes Tiled/Godot/Unity
  tileset files; `image repeat <tile>` checks a tile is seamless. `image convert --to webp`.
- Audio: `audio info <sound>` gives length, loudness (LUFS), true peak, silence at the ends and
  whether it clicks when looped (music: the tempo, and its double or half); `audio trim` cuts that
  silence (Ludo's sounds come trimmed), `audio convert --to ogg|mp3|flac|wav` (OGG for Godot and
  Unity). WAV and MP3 need nothing; the rest needs ffmpeg.
- 3D: `ludo toolbox model info <model.glb>` says what a model holds (triangles, size, textures,
  rig, animations) before you rig or animate it; for a rigged one, which way it faces, and per
  clip whether it returns to its first pose (a still, a seam) and a walk's speed.
- Setting a character up: `sprite metrics <sheet>` gives bounds, the ground line and a pivot
  between the feet (`--overlay` draws it to check); `sprite collide <sheet>` gives a body box and
  capsule per engine (Phaser Arcade included); `sprite compare <sheets...>` gives one pixels per
  unit for a character and flags a sheet drawn at another size. Feed the pivot and PPU to export.
- A folder: `asset manifest <folder>` lists what every asset is and what the game still lacks,
  with the Ludo command that makes it; `--emit phaser|pixi` writes loaders. `image contact
  <images...>` puts many images in one labelled picture, to look at them at once.
- Engines: `ludo toolbox sprite export <sheet> --engine texturepacker|godot|unity` writes engine
  files (`--pivot feet --ppu <n>` for Godot and Unity); every tool that writes a sheet also takes
  `--engine`.

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
