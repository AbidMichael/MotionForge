# MotionForge

A local Node.js server that lets AI agents make motion-design videos by **composing presets** instead of writing animation code. Agents describe a video as a short JSON list of scenes; MotionForge expands it, validates it, and renders it with Remotion. Good work is saved as presets in versioned libraries, so the next video costs a fraction of the first.

```json
{ "use": ["@core/kinetic@^1"], "theme": "kinetic:impact",
  "scenes": [
    { "p": "kinetic:title-slam", "text": "Stop rebuilding", "sub": "Motion design for AI agents" },
    { "t": "core:flash" },
    { "p": "kinetic:big-number", "value": 90, "suffix": "%", "label": "fewer tokens per video" }
  ] }
```

That is the whole request (about 120 tokens). The equivalent hand-written Remotion code is hundreds of lines.

## Quick start (Windows, macOS, Linux)

Requires **Node.js 20.11+** (22 or 24 LTS recommended).

```bash
cd "D:\AI PROJECTS\MotionForge"
npm install
npm start
```

- Dashboard: <http://127.0.0.1:7420/>
- MCP endpoint (Streamable HTTP): `http://127.0.0.1:7420/mcp`
- REST API: `http://127.0.0.1:7420/v1/…`

On the first render, Remotion downloads Chrome Headless Shell (about 100 MB, once) and MotionForge bundles its player (about 20 s, once). Fonts are served locally from `node_modules/@fontsource`, so renders work offline.

Try it without an agent:

```bash
node bin/motionforge.mjs render examples/launch-promo.json draft
node bin/motionforge.mjs render examples/product-explainer.json hq
```

## Connect an agent

**Claude Code** (HTTP):

```bash
claude mcp add --transport http motionforge "http://127.0.0.1:7420/mcp?agent=claude-code"
```

