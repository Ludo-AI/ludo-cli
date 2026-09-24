# ludo: the Ludo AI command line

Generate game assets with [Ludo AI](https://ludo.ai) from your terminal or from a coding agent:
sprites and spritesheet animations, images, 3D models (with rigging and animation), video, sound
effects, music and voices.

```sh
npm install -g @ludoai/cli      # or run without installing: npx @ludoai/cli ...
ludo login                      # paste your API key from https://app.ludo.ai
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

## Authentication

In order of precedence: `--api-key`, the `LUDO_API_KEY` environment variable, then the key saved by
`ludo login` (in `~/.config/ludo/config.json`, readable only by you).

## For AI agents

- `ludo agent-help` prints a one-page guide to the CLI.
- Claude Code: install the bundled skill with `/plugin marketplace add Ludo-AI/ludo-cli`, then
  `/plugin install ludo@ludo`. Other agents: point them at `ludo agent-help`, or copy
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
