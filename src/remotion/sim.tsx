import React from 'react';
import { useVideoConfig } from 'remotion';
import { ease } from '../ir/easing';
import { mixColor, withAlpha, type ChannelState } from '../ir/evaluate';
import type { IRLayer } from '../ir/types';
import type { SimIR } from '../dsl/features/sim';

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const W = (ir: SimIR, k: string, d: string) => ir.words[k] ?? d;

function Readout({ ir, x, y, items, anchor = 'start' }: { ir: SimIR; x: number; y: number; items: string[]; anchor?: 'start' | 'end' | 'middle' }) {
  if (!ir.labels) return null;
  return (
    <text x={x} y={y} textAnchor={anchor} fontFamily={ir.style.font} fontSize={ir.style.size * 0.9} fill={ir.style.muted}>
      {items.map((t, i) => (
        <tspan key={i} dx={i ? ir.style.size * 1.2 : 0} fontWeight={i === 0 ? 700 : 500} fill={i === 0 ? ir.style.fg : ir.style.muted}>
          {t}
        </tspan>
      ))}
    </text>
  );
}

function SortView({ ir, lf }: { ir: SimIR; lf: number }) {
  const steps = ir.steps!;
  const pos = (lf - ir.start) / ir.stepFrames!;
  const k = Math.max(0, Math.min(steps.length, Math.floor(pos)));
  const frac = clamp01(pos - Math.floor(pos));
  const a = [...ir.values!];
  const order = a.map((_, i) => i); // order[slot] = bar id
  const done = new Set<number>();
  let cmps = 0;
  let swaps = 0;
  for (let s = 0; s < k; s++) {
    const st = steps[s];
    if (st.op === 'swap') {
      [a[st.i], a[st.j]] = [a[st.j], a[st.i]];
      [order[st.i], order[st.j]] = [order[st.j], order[st.i]];
      swaps++;
    } else if (st.op === 'cmp') cmps++;
    else if (st.op === 'done') done.add(st.i);
  }
  const cur = pos >= 0 && k < steps.length ? steps[k] : null;
  const n = a.length;
  const s = ir.style.size;
  const top = ir.labels ? s * 2.2 : 0;
  const slot = ir.w / n;
  const max = Math.max(...a);
  const barH = (v: number) => (v / max) * (ir.h - top - s * (n <= 24 ? 1.6 : 0.4));
  const els: React.ReactNode[] = [];
  const slotOf = new Map<number, number>();
  order.forEach((id, sl) => slotOf.set(id, sl));
  for (let sl = 0; sl < n; sl++) {
    const id = order[sl];
    let x = sl * slot;
    let lift = 0;
    let col = ir.colors[0];
    if (cur && (cur.op === 'cmp' || cur.op === 'swap') && (sl === cur.i || sl === cur.j)) {
      col = cur.op === 'swap' ? ir.colors[1 % ir.colors.length] : mixColor(ir.colors[0], '#ffffff', 0.55);
      if (cur.op === 'swap') {
        const e = ease('inOut', frac);
        const other = sl === cur.i ? cur.j : cur.i;
        x = (sl + (other - sl) * e) * slot;
        lift = Math.sin(Math.PI * e) * s * 0.6 * (sl === cur.i ? 1 : -1);
      }
    }
    if (cur && cur.op === 'pivot' && sl === cur.i) col = ir.colors[3 % ir.colors.length];
    if (done.has(sl)) col = ir.colors[2 % ir.colors.length];
    const v = a[sl];
    const h = barH(v);
    els.push(<rect key={`b${id}`} x={x + slot * 0.1} y={ir.h - h - lift - (n <= 24 ? s * 1.4 : 0)} width={slot * 0.8} height={h} rx={Math.min(8, slot * 0.2)} fill={col} />);
    if (n <= 24)
      els.push(
        <text key={`t${id}`} x={x + slot / 2} y={ir.h - 2} textAnchor="middle" fontFamily={ir.style.font} fontSize={Math.min(s * 0.8, slot * 0.5)} fill={ir.style.muted}>
          {v}
        </text>,
      );
  }
  els.push(<Readout key="ro" ir={ir} x={0} y={s} items={[`${ir.algorithm} sort`, `${W(ir, 'comparisons', 'comparisons')} ${cmps}`, `${W(ir, 'swaps', 'swaps')} ${swaps}`]} />);
  void slotOf;
  return <>{els}</>;
}