**Claude Desktop** (stdio bridge; it starts the server automatically if it isn't running). In `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "motionforge": {
      "command": "node",
      "args": ["D:\\AI PROJECTS\\MotionForge\\bin\\motionforge.mjs", "mcp"],
      "env": { "MF_AGENT": "claude-desktop" }
    }
  }
}
```

The `agent` name (query param, `x-mf-agent` header, or `MF_AGENT`) decides which libraries an agent owns: agent `claude-code` writes to `@claude-code/*`.

## How agents use it

| Tool | What it does |
| --- | --- |
| `mf_search` | Find presets by intent ("punchy number reveal"). One compact line per result. |
| `mf_get` | One preset's params, defaults, duration rule and example. |
| `mf_library` | List libraries, read a library's guide, or `{"name":"dsl"}` for the full language reference. |
| `mf_validate` | Store and validate a composition → `cmp_…` with scene timings and path-addressed errors. |
| `mf_patch` | Fix or tweak a stored composition with JSON Patch instead of resending it. |
| `mf_preview` | Still frames + a contact sheet (one frame per scene) without a full render. |
| `mf_render` / `mf_job` | Queue a render (`draft`, `hq`, `gif`, `alpha`, `webm`) and wait for it. |
| `mf_library_create` | Create the agent's own library (`@<agent>/<name>`). |
| `mf_preset_put` | Write a preset into the library draft; it is test-compiled before it lands. |
| `mf_save_as_preset` | Turn a scene or a whole composition that worked into a preset. |
| `mf_library_publish` | Publish the draft as an immutable semver version (bump checked against changes). |
| `mf_asset_put` | Register an image/video/font/audio file → `asset:<id>`. |
| `mf_rate` | Rate a preset 1–5; ratings rank search and drive promotion. |
| `mf_check` | Visual QA: cut/overflowing text, overlaps, out of frame, low contrast, tiny text, reading speed, near-identical shots. |
| `mf_storyboard` | Scenes with their intent (hook, demonstration, explanation, breathing, conclusion), rhythm, repetition and length problems; reorder/insert/remove scenes. |
| `mf_variants` | Same content with other art directions, pace, framing, format or music — metrics and one comparison sheet. |
| `mf_adapt` | Same composition in other formats (9:16, 1:1…), re-laid out and checked. |
| `mf_template` | Data templates: one validated (and rendered) video per data row (JSON, CSV or asset). |
| `mf_edit` | Visual-editor operations: boxes at a time, move / retext / rescale / retime, written back into the source JSON. |
| `mf_capture` | Record a real interface (URL or HTML): clicks, typing, scrolling → screenshots + element positions for a `capture` layer. |
| `mf_audio` | Music analysis: tempo, beats, bars, hits, energy, suggested cut points. |

A typical loop is search → validate → patch → preview → render, then save the good parts as presets. See [`AGENTS.md`](AGENTS.md) for the agent-facing guide.

## Concepts

- **Presets** are reusable units with typed params and defaults: `scene`, `element`, `animation`, `transition`, `theme`, `template`. They are JSON (no code execution), can `extends` another preset, and are validated with their example before they are saved.
- **Libraries** are versioned folders under `libraries/@scope/name/<version>/`. A `draft/` folder is the working copy; published versions are immutable. They are plain JSON, so they can live in git.
- **Scopes**: `@core/*` ships with MotionForge, `@<agent>/*` belongs to one agent (private by default), `visibility: "project:<id>"` shares with agents on a project, `@shared/hub` holds promoted presets.
- **Shared hub promotion** happens when a preset meets the rating rule (default: 3+ ratings averaging 4+, 5+ successful renders, 90%+ success) *or* when you promote it from the dashboard. You can demote from the dashboard too.
- **Lockfiles**: each composition revision pins library versions, so a re-render is identical even after libraries change. `mf_patch {"relock": true}` picks up new versions.
- **Segment cache**: renders are split at scene boundaries; segments that didn't change are reused. Editing one scene re-renders only that scene (and its transitions).
- **Format**: 16:9 `1920x1080@30` by default; also `"9:16"`, `"1:1"`, `"4:5"`, `"4k"`, `"1280x720@60"`.
- **Audio**: a `music` bed (ducked under voice, cuts can snap to bars) and `audio` tracks placed at times or on events (`"on":"clicks"`, `"@scene:2"`, `"@bar:4"`), plus 14 built-in synthesised sounds. Everything is mixed (≈ -16 LUFS, limiter) into renders and preview clips.
- **Sub-compositions**: a composition can be a layer of another (`{"type":"comp"}`) with its own size, crop, mask, rounded corners and local time (start, end, speed, loop, pauses, hold); `"cache": true` renders it once to a transparent video reused by every render.
- **Data-driven**: charts, bar races, maps and networks from JSON/CSV; compositions with `params` are templates rendered once per data row, data-independent scenes come from the segment cache.
- **3D**: `{"type":"three"}` with objects, materials, lights and cameras — transparent PNG images become cut-outs with image-shaped shadows (WebGL; `render.gl` = `angle` with a GPU, `swangle` on servers).
- **Captures**: real web interfaces recorded with `mf_capture` and replayed with a synthetic cursor in sync with sounds.

## Shipped libraries

- **@core/base** (`core:`) — 5 themes (`dark` default, `light`, `neon`, `editorial`, `brutal`), 28 animations, 10 transitions, 16 elements, 12 scenes (title card, statement, stat, quote, bullets, section, bar chart, compare, split media, full-bleed media, logo reveal, end card).
- **@core/kinetic** (`kinetic:`) — the `impact` theme, kinetic type scenes (title slam, word stack, highlight, big number, word swap, countdown, terminal, glitch title, split reveal, marquee) and 8 animations.
- **@core/base 1.1** adds continuity transitions: `core:morph` (shared ids fly to their new place), `core:expand` (a card becomes the next scene), `core:collapse`.
- **@core/directions** (`dir:`) — 9 art directions (cinematic, corporate, playful, tech, editorial, brutal, documentary, luxury, minimal) and overlay elements (grain, vignette, letterbox, scanlines, frame).
- **@core/data** (`data:`) — chart story, bar race, map story, network.
- **@core/3d** (`three:`) — product spin, exploded view, depth cards (camera travelling), hero object.
- **@core/ui** (`ui:`) — window, input, button, toast, list item, spinner, and choreographies (fill-form, login, search-pick, drag-drop, tour).
- **@core/explain** (`explain:`) — sorting, path-finding, physics with animatable parameters, pipelines.

Official `@core/*` libraries need no `"use"`: their aliases resolve automatically.

## Dashboard

<http://127.0.0.1:7420/> shows, live: the render queue (with reused vs. rendered segments), what each agent is calling and how many tokens it costs, recent compositions with contact sheets, libraries and their changes, and the shared-hub promotion queue with Promote / Demote buttons.

<http://127.0.0.1:7420/editor?id=cmp_…> is the visual editor: scrub the timeline, click a box on the frame, drag it, change its text, scale or timing, or a scene's length. Each change becomes a new revision of the composition JSON (direct values for your own layers, scene `tweaks` for layers made by presets), with Undo.

## Configuration

Copy `motionforge.config.example.json` to `motionforge.config.json`. Main options:

| Key | Default | Meaning |
| --- | --- | --- |
| `port`, `host` | `7420`, `127.0.0.1` | Bind address. Keep `127.0.0.1` unless you add keys. |
| `auth` | `"none"` | `"none"` trusts the agent name; `"keys"` requires `Authorization: Bearer <key>` from `agents`. |
| `agents` | `[]` | `{ "id", "key", "admin", "projects": [] }` per agent. |
| `defaultFormat`, `defaultTheme` | `1920x1080@30`, `core:dark` | Used when a composition leaves them out. |
| `render.concurrency` | `null` | Chrome tabs per render (null = half your CPU cores). |
| `render.jobs` | `1` | Renders in parallel (previews never wait behind renders). |
| `render.browserExecutable` | `null` | Use your own Chrome instead of the downloaded one (also used by `mf_capture`). |
| `render.gl` | `angle` (`swangle` on Linux) | WebGL backend for 3D layers: `angle` uses the GPU, `swangle` renders in software. |
| `promotion` | 3 / 4.0 / 5 / 0.9 | Ratings, average, successful renders, success rate needed for automatic promotion. |

Environment overrides: `MF_PORT`, `MF_HOST`, `MF_DATA_DIR`, `MF_LIBRARIES_DIR`, `MF_BROWSER_EXECUTABLE`, `MF_GL`, `MF_CONFIG`.

Everything the server produces lives in `data/` (SQLite index, assets, cache, previews, renders). It is safe to delete; libraries are not stored there.

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

Source layout: `src/dsl` (schemas, expressions, compiler → Render IR; `src/dsl/features` holds sub-compositions, components, gestures, connectors, continuity, audio, music, data, simulations, 3D, directions and captures), `src/ir` (IR types and maths shared with the player), `src/remotion` (the generic IR player), `src/render` (Remotion adapter, queue, segments, fonts), `src/registry` (libraries, search, promotion), `src/server` (REST, dashboard), `src/mcp` (tools, HTTP and stdio).

## Troubleshooting

- **Port already in use**: another MotionForge is running, or set `MF_PORT`.
- **`better-sqlite3` fails to install**: use a Node LTS version (20, 22 or 24) so a prebuilt binary is available.
- **First render is slow**: that is the one-time Chrome download and player bundle.
- **3D layers are blank**: WebGL is not available with the current `render.gl`; try `"swangle"` (software) or `"angle"`.
- **`mf_capture` cannot start Chrome**: set `render.browserExecutable` to your Chrome/Chromium.
- **Text falls back to Arial**: the font isn't in `node_modules/@fontsource`; install `@fontsource/<font-name>` or use `"source":"url"` with a font file.

## Licensing note

Remotion is free for individuals and companies of up to 3 people, including automation. Larger organisations need a Remotion Company License. The renderer sits behind an adapter (`src/render/remotion.ts`), so it can be swapped later.
