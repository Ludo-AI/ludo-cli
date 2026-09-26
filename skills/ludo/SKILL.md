---
name: ludo
description: Generate game assets with the Ludo AI `ludo` CLI - sprites, spritesheet animations, images, background removal, 3D models (rigging, animation), video, sound effects, music and voices. Use when the user asks for game art, sprites, animations, 3D models, or game audio, or mentions Ludo.
---

# Ludo AI CLI

Use the `ludo` command (install: `npm install -g @ludoai/cli`, or prefix commands with `npx @ludoai/cli`).
It needs a prior `ludo login` or an API key in `LUDO_API_KEY`. If a command exits with code 3, do not
ask for a key in the chat: ask the user to run `! ludo login` themselves. It opens their browser, where
they log in or create an account (and pick a plan with API access if needed) and approve the CLI.

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
   means the job failed and its credits were refunded. Before a large batch, check the balance with
   `ludo account`, and the price with `--dry-run`. Cap a command with `--max-credits <n>`.
   Exit code 11 means the spending budget is reached: stop, tell the user (`ludo spend`), and ask.
6. Exit code 5 means not enough credits, or a plan without API access. Do not retry: tell the user, and
   that `! ludo billing` opens the page to buy credits, change plan or turn on auto top-up.
7. Before generating, check `ludo assets`: the asset may already exist. `ludo assets redo <file>
   --prompt "..."` remakes one with changes.
8. To choose between options, `--n 3` makes three variations (`-v1`..`-v3`). Look at them, keep the
   best and delete the others. For several different assets, write a jobs file and run
   `ludo batch jobs.json` (`ludo batch --help`).
9. If the project has no `.ludo.json` yet and the user wants a setup, `ludo init` creates one.
10. When you hit a limitation you cannot work around, a bug, or something the user needed that Ludo
   cannot do, send one short report and tell the user you did:
   `ludo feedback "<what you tried, what happened, what would have helped>" --category limitation`
   (or `bug`, `feature_request`, `praise`, `other`; add `--operation` and `--job <id>` when they
   apply). It is free but capped at a few a day, so one report per issue, and never include secrets,
   personal data or file contents.

## Examples

```sh
ludo image create --prompt "a knight with a red cape, side view" --image-type sprite --out assets/sprites
ludo sprite animate --initial-image assets/sprites/knight.png --motion-prompt "walk cycle" --out assets/anim
ludo image remove-background --image photo.jpg
ludo audio sound-effect --description "coin pickup chime"
```