function SearchView({ ir, lf }: { ir: SimIR; lf: number }) {
  const steps = ir.steps!;
  const pos = (lf - ir.start) / ir.stepFrames!;
  const k = Math.max(-1, Math.min(steps.length - 1, Math.floor(pos)));
  const vals = ir.values!;
  const n = vals.length;
  const s = ir.style.size;
  const cell = Math.min(ir.w / n, s * 3.2);
  const x0 = (ir.w - cell * n) / 2;
  const y = ir.h / 2 - cell / 2;
  let lo = 0;
  let hi = n - 1;
  let mid = -1;
  let found = -1;
  let missing = false;
  for (let i = 0; i <= k; i++) {
    const st = steps[i];
    if (st.op === 'range') ({ lo, hi, mid } = st);
    if (st.op === 'found') found = st.mid;
    if (st.op === 'missing') missing = true;
  }
  const els: React.ReactNode[] = [];
  vals.forEach((v, i) => {
    const inRange = i >= lo && i <= hi;
    const fill = i === found ? ir.colors[2 % ir.colors.length] : i === mid ? ir.colors[1 % ir.colors.length] : inRange ? withAlpha(ir.colors[0], 0.85) : withAlpha(ir.style.muted, 0.18);
    els.push(<rect key={`c${i}`} x={x0 + i * cell + 3} y={y} width={cell - 6} height={cell} rx={8} fill={fill} />);
    els.push(
      <text key={`v${i}`} x={x0 + i * cell + cell / 2} y={y + cell / 2 + s * 0.33} textAnchor="middle" fontFamily={ir.style.font} fontWeight={700} fontSize={Math.min(s, cell * 0.4)} fill={inRange || i === found ? ir.style.fg : ir.style.muted}>
        {v}
      </text>,
    );
  });
  if (k >= 0) {
    const bx = (i: number) => x0 + i * cell + cell / 2;
    els.push(<path key="range" d={`M${x0 + lo * cell + 3},${y + cell + 14}h${(hi - lo + 1) * cell - 6}`} stroke={ir.colors[0]} strokeWidth={4} strokeLinecap="round" />);
    if (mid >= 0)
      els.push(
        <text key="mid" x={bx(mid)} y={y - s * 0.6} textAnchor="middle" fontFamily={ir.style.font} fontSize={s * 0.85} fill={ir.colors[1 % ir.colors.length]} fontWeight={700}>
          ▼ mid
        </text>,
      );
  }
  els.push(<Readout key="ro" ir={ir} x={0} y={s} items={[`${W(ir, 'target', 'target')} ${ir.target}`, `${W(ir, 'steps', 'steps')} ${Math.max(0, steps.slice(0, k + 1).filter((x: any) => x.op === 'range').length)}`, found >= 0 ? `✓ ${W(ir, 'found', 'found')}` : missing ? `✗ ${W(ir, 'missing', 'not found')}` : '']} />);
  return <>{els}</>;
}

