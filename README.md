# MotionForge

**Motion design for AI agents.** MotionForge is a local Node.js server that lets AI agents (Claude, Codex, any MCP client) make motion-design videos by **composing presets** instead of writing animation code. An agent describes a video as a short JSON list of scenes; MotionForge expands it, validates it and renders it with [Remotion](https://www.remotion.dev/). Good work is saved as presets in versioned libraries, so the next video costs a fraction of the first.

```json
{ "use": ["@core/kinetic@^1"], "theme": "kinetic:impact",
  "scenes": [
    { "p": "kinetic:title-slam", "text": "Stop rebuilding", "sub": "Motion design for AI agents" },
    { "t": "core:flash" },
    { "p": "kinetic:big-number", "value": 90, "suffix": "%", "label": "fewer tokens per video" }
  ] }
```

That is the whole request (about 120 tokens). The equivalent hand-written Remotion code is hundreds of lines.

# Exemple
## English Version
https://github.com/user-attachments/assets/9afe6faf-4649-4e60-95a7-a02cc6ac3703

## French Version
Same preset, onlys text changes

https://github.com/user-attachments/assets/32802bee-ba6c-448b-aa4d-e8aa5f173b72

## Features

- **Preset-based DSL**: scenes, elements, animations, transitions, themes and art directions, all plain JSON with typed params.
- **MCP server + REST API**: 22 tools covering search, validate, patch, preview, render, QA, storyboard, variants, format adaptation and data templates.
- **Versioned libraries** with semver, lockfiles, an agent-owned scope per agent and a shared hub with rating-based promotion.
- **Fast iteration**: JSON Patch edits, still previews and contact sheets, plus a segment cache that re-renders only the scenes that changed.
- **Rich layers**:
  - kinetic type, UI mock-ups with a synthetic cursor and gestures, and real web captures;
  - charts, bar races, maps and networks from JSON or CSV;
  - explanatory simulations (sorting, path-finding, physics);
  - a 3D scene graph (three.js) with transparent image cut-outs.
- **Audio**: music beds with beat/bar snapping, event-driven sound effects and loudness-normalised mixing.
- **Visual editor and live dashboard** in the browser.
- **Works offline** after installation: fonts, player and Chrome Headless Shell are all local.

## Requirements

- **Node.js 20.11 or newer** (22 or 24 LTS recommended). Download it from [nodejs.org](https://nodejs.org/).
- Git.
- About 1 GB of free disk space for dependencies and the one-time Chrome Headless Shell download.
- **OS**: Windows 10/11, macOS 12+ or a recent 64-bit Linux.
  - On Linux servers without a desktop, Chrome needs the usual system libraries (`libnss3`, `libatk-bridge2.0-0`, `libgbm1`, `libasound2`…). See [Remotion's Linux notes](https://www.remotion.dev/docs/miscellaneous/linux-dependencies).

## Installation

```bash
git clone https://github.com/AbidMichael/motionforge.git
cd motionforge
npm install
npm start
```

Once it is running:

- Dashboard: <http://127.0.0.1:7420/>
- MCP endpoint (Streamable HTTP): `http://127.0.0.1:7420/mcp`
- REST API: `http://127.0.0.1:7420/v1/…`

The first render takes longer, once only:

- Remotion downloads Chrome Headless Shell (about 100 MB).
- MotionForge bundles its player (about 20 s).

Fonts are served from `node_modules/@fontsource`, so renders work offline afterwards.

Try a render without any agent:

```bash
node bin/motionforge.mjs render examples/launch-promo.json draft
node bin/motionforge.mjs render examples/product-explainer.json hq
```

The video path is printed at the end. Outputs go to `data/renders/`.

## Connect an agent

In the commands below, replace `/path/to/motionforge` with the folder you cloned into. For example:

- `C:\Users\you\motionforge` on Windows (write it `C:\\Users\\you\\motionforge` inside JSON);
- `/Users/you/motionforge` on macOS.

### Claude Code (HTTP; start the server first with `npm start`)

```bash
claude mcp add --transport http motionforge "http://127.0.0.1:7420/mcp?agent=claude-code"
```

### Claude Desktop, Cursor, or any stdio MCP client

The stdio bridge starts the server automatically if it isn't already running. Add this to the client's MCP configuration, for example `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "motionforge": {
      "command": "node",
      "args": ["/path/to/motionforge/bin/motionforge.mjs", "mcp"],
      "env": { "MF_AGENT": "claude-desktop" }
    }
  }
}
```

### Other HTTP clients

Point them at `http://127.0.0.1:7420/mcp?agent=<name>`.

### Agent names

The agent name decides which libraries an agent owns: agent `my-agent` writes to `@my-agent/*`. It can be set in three ways:

- the `agent` query parameter;
- the `x-mf-agent` header;
- the `MF_AGENT` environment variable.

## How agents use it

| Tool | What it does |
| --- | --- |
| `mf_search` | Find presets by intent ("punchy number reveal"). One compact line per result. |
| `mf_get` | One preset's params, defaults, duration rule and example. |
| `mf_library` | List libraries, read a library's guide, or `{"name":"dsl"}` for the full language reference. |
| `mf_validate` | Store and validate a composition → `cmp_…` with scene timings and path-addressed errors. |
| `mf_patch` | Fix or tweak a stored composition with JSON Patch instead of resending it. |
| `mf_preview` | Still frames and a contact sheet (one frame per scene), or a short clip with sound. |
| `mf_render` / `mf_job` | Queue a render (`draft`, `hq`, `gif`, `alpha`, `webm`) and wait for it. |
| `mf_library_create` | Create the agent's own library (`@<agent>/<name>`). |
| `mf_preset_put` | Write a preset into the library draft; it is test-compiled before it lands. |
| `mf_save_as_preset` | Turn a scene or a whole composition that worked into a preset. |
| `mf_library_publish` | Publish the draft as an immutable semver version (bump checked against changes). |
| `mf_asset_put` | Register an image/video/font/audio file → `asset:<id>`. |
| `mf_rate` | Rate a preset 1–5; ratings rank search and drive promotion. |
| `mf_check` | Visual QA: cut/overflowing text, overlaps, out of frame, low contrast, tiny text, reading speed, near-identical shots. |
| `mf_storyboard` | Scene intents, rhythm, repetition and length problems; reorder, insert or remove scenes. |
| `mf_variants` | Same content with other art directions, pace, framing, format or music, plus one comparison sheet. |
| `mf_adapt` | Same composition in other formats (9:16, 1:1…), re-laid out and checked. |
| `mf_template` | Data templates: one validated (and rendered) video per data row (JSON, CSV or asset). |
| `mf_edit` | Visual-editor operations (move, retext, rescale, retime) written back into the source JSON. |
| `mf_capture` | Record a real interface (URL or HTML): clicks, typing, scrolling → a `capture` layer. |
| `mf_audio` | Music analysis: tempo, beats, bars, hits, energy, suggested cut points. |

A typical loop is search → validate → patch → preview → render, then save the good parts as presets. See [`AGENTS.md`](AGENTS.md) for the agent-facing guide; it is worth pasting into your agent's instructions.

## Concepts

- **Presets** are reusable units with typed params and defaults: `scene`, `element`, `animation`, `transition`, `theme`, `template`, `direction`, `choreography`.
  - They are JSON only, so no code is executed.
  - They can `extends` another preset.
  - They are validated with their example before they are saved.
- **Libraries** are versioned folders under `libraries/@scope/name/<version>/`.
  - A `draft/` folder is the working copy; published versions are immutable.
  - They are plain JSON, so they can live in git.
- **Scopes**:
  - `@core/*` ships with MotionForge;
  - `@<agent>/*` belongs to one agent (private by default);
  - `visibility: "project:<id>"` shares a library with the agents on a project;
  - `@shared/hub` holds promoted presets.
- **Shared hub promotion** happens either from the dashboard or when a preset meets the rating rule. The default rule is all of: 3+ ratings averaging 4+, 5+ successful renders, and a 90%+ success rate. You can also demote from the dashboard.
- **Lockfiles**: each composition revision pins library versions, so a re-render is identical even after libraries change. `mf_patch {"relock": true}` picks up new versions.
- **Segment cache**: renders are split at scene boundaries, and unchanged segments are reused. Editing one scene re-renders only that scene and its transitions.
- **Formats**:
  - default: 16:9 `1920x1080@30`;
  - also `"9:16"`, `"1:1"`, `"4:5"`, `"4k"` and `"1280x720@60"`.
- **Audio**:
  - a `music` bed, ducked under voice, with cuts that can snap to bars;
  - `audio` tracks placed at times or on events (`"on":"clicks"`, `"@scene:2"`, `"@bar:4"`);
  - 14 built-in synthesised sounds;
  - everything mixed at about -16 LUFS with a limiter.
- **Sub-compositions**: a composition can be a layer of another (`{"type":"comp"}`) with its own size, crop, mask and local time. With `"cache": true` it is rendered once and reused.
- **Data-driven videos**:
  - charts, bar races, maps and networks from JSON or CSV;
  - compositions with `params` are templates, rendered once per data row.
- **3D**: `{"type":"three"}` with objects, materials, lights and cameras. Transparent PNG/WebP images become cut-outs with image-shaped shadows.
- **Captures**: real web interfaces recorded with `mf_capture` and replayed with a synthetic cursor, in sync with sounds.

## Shipped libraries

| Library | Prefix | Contents |
| --- | --- | --- |
| `@core/base` | `core:` | 5 themes, 28 animations, transitions (including continuity: `morph`, `expand`, `collapse`), 16 elements, 12 scenes |
| `@core/kinetic` | `kinetic:` | The `impact` theme and kinetic-type scenes (title slam, word stack, big number, countdown, terminal, glitch…) |
| `@core/directions` | `dir:` | 9 art directions (cinematic, corporate, playful, tech…) and overlays (grain, vignette, letterbox…) |
| `@core/data` | `data:` | Chart story, bar race, map story, network |
| `@core/3d` | `three:` | Product spin, exploded view, depth cards, hero object |
| `@core/ui` | `ui:` | Window, input, button, toast, list, spinner, and choreographies (fill-form, login, search-pick, drag-drop, tour) |
| `@core/explain` | `explain:` | Sorting, path-finding, physics, pipelines |

Official `@core/*` libraries need no `"use"`: their aliases resolve automatically. Libraries that agents create (`@<agent>/*`) are local and are ignored by git by default (see `.gitignore`).

## Dashboard and editor

- <http://127.0.0.1:7420/> shows, live:
  - the render queue, with reused vs. rendered segments;
  - what each agent is calling and how many tokens it costs;
  - recent compositions with contact sheets;
  - libraries and the shared-hub promotion queue.
- <http://127.0.0.1:7420/editor?id=cmp_…> is the visual editor:
  - scrub the timeline;
  - drag a box, or change its text, scale or timing;
  - each change becomes a new revision of the composition JSON, with Undo.

## Configuration

Everything works with the defaults. To customise, copy the example file:

```bash
cp motionforge.config.example.json motionforge.config.json      # macOS / Linux
copy motionforge.config.example.json motionforge.config.json    # Windows
```

`motionforge.config.json` is ignored by git, because it can contain agent keys.

| Key | Default | Meaning |
| --- | --- | --- |
| `port`, `host` | `7420`, `127.0.0.1` | Bind address. Keep `127.0.0.1` unless you enable `auth: "keys"`. |
| `auth` | `"none"` | `"none"` trusts the agent name; `"keys"` requires `Authorization: Bearer <key>` from `agents`. |
| `agents` | `[]` | `{ "id", "key", "admin", "projects": [] }` per agent. |
| `defaultFormat`, `defaultTheme` | `1920x1080@30`, `core:dark` | Used when a composition leaves them out. |
| `render.concurrency` | `null` | Chrome tabs per render (null = half your CPU cores). |
| `render.jobs` | `1` | Renders in parallel (previews never wait behind renders). |
| `render.browserExecutable` | `null` | Use your own Chrome/Chromium instead of the downloaded one (also used by `mf_capture`). |
| `render.gl` | `angle` (`swangle` on Linux) | WebGL backend for 3D layers: `angle` uses the GPU, `swangle` renders in software. |
| `promotion` | 3 / 4.0 / 5 / 0.9 | Ratings, average, successful renders and success rate needed for automatic promotion. |

**Environment variables** override the file:

- `MF_PORT`, `MF_HOST`;
- `MF_DATA_DIR`, `MF_LIBRARIES_DIR`;
- `MF_BROWSER_EXECUTABLE`, `MF_GL`;
- `MF_CONFIG` (path to a config file);
- `MF_AGENT` (stdio bridge).

**Where things are stored**: everything the server produces lives in `data/`: the SQLite index, assets, cache, previews and renders. It is safe to delete and is not versioned. Libraries are not stored there.

## REST API (summary)

```
GET  /v1/search?q=&kind=&library=&limit=     GET  /v1/presets/:id
GET  /v1/libraries        GET /v1/libraries/:name        POST /v1/libraries
PUT  /v1/libraries/:name/presets/:slug       POST /v1/libraries/:name/publish
POST /v1/compositions     POST /v1/compositions/:id/patch    POST /v1/compositions/:id/preview
POST /v1/compositions/:id/save-as-preset     GET  /v1/compositions/:id/summary
POST /v1/renders          GET  /v1/jobs/:id?wait=60          POST /v1/renders/:id/cancel
POST /v1/assets           POST /v1/presets/:id/rate          GET  /v1/promotion
GET  /v1/events (SSE)     GET  /v1/stats/tokens              POST /v1/admin/reindex | /v1/admin/thumbs
POST /v1/compositions/:id/check     GET|POST /v1/compositions/:id/storyboard    POST /v1/compositions/:id/variants
POST /v1/compositions/:id/adapt     POST /v1/compositions/:id/template          GET  /v1/compositions/:id/layout?t=
POST /v1/compositions/:id/edit      POST /v1/captures   GET /v1/captures[/:id]  POST /v1/audio/analyze
```

Library names in URLs are URL-encoded (`%40core%2Fbase`).

## Development

```bash
npm run dev        # server with reload
npm test           # vitest: DSL, compiler, segment cache, REST flow
npm run typecheck
npm run studio     # Remotion Studio on the IR player
```

Project layout:

```
bin/            CLI entry point (start | mcp | render | validate | reindex)
src/dsl/        schemas, expressions, compiler → Render IR
src/dsl/features/  sub-compositions, components, gestures, connectors, continuity,
                audio, music, data, simulations, 3D, directions, captures
src/ir/         IR types and maths shared with the player
src/remotion/   the generic IR player (React / Remotion / three.js)
src/render/     Remotion adapter, queue, segments, fonts, audio
src/registry/   libraries, search, promotion
src/server/     REST API, dashboard, editor
src/mcp/        MCP tools, HTTP and stdio transports
libraries/@core official preset libraries
examples/       sample compositions
test/           vitest suites
```

See [CONTRIBUTING.md](CONTRIBUTING.md) to contribute.

## Troubleshooting

- **Port already in use**: another MotionForge is running, or set `MF_PORT`.
- **`better-sqlite3` or `sharp` fails to install**:
  - use a Node LTS version (20, 22 or 24) so prebuilt binaries are available;
  - on Windows, avoid paths with non-ASCII characters;
  - delete `node_modules` and run `npm install` again after switching Node versions.
- **First render is slow**: that is the one-time Chrome download and player bundle.
- **Chrome fails to start on Linux**: install the system libraries listed in Requirements, or set `render.browserExecutable` to an installed Chromium.
- **3D layers are blank**: WebGL is not available with the current `render.gl`. Try `"swangle"` (software) or `"angle"`.
- **`mf_capture` cannot start Chrome**: set `render.browserExecutable` to your Chrome/Chromium.
- **Text falls back to Arial**: the font isn't in `node_modules/@fontsource`. Install `@fontsource/<font-name>` or use `"source":"url"` with a font file.
- **Changes to the player don't show up**: restart the server so the player bundle is rebuilt.

## License

MotionForge is released under the [MIT License](LICENSE).

It depends on [Remotion](https://www.remotion.dev/), which has its own license: it is free for individuals and for companies of up to 3 people, including automation. Larger organisations need a [Remotion Company License](https://www.remotion.dev/license). The renderer sits behind an adapter (`src/render/remotion.ts`), so it can be swapped out.
