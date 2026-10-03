/**
 * Global art direction: one composition, several looks.
 *   "direction": "dir:cinematic" | {"p": "dir:tech-neon", "accent": "#00e5ff"} | {inline body}
 * A direction preset (kind "direction") body may set:
 *   theme, tokens, fonts, pace (×scene durations), animScale (×animation durations),
 *   transition | transitions (inserted between scenes that have none), sceneDefaults (params the
 *   scenes leave out: backdrop, exit…), overlays (layers on top of every scene: grain, vignette,
 *   letterbox…), sfx ({"transitions": "whoosh", "clicks": "click"}).
 * The composition's own theme/tokens/transitions always win.
 */
import { isObj } from '../../core/util';
import type { Tokens } from '../bind';
import type { AliasCtx, DirectionSpec, Session } from '../compile';
import { hooks } from '../registry';

const FIELDS = ['theme', 'tokens', 'fonts', 'pace', 'animScale', 'transition', 'transitions', 'sceneDefaults', 'overlays', 'sfx', 'summary', 'note'];

function fromBody(S: Session, id: string, body: Record<string, any>, actx: AliasCtx, path: string): DirectionSpec {
  for (const k of Object.keys(body)) if (!FIELDS.includes(k)) S.warn(`${path}.${k}`, `unknown direction field "${k}" (${FIELDS.slice(0, -2).join(', ')})`);
  const spec: DirectionSpec = { id, actx };
  if (body.theme !== undefined) spec.theme = body.theme;
  if (isObj(body.tokens)) spec.tokens = body.tokens as Tokens;
  if (Array.isArray(body.fonts)) spec.fonts = body.fonts as any;
  if (body.pace !== undefined) {
    const p = Number(body.pace);
    if (!(p > 0.2 && p < 5)) S.err(`${path}.pace`, 'pace is a multiplier of scene durations between 0.2 and 5 (0.8 = snappier)');
    else spec.pace = p;
  }
  if (body.animScale !== undefined) {
    const a = Number(body.animScale);
    if (!(a > 0.1 && a < 5)) S.err(`${path}.animScale`, 'animScale multiplies animation durations (0.1–5)');
    else spec.animScale = a;
  }
  const tr = (t: unknown, p: string) => {
    if (t === null || t === false || t === 'none') return null;
    if (typeof t === 'string') return { t, d: 0.6 };
    if (isObj(t) && typeof t.t === 'string') return t;
    S.err(p, 'a transition is "core:crossfade" or {"t": "core:whip-pan", "d": 0.5, …}');
    return null;
  };
  if (body.transition !== undefined) spec.transition = tr(body.transition, `${path}.transition`);
  if (Array.isArray(body.transitions)) spec.transitions = body.transitions.map((t: unknown, i: number) => tr(t, `${path}.transitions[${i}]`)).filter(Boolean) as Record<string, any>[];
  if (isObj(body.sceneDefaults)) spec.sceneDefaults = body.sceneDefaults;
  if (Array.isArray(body.overlays)) spec.overlays = body.overlays;
  if (isObj(body.sfx)) spec.sfx = Object.fromEntries(Object.entries(body.sfx).map(([k, v]) => [k, String(v)]));
  return spec;
}

hooks.direction = (S, ref, actx) => {
  // inline direction
  if (isObj(ref) && ref.p === undefined && ref.use === undefined) return fromBody(S, 'inline', S.bind(ref, S.base(0), 'direction') as Record<string, any>, actx, 'direction');
  const entry = typeof ref === 'string' ? { p: ref } : isObj(ref) ? { ...ref, p: ref.p ?? ref.use } : null;
  if (!entry || typeof entry.p !== 'string') {
    S.err('direction', 'direction is "dir:cinematic", {"p": "dir:tech-neon", …params} or an inline {theme, pace, transition, overlays, sfx…}');
    return null;
  }
  const { p, use: _u, ...params } = entry as Record<string, any>;
  const u = S.expand(p, params, actx, 'direction', ['direction']);
  if (!u) return null;
  // overlays are bound per scene (they may use dur), with the direction's params in scope
  const body = S.bind(u.body, { ...S.base(0), ...u.values }, `direction(${u.hit.id})`, new Set(['overlays'])) as Record<string, any>;
  const spec = fromBody(S, u.hit.id, body, u.bodyCtx, `direction(${u.hit.id})`);
  spec.values = u.values;
  return spec;
};