function PathView({ ir, lf }: { ir: SimIR; lf: number }) {
  const g = ir.grid!;
  const [visits, path] = ir.steps as [number[], number[]];
  const pos = (lf - ir.start) / ir.stepFrames!;
  const s = ir.style.size;
  const top = ir.labels ? s * 2 : 0;
  const cell = Math.min(ir.w / g.cols, (ir.h - top) / g.rows);
  const x0 = (ir.w - cell * g.cols) / 2;
  const y0 = top + (ir.h - top - cell * g.rows) / 2;
  const walls = new Set(g.walls);
  const nVis = Math.max(0, Math.min(visits.length, Math.floor(pos)));
  const visitedAt = new Map<number, number>();
  visits.forEach((v, i) => visitedAt.set(v, i));
  const pathP = Math.max(0, (pos - visits.length) / 0.6);
  const els: React.ReactNode[] = [];
  for (let i = 0; i < g.cols * g.rows; i++) {
    const x = x0 + (i % g.cols) * cell;
    const y = y0 + Math.floor(i / g.cols) * cell;
    let fill = withAlpha(ir.style.muted, 0.1);
    if (walls.has(i)) fill = ir.style.muted;
    const va = visitedAt.get(i);
    if (va !== undefined && va < nVis) {
      const age = clamp01((nVis - va) / 12);
      fill = mixColor(ir.colors[1 % ir.colors.length], withAlpha(ir.colors[0], 0.45), age);
    }
    els.push(<rect key={i} x={x + 1.5} y={y + 1.5} width={cell - 3} height={cell - 3} rx={cell * 0.18} fill={fill} />);
  }
  if (pathP > 0 && path.length) {
    const shown = path.slice(0, Math.max(1, Math.ceil(pathP)));
    const pts = shown.map((i) => `${x0 + (i % g.cols) * cell + cell / 2},${y0 + Math.floor(i / g.cols) * cell + cell / 2}`).join(' ');
    els.push(<polyline key="path" points={pts} fill="none" stroke={ir.colors[2 % ir.colors.length]} strokeWidth={cell * 0.28} strokeLinecap="round" strokeLinejoin="round" />);
  }
  const mark = (i: number, label: string, col: string) => (
    <g key={label}>
      <rect x={x0 + (i % g.cols) * cell + 1.5} y={y0 + Math.floor(i / g.cols) * cell + 1.5} width={cell - 3} height={cell - 3} rx={cell * 0.18} fill={col} />
      <text x={x0 + (i % g.cols) * cell + cell / 2} y={y0 + Math.floor(i / g.cols) * cell + cell / 2 + cell * 0.17} textAnchor="middle" fontFamily={ir.style.font} fontWeight={800} fontSize={cell * 0.5} fill={ir.style.bg}>
        {label}
      </text>
    </g>
  );
  els.push(mark(g.start, 'S', ir.colors[2 % ir.colors.length]));
  els.push(mark(g.goal, 'G', ir.colors[3 % ir.colors.length]));
  els.push(<Readout key="ro" ir={ir} x={x0} y={s} items={[ir.algorithm === 'astar' ? 'A*' : ir.algorithm!.toUpperCase(), `${W(ir, 'visited', 'visited')} ${nVis}`, pathP > 0 && path.length ? `${W(ir, 'path', 'path')} ${path.length - 1}` : '']} />);
  return <>{els}</>;
}

