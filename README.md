# ludo: the Ludo AI command line

Generate game assets with [Ludo AI](https://ludo.ai) from your terminal or from a coding agent:
sprites and spritesheet animations, images, 3D models (with rigging and animation), video, sound
effects, music and voices.

```sh
npm install -g @ludoai/cli      # or run without installing: npx @ludoai/cli ...
ludo login                      # log in with your browser (you can create an account there)
ludo image create --prompt "a knight with a red cape" --image-type sprite
```

## Why a CLI

- **Local files just work.** Pass a path to any image, audio, video or model flag and the CLI
  uploads it for you. No base64, no hosting.
- **Results land on disk.** Generations wait for the job to finish and save every result file to
  `./ludo-output` (or `--out <dir>`), named after the operation and job (or `--name sfx_pump` for
  `sfx_pump.mp3`; nothing is ever overwritten). Result URLs expire after 7 days; the files do not.
- **Always current.** Commands, flags, enums, defaults and prices are built from the live API spec,
  so new models and features show up without updating the CLI.
- **Cheap for agents.** An agent learns only the commands it needs, through `--help`, instead of
  loading every tool schema up front.

## Usage

```
ludo <group> <command> [flags]
ludo <group> <command> --help
```

| Group | Commands |
|---|---|
| `image` | `create`, `generate-with-style`, `edit`, `remove-background` |
| `sprite` | `animate`, `animate-keyframes`, `generate-pose`, `rotate`, `transfer-motion`, `list-animation-presets`, `edit`, `create-audio` |
| `video` | `create`, `create-from-references`, `edit`, `upscale` |
| `model` | `create`, `rig`, `animate`, `animate-preset` |
| `audio` | `sound-effect`, `ambiance`, `music`, `transform`, `voice`, `speech`, `speech-preset` |
| `jobs` | `list`, `get`, `cancel`, `wait` |
| `generations` | `list` |
| `docs` | `search`, `get` |
| `account` | `show` (also just `ludo account`): credits, plan and auto top-up |

The table is a snapshot: `ludo --help` always shows the current list. Every command also answers to
its API operation id (`ludo createImage ...`), the same names the API docs and the MCP server use.

### Examples

```sh
# Animate a sprite from a local file; the spritesheet, video and frames are saved to ./sprites
ludo sprite animate --initial-image knight.png --motion-prompt "walk cycle" --out sprites

# Cut out a background
ludo image remove-background --image photo.jpg

# Image to 3D, then rig it
ludo model create --image chest.png
ludo model rig --model ludo-output/create3DModel-1a2b3c4d.glb

# Music
ludo audio music --description "calm piano melody for a title screen" --duration 30

# Ask Ludo's docs before using a feature
ludo docs search --query "which animation model should I use for pixel art?"
```

### Flags

- API fields become kebab-case flags: `image_type` is `--image-type`. Booleans are switches
  (`--crop`, `--no-crop`). Array fields repeat (`--images a.png --images b.png`).
- `--input body.json` (or `--input -` for stdin) supplies the whole request body; flags override it.
- `--no-wait` submits the job and prints `{id, status}`; `ludo jobs wait <id>` picks it up later.
- `--json` prints JSON even on a terminal. It is the default when stdout is not a terminal.
- `--timeout <s>` stops waiting (the job keeps running), `--quiet` silences progress on stderr.
- `--open` opens the result in its default app (Aseprite, say), `--play` plays generated audio,
  `--copy` puts the saved file paths on the clipboard.
- WebP results are also saved as PNG, side by side (engines and most tools want PNG).
- `--engine godot` also writes a Godot 4 `SpriteFrames` resource (`.tres`) next to a spritesheet:
  drop it on an `AnimatedSprite2D`. Inside a Godot project it uses a `res://` path.
- `--engine texturepacker` writes a TexturePacker JSON atlas (`.json`) next to a spritesheet, with
  the animation named after the file. PixiJS: `const sheet = await Assets.load("knight-walk.json")`,
  then `new AnimatedSprite(sheet.animations["knight-walk"])`. Phaser:
  `this.load.aseprite("knight", "knight-walk.png", "knight-walk.json")`, then
  `this.anims.createFromAseprite("knight")` (`load.atlas` gives the frames alone).
- `--engine unity` writes the sheet's `.png.meta`, which imports it sliced into one sprite per
  frame, and an `.anim` clip that plays them on a `SpriteRenderer`. Export into your project's
  `Assets/` folder (or copy the PNG, `.meta` and `.anim` there together). A `.meta` already there
  keeps its guid, so scenes and prefabs that use the sprites still find them.

### In the terminal

At a terminal, results show up right there, spritesheets as a looping animation. Terminals that
draw real images (iTerm2, Kitty, Ghostty, WezTerm) show the actual picture. Elsewhere (including
inside tmux) the preview is skipped with a note, and `--open` opens the result full size instead.
`ludo preview <file>` shows any saved image again (Ludo spritesheets remember their grid; for
other sheets pass `--grid 8x4 --fps 12`). A spinner shows the job's
status while you wait, and each result suggests a next step.

None of this reaches scripts or AI agents: it is drawn on stderr and only when both outputs are a
terminal. `--plain`, `NO_COLOR` or `LUDO_PREVIEW=0` turn it off.

### Output

In JSON mode a generation prints:

```json
{
  "job_id": "…",
  "status": "succeeded",
  "task_type": "animateSprite",
  "credits_charged": 9,
  "result": { "spritesheet_url": "https://…", "video_url": "https://…" },
  "files": [{ "url": "https://…", "path": "ludo-output/animateSprite-1a2b3c4d-1.png", "absolute_path": "/home/you/game/ludo-output/animateSprite-1a2b3c4d-1.png" }]
}
```

Inline base64 in a result (such as a spritesheet's generated sound effect) is saved to a file and
replaced by its path.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Error (network, server) |
| 2 | Bad usage (unknown command, missing or invalid flag, file not found) |
| 3 | Missing or rejected API key |
| 4 | Request rejected by the API |
| 5 | Not enough credits |
| 6 | Generation failed (credits refunded) |
| 7 | Generation canceled |
| 8 | Rate limited, or too many jobs queued |
| 9 | Timed out waiting; the job keeps running |
| 10 | This version of ludo is no longer supported; update it |
| 11 | Refused by the spending guard (`--max-credits` or the budget) |
| 12 | `ludo toolbox`: an input file it cannot read or use, or a detection it is not sure of |

## Free tools

`ludo toolbox` holds tools that run on your machine: offline, with no account, no API key and no
credits. They work on any spritesheet or sound, not only Ludo's.

```sh
# Cut a spritesheet into one PNG per frame. The grid comes from --grid, from the sheet's Ludo
# stamp, or is detected; when detection is not sure it stops and asks for --grid.
ludo toolbox sprite slice knight-walk.png

# Put frames back together into a sheet that remembers its grid (ludo preview plays it)
ludo toolbox sprite join ludo-output/knight-walk/ --cols 4 --fps 12

# Edit the frames of a sheet: drop frame 7, hold frame 4 for three frames, play as a ping-pong
ludo toolbox sprite frames knight-walk.png --drop 7 --hold 4x3 --pingpong

# How well it loops, 0 to 1: the seam from the last frame back to the first, against the clip's
# pace (0.8 and up is clean, under 0.5 a hitch you see). It only measures; Ludo's sheets come cut to
# their loop, and `ludo sprite edit --edit-mode fix_loop` repairs one that does not loop.
ludo toolbox sprite loop knight-walk.png
# Several takes of one animation (like --n 4): which loops cleanest, the cleanest first.
ludo toolbox sprite loop walk-1.png walk-2.png walk-3.png walk-4.png

# Image edits. On a sheet (its Ludo stamp, or --grid) every frame gets the same edit, so the
# frames stay aligned.
ludo toolbox image trim knight-walk.png             # cut the empty border, one box for all frames
ludo toolbox image pad trimmed.png --restore        # put back what trim cut
ludo toolbox image pad hero.png --to 128x128 --anchor bottom
ludo toolbox image extrude tiles.png --by 2 --grid 8x8
ludo toolbox image scale hero.png --by 4            # nearest neighbour; --by 1/4 scales down
ludo toolbox image scale hero.png --by 1.5 --filter lanczos   # any factor; Pillow's filters
ludo toolbox image flip knight-walk.png             # face the other way; --vertical for upside down
ludo toolbox image rotate hero.png --by 90
ludo toolbox image outline hero.png --color "#1a1c2c" # 1 px, no corners; --shape square, --width 2
ludo toolbox image shadow hero.png --offset 2,2 --opacity 40
ludo toolbox image convert hero.png --to webp       # lossless WebP

# Palettes: list and save one (.hex, .gpl, .pal, .txt, .png), map onto a Lospec palette or
# another sprite's colours, or swap colours (a red enemy becomes a blue one).
ludo toolbox image palette hero.png --save hero.gpl
ludo toolbox image recolor knight-walk.png --palette pico-8.hex
ludo toolbox image recolor slime.png --swap "#3fa34d,#2a6e33" --to "#3b6fd1,#24478a"

# Tilesets: one PNG per tile, or the files Tiled (--tiled), Godot and Unity read. repeat lays a
# tile out 3x3 and says whether its edges meet without a seam.
ludo toolbox image tiles terrain.png --size 16x16 --spacing 1 --tiled --engine godot
ludo toolbox image repeat grass.png

# An animated GIF for sharing: one palette for every frame (the sheet's own colours when it has
# 256 or fewer), 1-bit transparency (--alpha-threshold, --matte for soft edges), loops forever
# unless --once. --scale 4 enlarges small pixel art.
ludo toolbox sprite gif knight-walk.png --fps 12 --scale 4

# Several animations of one character at one size and ground line, in one frame size: the web
# app's Export Pack. Nudge one by file name, label or position; pack.json re-runs it exactly.
ludo toolbox sprite pack idle.png walk.png jump.png --name knight --engine texturepacker
ludo toolbox sprite pack --manifest ludo-output/knight/pack.json --size walk=1.1 --ground jump=3

# Animations played one after another, each placed so it continues from the last frame of the one
# before (the web's image matching, run locally; --align ground lines up the feet instead): the web app's Export Sequence.
# The output gives each transition's offset; sequence.json re-runs it, and you can edit them there.
ludo toolbox sprite sequence idle.png jump.png land.png --name knight-jump --frame-size 256x256
ludo toolbox sprite sequence idle.png jump.png --mode separate --engine godot

# A GIF or animated WebP reads as a sheet of its frames, so every sprite and image tool takes one.
ludo toolbox sprite slice dance.gif

# Video (needs ffmpeg): a clip to a sheet, and a sheet to WebM or MOV with transparency, or MP4.
ludo toolbox sprite from-video knight-walk.mp4 --fps 12
ludo toolbox sprite video knight-walk.png --format webm --loops 3

# Sound. WAV and MP3 are read in-process; OGG, FLAC and the rest, and writing OGG or MP3, need
# ffmpeg. Loudness is LUFS (ITU-R BS.1770).
ludo toolbox audio info zap.mp3                     # length, loudness, true peak, silence, loop seam; music: tempo
ludo toolbox audio trim zap.mp3                     # silence off both ends (Ludo's come trimmed)
ludo toolbox audio convert theme.mp3 --to ogg       # Ogg Vorbis for Godot and Unity; --mono, --bits

# What is in a 3D model: meshes, triangles, size, textures, skeleton and animations; for a rigged
# one which way it faces, and per clip whether it returns to its first pose and a walk's speed.
ludo toolbox model info knight.glb

# Setting a character up: where its feet and pivot are, its colliders, and one pixels per unit for
# all its sheets (and which sheet is drawn at another size). They only report.
ludo toolbox sprite metrics knight-walk.png --overlay   # bounds, ground line, feet pivot; a picture to check
ludo toolbox sprite collide knight-walk.png --ppu 280   # box and capsule for Godot, Unity, Phaser, Box2D
ludo toolbox sprite compare knight_*.png --reference knight_walk.png=1.8m
ludo toolbox image contact icons/*.png                  # one labelled picture of many images

# A folder at a glance: what each asset is, what the game still lacks (with the Ludo command that
# makes it) and loaders for Phaser or Pixi.
ludo toolbox asset manifest assets/ --emit phaser

# Engine files for a sheet you already have. Any toolbox tool that writes a sheet takes --engine
# too, and a trimmed or extruded sheet exports each frame's original size and offset.
ludo toolbox sprite export knight-walk.png --engine texturepacker
ludo toolbox sprite export knight-walk.png --engine godot
ludo toolbox sprite export knight-walk.png --engine unity --pivot feet --ppu 280
```

Files are saved under `./ludo-output` (or `--out <dir>`) and never overwrite anything.

## Projects

`ludo init` sets a folder up as a project. It writes `.ludo.json` and adds instructions for coding
agents (a section in `AGENTS.md`, a Cursor rule when `.cursor` exists, the Claude Code skill when the
project uses Claude Code). Every command run anywhere below that folder uses it:

```json
{
  "out": "assets/ludo",
  "engine": "godot",
  "max_credits": 100,
  "style_image": "art/style.png",
  "defaults": {
    "image create": { "image_type": "sprite" },
    "animateSprite": { "model": "forge" }
  }
}
```

- `out`: where generated files are saved (instead of `./ludo-output`).
- `engine`: as `--engine` on every command (`godot`, `texturepacker` or `unity`). `ludo init` picks
  `godot` in a Godot project, `unity` in a Unity project (and saves under `Assets/Ludo`), and
  `texturepacker` in one that depends on Phaser or PixiJS.
- `max_credits`: an optional spending budget (below). Not set by `ludo init`: without it there is no limit.
- `style_image`: used by operations that take a `style_image` (`image generate-with-style`).
- `defaults`: API fields per command, by `"group command"` or API id.

Paths are relative to `.ludo.json` and must stay inside the project (so a cloned repository
cannot point ludo at files elsewhere on your machine); paths you pass as flags are not limited.
Flags always win.

### Cost control

- `--dry-run` prints what a command would cost and runs nothing.
- `--max-credits <n>` refuses a command (all its variations together) that would cost more.
- The spending budget, `LUDO_MAX_CREDITS` or `max_credits`, caps what the CLI spends in a project
  (or on this machine, outside one). Past it every generation is refused with exit code 11.
  `ludo spend` shows the tally; `ludo spend reset` starts a new one.

Prices come from the API's published pricing. For models priced per second, the estimate is the
most the job can cost. A command whose price depends on its source file (a video upscale) is refused
while a limit is set, unless you pass `--force`.

### Asset log

Every file a generation saves is recorded in `ludo-assets.json` (next to `.ludo.json`, or in the
output folder): the command, its flags, the job and what it cost. `ludo assets` lists them;
`ludo assets redo <file> --prompt "…in blue"` makes one again with changes. Files saved by
`ludo jobs wait` are listed but can't be replayed, since the request that made them is unknown.
Inputs passed inline as base64 are kept once in `ludo-inputs/` beside the log (git-ignored), and
the log points to them.

### Variations and batches

- `--n 4` makes four variations of one request and saves them as `-v1` to `-v4` (with `--name`,
  `<name>-v1` to `<name>-v4`). At a terminal
  you then pick which to keep; the rest move to `<out>/.discarded/`. Where the API takes `n`
  (images) one job makes them; elsewhere the jobs run side by side.
- `ludo batch jobs.json` runs a list of different generations side by side (`ludo batch --help`
  shows the format; a job's `"name"` names its files). The price of the whole list is checked first.
  A failed item does not stop the others.
- Anything over 50 credits at once asks for confirmation at a terminal (`--yes` skips it).

## Staying up to date

The CLI tells you, at most once a day, when a newer version is out; `ludo update` installs it.
If a version ever stops being supported, commands exit with code 10 and say how to update.
Service notices from Ludo (an outage, say) appear the same way, on stderr.

## Logging in

`ludo login` prints a short code and opens `app.ludo.ai/cli` in your browser. Log in there (or create
an account, and pick a plan with API access if yours has none), check the code matches your terminal,
and click Authorize. The CLI gets a key of its own, so your main API key and any MCP setup keep
working. Each CLI login is listed under API & MCP in the web app, where you can revoke it; `ludo
logout` revokes it too.

On a machine without a browser, open the printed link on any device. For CI, set `LUDO_API_KEY`, or
save a key with `ludo login --with-key` (it reads the key from a prompt or stdin).

Keys are used in this order: `--api-key`, the `LUDO_API_KEY` environment variable, then the key saved
by `ludo login` (in `~/.config/ludo/config.json`, readable only by you).

## Credits

`ludo account` shows your balance, plan and auto top-up settings. `ludo billing` opens the page to
buy credits, change plan or set up auto top-up. `ludo pricing` (no login needed) lists the plans, what
each includes, what each call costs, and the billing rules: generating through the CLI, API or MCP needs
Pro or Studio, and costs credits on every plan. When a generation fails for lack of credits (exit
code 5) at a terminal, the CLI offers to open that page.

## Feedback

`ludo feedback "<message>"` sends a note to the Ludo team: a limitation you hit, a bug, something
you'd like Ludo to support, or something that worked well. Add `--category` (limitation, bug,
feature_request, praise, other), `--operation` and `--job <id>` (repeat it for each job) to point
at what it is about, or pipe the message in with `ludo feedback -`. It needs a Ludo account
(`ludo login`).

## Usage stats and crash reports

To see how the CLI is used and where it breaks, `ludo` sends Ludo a short record of each command
when it finishes:

- the command (`sprite animate`), its exit code and how long it took;
- the names of the flags used (`--prompt`, `--n`), never their values;
- the CLI, Node and OS versions, whether it ran at a terminal or in CI, and which coding agent ran it;
- for generations, the job ids and credits charged;
- for toolbox tools, how many files they read and in which format, the frame count, whether a
  sheet was made by Ludo, the engine, which next step they suggested (the command's name, like
  `sprite animate`), and for `asset manifest` how many gaps it found and of which kinds (never
  which files or characters);
- for a command that does not exist, the name tried (`sprite generate`): only lowercase words
  with no dots, slashes or spaces, so a mistyped single word where a command goes is sent as is;
- a random install id (kept in `~/.config/ludo/install_id`), and your account when you are logged
  in, so usage can be tied to it.

It never includes prompts, flag values, file paths, file contents or your API key.

If the CLI itself crashes (a bug in `ludo`, not an API error, a failed generation or a mistyped
command), it also sends a crash report to Ludo's error tracker: the error, a stack trace of the
CLI's own code, the versions above and the command name, with the same exclusions.

To turn both off, set `LUDO_TELEMETRY=0` (or the standard `DO_NOT_TRACK=1`).

## For AI agents

- `ludo agent-help` prints a one-page guide to the CLI.
- Claude Code: `ludo skill install` adds the Ludo skill to `~/.claude/skills` (or to this
  project's `.claude/skills` with `--project`, to share it through the repository). After an
  update the CLI rewrites the personal copy itself, and says when a project's copy is behind. It is also
  available as a plugin: `/plugin marketplace add Ludo-AI/ludo-cli`, then `/plugin install ludo@ludo`.
- Codex, Cursor, Gemini CLI, GitHub Copilot and other agents that read skills:
  `npx skills add Ludo-AI/ludo-cli` installs the same skill for the agents it finds.
- Gemini CLI: `gemini extensions install https://github.com/Ludo-AI/ludo-cli`.
- Anything else: point it at `ludo agent-help`, or copy
  [`skills/ludo/SKILL.md`](skills/ludo/SKILL.md) into your agent instructions.

## How it stays current

The CLI reads the API's public OpenAPI spec from `https://api.ludo.ai/api-documentation/openapi.json`
(cached for an hour, refreshed with a conditional request) and builds its commands from it. The copy
in `spec/openapi.json` is the offline fallback; a scheduled workflow keeps it fresh and publishes a
patch release when it changes. `ludo spec` shows which copy is in use; `ludo spec refresh` refetches.

## Development

```sh
npm install
npm test                                  # build + unit and end-to-end tests against a fake API
LUDO_API_URL=http://localhost:5000 node dist/cli.js --help   # against a local backend
LUDO_SPEC=path/to/openapi.json node dist/cli.js --help       # against a local spec file
```

## License

The code is [MIT](LICENSE). The Ludo name and logo are trademarks of Ludo AI and are not covered by
that license: a fork is welcome, but under its own name.
