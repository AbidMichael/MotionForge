# MotionForge — guide for agents

You make videos by **composing presets**, not by writing animation code. Every token you don't spend on easing curves goes into the idea.

## The loop

1. `mf_search {"query":"what you need"}` — always search before building. Read `mf_library {"name":"@core/base"}` once if you are new.
2. Write the composition to a `.json` file, then `mf_validate {"file":"/abs/path/video.json"}` → `cmp_x r1`. It is stored even when it has errors, and the same file always maps to the same `cmp_x`.
3. Fix it by editing the file with your own file tools, then `mf_patch {"id":"cmp_x"}` (no ops) to reload it. Or send JSON Patch ops (`mf_patch {"id":"cmp_x","ops":[{"op":"replace","path":"/scenes/2/d","value":4}]}`): they are written back to the file. Never paste the whole composition into a call.
4. Check with `mf_preview {"id":"cmp_x"}` (one frame per scene) and `mf_validate`/`mf_patch` with `"summary":true` (what moves when).
5. `mf_render {"id":"cmp_x","quality":"draft"}`, then `mf_job {"id":"job_…","wait":60}`. Use `hq` for delivery.
6. Keep what worked: `mf_save_as_preset`, or write presets with `mf_preset_put` into `@<your-agent-id>/<name>` (create it with `mf_library_create`). Publish with `mf_library_publish`. Rate presets you used with `mf_rate`.

## Composition

```json
{ "use": ["@core/kinetic@^1"],
  "theme": "core:dark",
  "format": "1920x1080@30",
  "scenes": [
    { "p": "core:title-card", "title": "Launch day", "kicker": "New" },
    { "t": "core:crossfade" },
    { "p": "core:stat", "value": 98, "suffix": "%", "label": "Uptime", "d": 3 },
    { "d": 2, "layers": [ { "type": "text", "text": "Custom", "size": 120, "in": ["core:fade-up"] } ] }
  ] }
```

- Scene entry: `"p"` + that preset's params; `"d"` seconds is optional (presets know their length; text-heavy ones scale with word count).
- Transition entry `{"t":…}` sits between two scenes.
- Values: tokens `"$color.accent"`, expressions `"{{W/2}}"`.
- Full reference: `mf_library {"name":"dsl"}`.

## Beyond scenes

- **Check before rendering**: `mf_check` (visual QA) and `mf_storyboard` (intent, rhythm, repetition). Give scenes an `"intent"`: hook, demonstration, explanation, breathing, conclusion.
- **Targeted previews**: `mf_preview {"id","scene":2}`, `{"transition":1}`, `{"focus":"#chart"}`, `{"clip":"mp4"}` (with sound).
- **Product demos**: build the UI with `@core/ui` elements (give them ids), then a scene's `"gestures"` (`click`, `type`, `scroll`, `drag`…) or a choreography `{"p":"ui:fill-form",…}`; add `"cursor":{"style":"arrow"}`. For a real site: `mf_capture` then `{"type":"capture","src":"cap_…"}`.
- **Data-driven videos**: put the varying content in `"data":{…}`, read it with `{{data.x}}`, and repeat a block of scenes per item with `{"each":"{{data.items}}","as":"item","scenes":[…],"between":{"t":"core:crossfade"}}` (`"if"` skips a scene). `mf_template {"id","data":[rows]}` makes one video per row (each row replaces/merges into `data`).
- **Motion paths**: `"motionPath":{"path":"M… C…","orient":true}`, `{"through":[[x,y],…]}` or `{"ellipse":{"center":[x,y],"rx","ry","turns"}}` on any layer — never sample a curve into keyframes.
- **Text styles**: `"textStyle":"h1|h2|h3|body|caption|label|kicker|mono|display"` (from the theme) or your own in `"textStyles":{"name":{"extends":"h2","color":"…"}}`; `"anchor":"baseline"` puts the first line's baseline on `y`.
- **Data**: `data:chart-story`, `data:race`, `data:map-story`, `data:network`, or raw `chart`/`map`/`graph` layers. For many videos from one design: declare `"params"`, use `{{params.x}}`, then `mf_template {"id","data":[rows],"render":true}`.
- **Explain**: `explain:sort|pathfinding|physics|pipeline`; physics parameters accept keyframes `[[0, 9.8], [3, 1.6]]`.
- **3D**: `three:product-spin {image}`, `three:exploded {items}`, `three:depth-cards`, `three:hero-object`.
- **3D models**: `mf_asset_put` a `.glb`/`.gltf`/`.fbx`/`.obj` (or a `.zip` with its textures), check it with `mf_model_inspect` (parts, animations, missing textures), then `three:model-hero {model, hdr}`, `three:model-turntable`, `three:character-intro {model, animation}`, or raw `{"shape":"model","src":"asset:…","animation":"Walk"}` in a `three` layer. Studio look: `"environment":{"src":"asset:<hdr>"}`, `"contactShadow":true`, `"post":{"bloom","ao","dof"}`, `"motionBlur":true`; `"quality":"pathtrace"` for hero shots; `"cache":true` for heavy shots.
- **Particles / sand**: `three:sand-disintegrate {model}`, `three:sand-assemble`, `three:particle-morph {from, to}`, or `"effect":{"kind":"disintegrate|assemble|vortex|scatter|morph|pile",…}` on any 3D object. Previews are draft (fewer grains, no AO/DOF/blur): use `mf_preview {"final":true}` to judge the real look.
- **Sound**: `"music":{"src":"asset:…","snap":"bar"}` (call `mf_audio` first), `"audio":[{"src":"click","on":"clicks"},{"src":"whoosh","on":"transitions"}]`, layer `"beat":"pulse"`.
- **Looks and formats**: `"direction":"dir:cinematic"`; compare looks with `mf_variants`; vertical/square versions with `mf_adapt` (then fix what it reports with `@portrait` overrides).
- **Continuity**: give the same `id` to a layer in two scenes and use `{"t":"core:morph"}`; `{"t":"core:expand","from":"#card"}` opens a card into the next scene.
- **Reuse**: sub-compositions `{"type":"comp","src":"cmp_…","time":{"speed":1.5}}`; `"cache":true` when it repeats.

## Writing presets

```json
{ "slug": "hook", "kind": "scene", "summary": "Launch hook with a NEW badge", "tags": ["launch","title"],
  "extends": "core:title-card",
  "params": { "backdrop": { "default": "grid" }, "badge": "string=NEW" },
  "addLayers": [ { "use": "core:pill", "text": "{{badge}}", "x": "{{W/2}}", "y": "{{H/2 - 260}}", "at": 0.9 } ],
  "example": { "title": "Launch day" } }
```

- Prefer `extends` over copying. If `mf_preset_put` warns about a near-duplicate, extend that preset instead.
- New kinds: `direction` (a whole look: theme, pace, transitions, overlays, sounds) and `choreography` (`{"steps":[gestures with {{params}}]}`).
- Params shorthand: `"string!"` (required), `"number=3"`, `"color=$color.accent"`, `"enum:left|right=left"`, `"array<string>!"`.
- Give an `example` with realistic values; it is how your preset gets tested and thumbnailed.
- Keep `summary` to one clear line and add 3–6 `tags`: that is what other agents search.
- Write a short `guide` for your library: house rules and the 3–5 presets that matter.

## Good habits

- One idea per scene; 1–6 words per kinetic line.
- Let the last word land before a transition (title scenes ≥ 2 s).
- Use `exit: "fade"` on scenes when there's no transition after them.
- `alpha` quality is for overlays: avoid backdrops in those scenes.
