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
  `./ludo-output` (or `--out <dir>`). Result URLs expire after 7 days; the files do not.
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

### In the terminal

At a terminal, results show up right there, spritesheets as a looping animation. Terminals that
draw real images (iTerm2, Kitty, Ghostty, WezTerm) show the actual picture; elsewhere pixel art is
drawn with block characters and other images are left to `--open`, which opens them full size.
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
  "files": [{ "url": "https://…", "path": "ludo-output/animateSprite-1a2b3c4d-1.png" }]
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
- `engine`: as `--engine` on every command.
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

### Variations and batches

- `--n 4` makes four variations of one request and saves them as `-v1` to `-v4`. At a terminal
  you then pick which to keep; the rest move to `<out>/.discarded/`. Where the API takes `n`
  (images) one job makes them; elsewhere the jobs run side by side.
- `ludo batch jobs.json` runs a list of different generations side by side (`ludo batch --help`
  shows the format). The price of the whole list is checked first. A failed item does not stop the
  others.
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
buy credits, change plan or set up auto top-up. When a generation fails for lack of credits (exit
code 5) at a terminal, the CLI offers to open that page.

## Feedback

`ludo feedback "<message>"` sends a note to the Ludo team: a limitation you hit, a bug, something
you'd like Ludo to support, or something that worked well. Add `--category` (limitation, bug,
feature_request, praise, other), `--operation` and `--job <id>` to point at what it is about, or
pipe the message in with `ludo feedback -`. It needs a Ludo account (`ludo login`).

## Crash reports

If the CLI itself crashes (a bug in `ludo`, not an API error, a failed generation or a mistyped
command), it sends a crash report to Ludo's error tracker. The report holds the error, a stack trace
of the CLI's own code, the CLI, Node and OS versions and the command name (`sprite animate`). It
never includes your API key, prompts, flag values or file paths.

To turn crash reports off, set `LUDO_TELEMETRY=0` (or the standard `DO_NOT_TRACK=1`).

## For AI agents

- `ludo agent-help` prints a one-page guide to the CLI.
- Claude Code: `ludo skill install` adds the Ludo skill to `~/.claude/skills` (or to this
  project's `.claude/skills` with `--project`, to share it through the repository). Re-run it after
  updating the CLI. It is also available as a plugin: `/plugin marketplace add Ludo-AI/ludo-cli`,
  then `/plugin install ludo@ludo`.
- Other agents: point them at `ludo agent-help`, or copy
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