function PhysicsView({ ir, lf }: { ir: SimIR; lf: number }) {
  const { fps } = useVideoConfig();
  const f = Math.max(0, Math.min(ir.states!.length - 1, Math.round(lf - ir.start)));
  const st = ir.states![f];
  const s = ir.style.size;
  const els: React.ReactNode[] = [];
  const c0 = ir.colors[0];
  const c1 = ir.colors[1 % ir.colors.length];
  const info = ir.info ?? {};
  const t = Math.max(0, (lf - ir.start) / fps);
  if (ir.kind === 'pendulum') {
    const count = info.count as number;
    const px = ir.w / 2;
    const py = s;
    const Lpx = ir.h - s * 3;
    els.push(<line key="ceil" x1={ir.w * 0.2} x2={ir.w * 0.8} y1={py} y2={py} stroke={ir.style.muted} strokeWidth={4} />);
    for (let i = 0; i < count; i++) {
      const L = Lpx * (count === 1 ? 1 : (info.lens as number[])[i]);
      const th = st[i];
      const ox = count === 1 ? px : ir.w * 0.15 + (ir.w * 0.7 * i) / Math.max(1, count - 1);
      const bx = ox + Math.sin(th) * L;
      const by = py + Math.cos(th) * L;
      const col = ir.colors[i % ir.colors.length];
      if (count === 1) {
        // trail of the last positions
        const pts: string[] = [];
        for (let k = Math.max(0, f - 20); k <= f; k++) {
          const a = ir.states![k][0];
          pts.push(`${ox + Math.sin(a) * L},${py + Math.cos(a) * L}`);
        }
        els.push(<polyline key="trail" points={pts.join(' ')} fill="none" stroke={withAlpha(col, 0.35)} strokeWidth={s * 0.5} strokeLinecap="round" />);
      }
      els.push(<line key={`r${i}`} x1={ox} y1={py} x2={bx} y2={by} stroke={ir.style.fg} strokeWidth={3} />);
      els.push(<circle key={`b${i}`} cx={bx} cy={by} r={count === 1 ? s * 1.4 : s * 0.8} fill={col} />);
    }
    if (count === 1) els.push(<Readout key="ro" ir={ir} x={0} y={ir.h - s * 0.4} items={[`θ ${((st[0] * 180) / Math.PI).toFixed(0)}°`, `t ${t.toFixed(1)} s`]} />);
  } else if (ir.kind === 'spring') {
    const x = st[0];
    const ax = s * 2;
    const cy = ir.h / 2;
    const rest = ir.w * 0.55;
    const ampPx = ir.w * 0.3;
    const bx = rest + x * ampPx / Math.max(1, Math.abs(info.x0 ?? 1));
    const coils = 12;
    const pts: string[] = [`${ax},${cy}`];
    for (let i = 1; i < coils * 2; i++) pts.push(`${ax + ((bx - s * 2 - ax) * i) / (coils * 2)},${cy + (i % 2 ? -1 : 1) * s * 0.9}`);
    pts.push(`${bx - s * 2},${cy}`);
    els.push(<line key="wall" x1={ax} x2={ax} y1={cy - s * 3} y2={cy + s * 3} stroke={ir.style.muted} strokeWidth={6} />);
    els.push(<polyline key="spring" points={pts.join(' ')} fill="none" stroke={ir.style.fg} strokeWidth={3} strokeLinejoin="round" />);
    els.push(<rect key="mass" x={bx - s * 2} y={cy - s * 2} width={s * 4} height={s * 4} rx={s * 0.5} fill={c0} />);
    els.push(<line key="rest" x1={rest} x2={rest} y1={cy + s * 3} y2={cy + s * 4} stroke={ir.style.muted} strokeWidth={2} strokeDasharray="6 6" />);
    // x(t) plot underneath
    const plotY = ir.h - s * 1.5;
    const pts2: string[] = [];
    const span = Math.min(ir.states!.length, Math.round(fps * 6));
    for (let k = Math.max(0, f - span); k <= f; k++) pts2.push(`${ir.w - ((f - k) / span) * ir.w},${plotY - (ir.states![k][0] / Math.max(1, Math.abs(info.x0 ?? 1))) * s * 1.2}`);
    els.push(<polyline key="plot" points={pts2.join(' ')} fill="none" stroke={c1} strokeWidth={3} />);
    els.push(<Readout key="ro" ir={ir} x={0} y={s} items={[`x ${x.toFixed(2)}`, `v ${st[1].toFixed(2)}`]} />);
  } else if (ir.kind === 'projectile') {
    const count = info.count as number;
    const sx = (ir.w - s * 4) / Math.max(1e-6, info.maxX);
    const sy = (ir.h - s * 4) / Math.max(1e-6, info.maxY);
    const sc = Math.min(sx, sy);
    const X = (v: number) => s * 2 + v * sc;
    const Y = (v: number) => ir.h - s * 1.5 - v * sc;
    els.push(<line key="ground" x1={0} x2={ir.w} y1={Y(0)} y2={Y(0)} stroke={ir.style.muted} strokeWidth={3} />);
    for (let i = 0; i < count; i++) {
      const col = ir.colors[i % ir.colors.length];
      const pts: string[] = [];
      for (let k = 0; k <= f; k += 1) pts.push(`${X(ir.states![k][i * 2])},${Y(ir.states![k][i * 2 + 1])}`);
      els.push(<polyline key={`p${i}`} points={pts.join(' ')} fill="none" stroke={withAlpha(col, 0.6)} strokeWidth={3} strokeDasharray="2 10" strokeLinecap="round" />);
      els.push(<circle key={`b${i}`} cx={X(st[i * 2])} cy={Y(st[i * 2 + 1])} r={s * 0.6} fill={col} />);
    }
    els.push(<Readout key="ro" ir={ir} x={0} y={s} items={[`t ${t.toFixed(1)} s`, `x ${st[0].toFixed(1)} m`, `y ${st[1].toFixed(1)} m`]} />);
  } else if (ir.kind === 'orbit') {
    const cx = ir.w / 2;
    const cy = ir.h / 2;
    const sc = (Math.min(ir.w, ir.h) / 2 - s) / (info.maxR as number);
    els.push(<circle key="sun" cx={cx} cy={cy} r={s * 1.6} fill={ir.colors[1 % ir.colors.length]} />);
    els.push(<circle key="sunglow" cx={cx} cy={cy} r={s * 3} fill={withAlpha(ir.colors[1 % ir.colors.length], 0.15)} />);
    for (let i = 0; i < (info.count as number); i++) {
      const col = ir.colors[(i + 2) % ir.colors.length];
      if (info.trail) {
        const pts: string[] = [];
        for (let k = Math.max(0, f - Math.round(fps * 4)); k <= f; k += 2) pts.push(`${cx + ir.states![k][i * 2] * sc},${cy - ir.states![k][i * 2 + 1] * sc}`);
        els.push(<polyline key={`t${i}`} points={pts.join(' ')} fill="none" stroke={withAlpha(col, 0.45)} strokeWidth={3} />);
      }
      els.push(<circle key={`b${i}`} cx={cx + st[i * 2] * sc} cy={cy - st[i * 2 + 1] * sc} r={s * 0.6} fill={col} />);
    }
  } else if (ir.kind === 'particles') {
    els.push(<rect key="box" x={0} y={0} width={ir.w} height={ir.h} fill="none" stroke={ir.style.muted} strokeWidth={3} rx={12} />);
    const n = info.count as number;
    const prev = ir.states![Math.max(0, f - 1)];
    for (let i = 0; i < n; i++) {
      const x = st[i * 2] * (ir.w - 20) + 10;
      const y = (1 - st[i * 2 + 1]) * (ir.h - 20) + 10;
      const sp = Math.hypot(st[i * 2] - prev[i * 2], st[i * 2 + 1] - prev[i * 2 + 1]) * fps;
      els.push(<circle key={i} cx={x} cy={y} r={Math.max(4, s * 0.35)} fill={mixColor(c0, c1, clamp01(sp / 0.6))} />);
    }
  } else if (ir.kind === 'wave') {
    const [ph, amp, wl, damp] = st;
    const sources = info.sources as number;
    const cy = ir.h / 2;
    const A = (ir.h / 2 - s) * Math.min(1, Math.abs(amp) / 1.2) * Math.sign(amp || 1);
    const k = (2 * Math.PI) / Math.max(0.05, wl * ir.w * 0.25);
    const pts: string[] = [];
    for (let x = 0; x <= ir.w; x += 4) {
      let y = 0;
      for (let si = 0; si < sources; si++) {
        const src = sources === 1 ? 0 : (ir.w * (si + 1)) / (sources + 1);
        const d = Math.abs(x - src);
        y += Math.sin(ph - k * d) * Math.exp(-damp * (d / ir.w) * 4);
      }
      pts.push(`${x},${cy - (y / sources) * A}`);
    }
    els.push(<line key="axis" x1={0} x2={ir.w} y1={cy} y2={cy} stroke={ir.style.grid} strokeWidth={2} />);
    els.push(<polyline key="w" points={pts.join(' ')} fill="none" stroke={c0} strokeWidth={5} strokeLinejoin="round" />);
  }
  return <>{els}</>;
}

export const SimView: React.FC<{ layer: IRLayer; lf: number; st?: ChannelState }> = ({ layer, lf }) => {
  const ir = layer.data as SimIR | undefined;
  if (!ir) return null;
  let body: React.ReactNode = null;
  if (ir.kind === 'sort') body = <SortView ir={ir} lf={lf} />;
  else if (ir.kind === 'search') body = <SearchView ir={ir} lf={lf} />;
  else if (ir.kind === 'pathfind') body = <PathView ir={ir} lf={lf} />;
  else body = <PhysicsView ir={ir} lf={lf} />;
  return (
    <svg width={layer.w ?? ir.w} height={layer.h ?? ir.h} viewBox={`0 0 ${ir.w} ${ir.h}`} style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }}>
      {body}
    </svg>
  );
};
