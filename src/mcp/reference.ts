/** Full language reference, returned by mf_library {"name":"dsl"} (read it once per session at most). */
export const DSL_REFERENCE = `MOTIONFORGE DSL

COMPOSITION
{"use":["@scope/lib@^1", "@me/promo@draft as promo"],   // @core/base (alias core) is always imported
 "theme":"core:dark" | {"p":"core:neon","accent":"#ff3d71"},
 "tokens":{"color":{"accent":"#ff3d71"}},                 // override theme tokens
 "format":"1920x1080@30",                                  // default; also "16:9","9:16","1:1","4:5","4k","1280x720@60"
 "bg":"#000", "fonts":[{"family":"Bebas Neue","source":"google","weights":[400]}],
 "textStyles":{"title":{"extends":"h1","color":"$color.accent"}},   // named text styles (see TEXT STYLES)
 "data":{"brand":"Nova","items":[…]},                      // data-driven video: {{data.brand}}, "each":"{{data.items}}"
 "scenes":[ SCENE | TRANSITION | EACH, … ]}
SCENE      {"p":"alias:slug", …params, "d":3, "layers":[overlay layers], "slots":{"name":[layers]}, "bg":"#111", "if":"{{expr}}"}
           {"d":2, "layers":[…]}                           // inline scene, no preset
TRANSITION {"t":"core:crossfade", "d":0.6, …params}      // between two scenes (or first/last for an intro/outro)
EACH       {"each":"{{data.items}}", "as":"item", "scenes":[SCENE | TRANSITION, …], "between":{"t":"core:slide-push"}}
           // the block repeats per item (array, object → {key,…value}, or a count); scope: item, index, count, first, last; "if" skips a scene
Macro presets (kind template, or scenes whose body has "scenes") expand into several entries.
Files: keep the composition in a .json file and call mf_validate {"file":"/abs/path.json"} — edit the file, then mf_patch {"id"} reloads it;
mf_patch ops are written back to the file. Same file = same cmp id.

LAYER
{"type":"text|rect|ellipse|line|path|image|video|svg|group|comp|states|list|connector|chart|map|graph|sim|three|capture",
 "x":960,"y":"50%","w":"40vw","h":200, "anchor":"center|left|right|top|bottom|top-left|…|baseline|baseline-center|baseline-right|[ax,ay]",
 "at":0.4, "dur":2 | "until":"end-0.5",                  // seconds within the parent; default: whole parent
 "in":["core:fade-up", {"p":"core:rise","d":0.8,"at":0.1,"stagger":0.03,"ease":"snap", …params}],
 "out":[…] (ends at the layer end), "anim":[{"p":"core:shake","at":1.2}], "loop":[{"p":"core:float","d":3}],
 "opacity":1,"rot":0,"scale":1,"z":0,"blend":"screen", "id":"name", "if":"{{expr}}",
 …style keys flat}
text:  "text", "size", "font", "weight", "color", "align", "lineHeight", "tracking"(em), "case":"upper|lower", "italic", "shadow",
       "glow":"#color", "stroke":"#color","strokeWidth", "gradient":"linear-gradient(…)" (gradient fill), "bg","padding","radius",
       "split":"chars|words|lines" (in/out anims then run per unit with "stagger" seconds),
       "counter":{"from":0,"to":1250,"d":1.5,"at":0,"ease":"outExpo","decimals":0,"prefix":"$","suffix":"+","sep":","},
       "textStyle":"h1" (named style; the layer's own keys win; "h2 caption" combines), "anchor":"baseline" (y = first line's baseline)
rect/ellipse: "w","h","fill" (colour or CSS gradient),"radius","stroke","strokeWidth","shadow","glow"
line:  "x","y","x2","y2","stroke","strokeWidth","cap"           path: "d","viewBox","w","h","stroke","fill"
image/video: "src":"asset:<id>"|https URL, "w","h","fit":"cover|contain","radius"     svg: "svg":"<svg…>","w","h"
group: "children":[…], "w","h" (optional box), "layout":{"dir":"row|column","gap":24,"align":"start|center|end","justify":"…","wrap":false}, "overflow":"hidden"
Any other CSS property can be passed flat (e.g. "boxShadow", "letterSpacing", "WebkitMaskImage").
element preset: {"use":"core:counter", …params, "x","y","at","dur","in","out",…}
repeat: {"repeat":"{{items}}" | 5, "as":"item", "layer":{… "{{item}}" "{{index}}" "{{count}}" …}}
slot placeholder in a preset body: {"slot":"background","default":[…]}

VALUES
Tokens: "$color.accent" (whole value). Expressions: "{{W/2 - 100}}", "{{subtitle ? 1 : 0}}", "Hello {{name}}!".
Scope: params, W, H, fps, dur (seconds of the parent), item/index/count in repeat, $color/$font/$size/… token groups.
Functions: min max clamp round floor ceil abs sqrt sin cos len words upper lower str num split join first last pick(i,…) pluck(arr,key) fixed
           rand(seed,salt) (deterministic) maxOf(arr,key) minOf sumOf pad alpha(color,a) mix(c1,c2,t) lerp. Object literals {p:'core:fade-in'}.
Lengths: px numbers, "50%", "10vw", "8vh", "5vmin". Times: seconds, "end", "end-0.5", "50%".

PRESET FILE (mf_preset_put)
{"slug":"hook","kind":"scene|element|animation|transition|theme|template|direction|choreography","summary":"one line","tags":["…"],
 "params":{"title":"string!","size":"number=96","accent":"color=$color.accent","dir":"enum:left|right=left",
           "items":"array<string>!","enter":"preset:animation=core:rise","logo":"asset", "x2":{"type":"number","default":3,"min":0,"desc":"…"}},
 "duration":{"default":3,"min":2,"max":8,"perWord":0.3,"wordsFrom":"text"},  // perWord: d = default + perWord × words
 "example":{…params for a test render},
 "body":{…}}
Reuse: "extends":"core:title-card" + "params":{"backdrop":{"default":"grid"}} (new defaults) + "bind":{"title":"{{upper(headline)}}"} (fixed values) + "addLayers":[…].
Bodies by kind:
 scene/element: {"layers":[…], "bg"?, "w"/"h"/"layout" (element box)}   — scene coordinates are frame px; element layers are relative to the element origin
 template (or scene macro): {"scenes":[entries using {{params}}]}
 animation: {"tracks":{"opacity":[0,1],"dy":["{{distance}}",0]},"ease":"out","unit":true,"clipDir":"left"} — keyframes [v0,v1,…] or [[t,v,ease],…] with t in 0..1
 transition: {"out":{"tracks":…},"in":{"tracks":…},"overlay":[layers],"overlap":true}   ("overlap":false = cut in the middle, e.g. flashes)
 theme: {"tokens":{"color":{…},"font":{…},…},"fonts":[…]}
 direction: {"theme","tokens","fonts","pace","animScale","transition"|"transitions","sceneDefaults","overlays":[layers],"sfx":{"transitions":"whoosh"}}
 choreography: {"steps":[gestures using {{params}}]}
Channels: opacity scale scaleX scaleY clip draw chars brightness (multiply) · dx dy rotate blur skewX letterSpacing hue il it ir ib rad rotX rotY (add) · color bw bh (override)
Easings: linear in out inOut (= inCubic outCubic inOutCubic) inQuad outQuad inOutQuad inQuart… inQuint… inSine outSine inOutSine inCirc… inExpo outExpo inOutExpo
         inBack outBack inOutBack outElastic outBounce snap smooth hold cubic(a,b,c,d) spring(0.4) steps(4)

TEXT STYLES
Built in (from the theme tokens): display h1 h2 h3 body small caption label kicker mono. Define or override them in the theme ("tokens":{"text":{…}})
or the composition ("textStyles":{"name":{"font","size","weight","tracking","lineHeight","color","case","italic",…, "extends":"h1"}}).
Use: {"type":"text","text":"Q3 results","textStyle":"h2","anchor":"baseline","x":140,"y":420}

MOTION PATHS (layer key "motionPath"; any layer or element)
{"path":"M200 800 C 600 100 1300 1000 1700 300"}          // SVG path data in parent coordinates: the layer is placed on it
{"through":[[200,800],[700,300],[1200,700]], "tension":0.5, "closed":false}   // smooth curve through points
{"ellipse":{"center":[960,540],"rx":420,"ry":160,"start":0,"turns":1,"dir":"cw|ccw"}} | {"circle":300}   // no center: orbit from where the layer is
+ "at":0.5,"d":2 (seconds; default: to the layer's end), "ease":"inOutSine", "from":0,"to":1 (part of the path), "orient":true|degrees
  (turn along the tangent), "loop":true, "relative":true (path offsets from the layer, e.g. "M0 0 l 300 -120").
A list plays one after the other: "motionPath":[{…},{…}]. Combines with in/out/keys (they add).

COMPOSITION EXTRAS
"data":{…} — data-driven videos: scenes read {{data.x}}, EACH blocks repeat scenes per item; mf_template {"id","data":[rows]} makes one video per row
  (each row replaces/merges into "data"; rows can be JSON, CSV or asset:<id>). Scenes that don't depend on data are reused from the render cache.
"params":{"client":"string!","sales":"array<object>!"}, "props":{…defaults}  // exposed params → "{{client}}" / "{{params.sales}}"; sub-compositions, typed templates
"direction":"dir:cinematic" | {"p":"dir:tech","accent":"#0ff"}           // art direction: theme, pace, transitions, overlays, sounds (library @core/directions)
"pace":0.85 (×scene durations) · "framing":1.1 (×scale of every scene) · "adapt":{"from":"16:9","text":1.1} (inline layers written for another format)
"@portrait"/"@landscape"/"@square"/"@wide"/"@tall": {…overrides} on any object (composition, scene, layer, preset body).
Scene extras: "intent":"hook|demonstration|explanation|breathing|conclusion", "gestures":[…], "cursor":{…}, "tweaks":{"<layer>":{dx,dy,scale,rot,opacity,size,shift}}, "sfx".
Layer extras: "keys":{"dx":[[0,0],[1.2,300,"snap"]],"opacity":[…]} (keyframes in seconds), "mask":"circle(40%)"|"inset(10% round 24px)"|"M0 0…" (path),
 "fit":"shrink" + "maxLines" + "minSize" (text shrinks to its box), "sfx":"pop"|{"name","at","gain"}, "beat":"pulse|flash|shake|bounce|blink"|{"kind","on":"beat|bar|hit","every","amount"}.
Channels added: il it ir ib rad (inset clip px + corner radius), rotX rotY (3D tilt, degrees), bw bh (box size override).

SUB-COMPOSITIONS
{"type":"comp","src":"cmp_<id>"|"alias:template"|{inline composition},"props":{…},"w":800,"h":450,"fit":"cover|contain","focus":[0.5,0.3],"zoom":1.2,
 "radius":24,"mask":…,"format":"9:16","bg":…,"time":{"start":2,"end":6,"speed":1.5,"loop":true,"pauses":[[3,1]],"hold":true,"delay":0.5}}
Child markers and sounds follow the child's local time.

COMPONENTS WITH STATES, LISTS
{"type":"states","id":"panel","w":800,"h":480,"states":{"empty":[…],"loading":[…],"result":[…],"error":[…]},"seq":[{"at":0,"state":"empty"},{"at":1.2,"state":"loading"}],"transition":"fade|up|slide|scale|blur|none","td":0.35}
{"type":"list","items":[…],"item":{template using {{item}}},"itemW":600,"itemH":64,"gap":12,"dir":"column|row|grid","cols":3,
 "steps":[{"at":1,"sort":"value desc"},{"at":2.5,"filter":"item.value > 20"},{"at":4,"order":["c","a","b"]},{"at":5,"reset":true}]}

GESTURES (scene "gestures", acting on layers by id; one after another unless "at")
{"do":"click","on":"#signup"} {"do":"type","into":"#email","text":"…","cps":14} {"do":"scroll","target":"#feed","by":420} {"do":"drag","from":"#card","to":"#done"}
{"do":"hover"|"move"|"show"|"hide"|"highlight"|"press"|"wait","on":…} {"do":"key","keys":"⌘K"} {"do":"zoom","on":"#chart","scale":1.6}|{"do":"zoom","reset":true} {"do":"state","target":"#panel","to":"error"}
Choreographies (kind "choreography", body {"steps":[…]}): {"p":"ui:fill-form","field":"#email","text":"…","button":"#go","speed":1.2}.
"cursor":{"style":"arrow|hand|dot|none","color","size","from":[x,y]|"#id","start":0.4,"linger":0.6,"hide":true}

CONNECTORS
{"type":"connector","from":"#a","to":"#b","route":"auto|elbow|curve|straight","fromSide":"auto|top|right|bottom|left","stroke","width","dash","arrow":"end|start|both|none",
 "signal":{"color","size":10,"every":0.6,"travel":1.2,"trail":0.15,"glow":true},"label":"HTTP"} — follows boxes that move, routes around other boxes.

TRANSITIONS WITH CONTINUITY (@core/base ≥1.1)
{"t":"core:morph"} (same ids in both scenes fly to their new place) · {"t":"core:expand","from":"#card"} (a card grows into the next scene) · {"t":"core:collapse","to":"#card"}

DATA (library @core/data)
{"type":"chart","kind":"bar|hbar|stack|line|area|pie|donut|scatter|race","data":[rows]|"asset:<id>"(JSON/CSV)|CSV text|{"A":3},"category":"month","value":"sales"|["a","b"],
 "series":"country","time":"year" (snapshots → morph / race),"steps":[{"at":0,"data":…}],"fields":{"x","y","r","label","group"} (scatter),
 "highlight":["Q4"],"prefix","suffix","decimals","compact","top":10,"grow":1.1,"stagger":0.05,"title","colors":[…],"w","h"}
{"type":"map","kind":"choropleth|dots|bubbles|routes","data":[{"country":"France","value":3}],"points":[{"at":"Paris"|[lon,lat],"label","value"}],
 "routes":[{"from":"France","to":"Japon","t":1,"d":1.2}],"focus":"Europe"|["France","Spain"]|[lon0,lat0,lon1,lat1],"zoom":[{"t":3,"focus":["Japan"]}],
 "projection":"naturalEarth|mercator|equirect|orthographic","spin":10,"time":"year"}   (country names in English or French)
{"type":"graph","nodes":["a",{"id":"b","label","group","at"}],"edges":[["a","b"],{"from","to","at","label","dash"}],"chain":true,
 "layout":"force|circle|grid|tree|layers|manual","directed":true,"nodeShape":"circle|rect|pill","pulses":[{"path":["a","b","c"],"at":2,"repeat":3,"every":0.8}],
 "highlight":[{"nodes":["b"],"at":3,"d":1}]}

SIMULATIONS (library @core/explain)
{"type":"sim","kind":"sort","algorithm":"bubble|insertion|selection|quick|merge","n":16|"values":[…]} · {"kind":"search","values":[sorted],"target":42}
{"kind":"pathfind","algorithm":"astar|dijkstra|bfs|dfs","grid":["S..#","..#G"]|{"cols","rows","random":0.25}}
{"kind":"pendulum|spring|projectile|orbit|particles|wave", parameters… each a number or keyframes [[s,v],…] e.g. "gravity":[[0,9.8],[3,1.6]]}
"speed","start","labels","words":{"comparisons":"comparaisons",…}, "settings":{…} (all parameters in one object).

3D (library @core/3d — scenes three:model-hero, model-turntable, model-exploded, character-intro, sand-disintegrate, sand-assemble, particle-morph…)
{"type":"three","objects":[{"shape":"box|roundedBox|sphere|cylinder|cone|torus|knot|plane|capsule|ring|card|device|image|model|icosahedron|octahedron|group",
  "size":[…],"position":[x,y,z],"rotation":[deg…],"scale","material":"glass|metal|matte|plastic|emissive|toon|wire"|{type,color,metalness,roughness,transmission,clearcoat,sheen,iridescence…},"color","image":"asset:<id>",
  "keys":{"position|rotation|scale|opacity":[[s,value,"ease"]]},"spin":[0,30,0],"float":0.1,"explode":[0,1,0],"children":[…],
  "alpha":"auto"|true|false,"alphaTest":0.5,"castShadow":false}],
 Transparent PNG/WebP: detected automatically — a "card" drops its slab, the picture is a cut-out with an image-shaped shadow; "shape":"image" = free cut-out.
 MODELS (mf_asset_put a .glb/.gltf/.fbx/.obj or a .zip with its textures; mf_model_inspect lists parts, materials, animations):
 {"shape":"model","src":"asset:<id>","fit":2 (largest side, scene units; false = file units),"center":"center|base|none",
  "animation":"Walk"|0|{"name","speed":1,"offset":0,"loop":true},"materials":{"<material name>"|"*":{color,roughness,metalness…}},
  "parts":{"<node name>":{"visible":false,"position","rotation","scale","keys":{position|rotation|scale offsets},"material":{…}}},
  "explodeParts":0.6 (exploded view of the model's meshes, timed by "explode"),"pbr":true (FBX/OBJ Phong → physically based)}
 PARTICLES on any object (model or shape): "effect":{"kind":"disintegrate|assemble|vortex|scatter|morph|pile","count":300000,"at":1,"d":2.5,
  "sweep":[1,0.25,0] (order the surface breaks up),"wind":[1.6,0.6,0],"turbulence":0.6,"gravity":0.4,"grain":0.012 (size),"floor":-1|false,
  "color":"texture"|"#hex","render":"points|grains" (grains = lit 3D grains, close-ups),"spread":0.6,"dissolve":true,"fade":true,"emissive":0.3 (glowing edge),
  "target":{object} (morph: where the grains go, position relative to the object),"axis":[0,1,0],"turns":1.5 (vortex)}
  Grains take the colours of the texture under them; "pile" is a real simulation (grains fall and heap up; count ≤ 400 000). Previews use fewer grains.
 "stack":{"items":[{"color","image"}],"shape","size","step":[0,0.3,0],"explode":[0,0.8,0]},"explode":{"at":1,"d":1.4,"amount":1},
 "lights":"studio|soft|dramatic|neon"|[{type,position,intensity,color,castShadow}],"camera":{"fov","position","target","keys","orbit":{"speed","radius","height","from"},"dolly":{"from","to"},"shake"},
 "ground":{"y":-1,"color"}|{"opacity":0.35,"shadow":true},"fog":["#000",5,18],"bg",
 LOOK: "environment":0.6|{"src":"asset:<.hdr/.exr>","intensity":1,"rotation":30,"background":true|0.4 (blur)},"toneMapping":"aces|agx|neutral|none","exposure":1,
  "shadows":true|"soft"|"vsm"|"basic","contactShadow":true|{"opacity":0.6,"blur":2.5,"y":-1,"far":1.5},
  "post":{"bloom":{strength,radius,threshold}|0.5,"ao":{radius,intensity}|true,"dof":{"focus":6,"aperture":0.6,"maxblur":0.01,"keys":[[s,focus]]},"vignette":0.4,"grain":0.06,"chromatic":0.002},
  "motionBlur":{"samples":8,"shutter":0.5},"quality":"auto|draft|final|pathtrace","samples":256 (pathtrace: GPU path tracing for hero shots; particles are hidden),
  "cache":true (render the 3D shot once to a transparent video and reuse it). Previews are draft (no AO/DOF/blur, fewer grains); mf_preview {"final":true} shows the real look.

CAPTURES (real interfaces, recorded with mf_capture)
{"type":"capture","src":"cap_<id>","w":1500,"frame":"browser|none","cursor":true|{"style","color"},"zoom":1.4,"cps":14,"hold":0.8,"fit":true}

AUDIO (mixed into renders and preview clips; loudness ≈ -16 LUFS, limiter, music ducks under voice)
"music":{"src":"asset:<id>","volume":0.8,"fadeIn":0.4,"fadeOut":1.5,"trim":0,"duck":8,"snap":"beat|bar|phrase|hit"|{"to":"bar","end":true,"tolerance":0.6}}
"audio":[{"src":"asset:<id>"|"whoosh"|https,"kind":"music|sfx|voice","at":"@scene:2+0.3"|"@click:1"|"@type:1"|"@beat:8"|"@bar:4"|"@hit:1"|"@end-2"|seconds,
          "volume":0.8|"-6dB","d","fadeIn","fadeOut","trim","rate","loop"},
         {"src":"click","on":"clicks|typing|transitions|drags|scenes|states|beats|downbeats|hits","every":2,"offset":-0.05}]
Built-in sounds: whoosh swoosh swipe click tick typing pop impact rise ding success error glitch bass. Transitions take "sfx":"whoosh".
Music is analysed (tempo, beats, bars, hits) when uploaded: mf_audio shows it.

PRODUCTION TOOLS
mf_check (visual QA) · mf_storyboard (intents, rhythm, repetition, reorder) · mf_variants (directions/pace/framing/format side by side) ·
mf_adapt (other formats + checks) · mf_template (one render per data row) · mf_edit (boxes at time t, move/retext/retime → source JSON) ·
mf_preview {scene|transition|range|focus|solo|clip} · mf_capture · mf_audio.

LIBRARIES
Yours: @<agent-id>/<name> (mf_library_create). Drafts are usable at once ("@me/lib@draft"); mf_library_publish makes an immutable semver version.
Each composition revision pins library versions (lockfile); mf_patch {relock:true} picks up newer versions.`;
