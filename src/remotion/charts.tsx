import React, { useMemo } from 'react';
import { useVideoConfig } from 'remotion';
import { geoEquirectangular, geoGraticule10, geoInterpolate, geoMercator, geoNaturalEarth1, geoOrthographic, geoPath, type GeoProjection } from 'd3-geo';
import { feature } from 'topojson-client';
import worldTopo from 'world-atlas/countries-110m.json';
import { ease } from '../ir/easing';
import { mixColor, withAlpha, type ChannelState } from '../ir/evaluate';
import { fmtValue, type ChartIR, type GraphIR, type MapIR } from '../ir/dataviz';
import type { IRLayer } from '../ir/types';

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Snapshot interpolation: values shown at local frame lf. */
function snapAt<T>(keys: number[], morph: number, lf: number, continuous: boolean, mix: (a: T, b: T, t: number) => T, sets: T[]): { v: T; k: number; t: number } {
  let k = 0;
  while (k + 1 < keys.length && keys[k + 1] <= lf) k++;
  if (continuous) {
    if (k + 1 >= keys.length) return { v: sets[k], k, t: 0 };
    const t = clamp01((lf - keys[k]) / Math.max(1, keys[k + 1] - keys[k]));
    return { v: mix(sets[k], sets[k + 1], t), k, t };
  }
  if (k === 0) return { v: sets[0], k, t: 1 };
  const t = ease('inOut', (lf - keys[k]) / Math.max(1, morph));
  return { v: mix(sets[k - 1], sets[k], t), k, t };
}

const mixVals = (a: number[][], b: number[][], t: number) => a.map((s, i) => s.map((v, j) => lerp(v, b[i]?.[j] ?? v, t)));

// ---------------------------------------------------------------- charts
const Text: React.FC<React.SVGProps<SVGTextElement> & { ir: { style: ChartIR['style'] }; size?: number; weight?: number; color?: string }> = ({ ir, size, weight, color, children, ...rest }) => (
  <text fontFamily={ir.style.font} fontSize={size ?? ir.style.size} fontWeight={weight ?? 500} fill={color ?? ir.style.fg} {...rest}>
    {children}
  </text>
);

function Legend({ ir, x, y }: { ir: ChartIR; x: number; y: number }) {
  let cx = x;
  const s = ir.style.size;
  return (
    <g>
      {ir.series.map((se) => {
        const el = (
          <g key={se.name} transform={`translate(${cx},${y})`}>
            <rect x={0} y={-s * 0.62} width={s * 0.8} height={s * 0.8} rx={s * 0.2} fill={se.color} />
            <Text ir={ir} x={s * 1.1} y={0} size={s * 0.9} color={ir.style.fg}>
              {se.name}
            </Text>
          </g>
        );
        cx += s * 1.6 + se.name.length * s * 0.55 + s;
        return el;
      })}
    </g>
  );
}

function CartesianChart({ ir, lf }: { ir: ChartIR; lf: number }) {
  const [pt, pr, pb, pl] = ir.pad;
  const x0 = pl;
  const x1 = ir.w - pr;
  const y0 = pt;
  const y1 = ir.h - pb;
  const horizontal = ir.kind === 'hbar';
  const { v: vals } = snapAt(ir.keys, ir.morph, lf, false, mixVals, ir.values);
  const [d0, d1] = ir.domain;
  const vScale = (v: number) => (horizontal ? x0 + ((v - d0) / (d1 - d0 || 1)) * (x1 - x0) : y1 - ((v - d0) / (d1 - d0 || 1)) * (y1 - y0));
  const zero = vScale(Math.max(d0, Math.min(d1, 0)));
  const nC = ir.cats.length;
  const nS = ir.series.length;
  const band = ((horizontal ? y1 - y0 : x1 - x0) / Math.max(1, nC));
  const inner = band * (1 - ir.barGap);
  const grow = (i: number) => ease(ir.ease, (lf - ir.grow[0] - i * ir.stagger) / Math.max(1, ir.grow[1] - ir.grow[0]));
  const axisP = clamp01(lf / Math.max(1, ir.grow[1] * 0.5));
  const s = ir.style.size;
  const els: React.ReactNode[] = [];
  // grid + value axis
  if (ir.show.grid || ir.show.axis)
    ir.ticks.forEach((t, i) => {
      const p = vScale(t);
      if (ir.show.grid)
        els.push(horizontal ? <line key={`g${i}`} x1={p} x2={p} y1={y0} y2={y1} stroke={ir.style.grid} strokeWidth={1.5} opacity={axisP} /> : <line key={`g${i}`} x1={x0} x2={x1} y1={p} y2={p} stroke={ir.style.grid} strokeWidth={1.5} opacity={axisP} />);
      if (ir.show.axis)
        els.push(
          horizontal ? (
            <Text key={`t${i}`} ir={ir} x={p} y={y1 + s * 1.3} textAnchor="middle" size={s * 0.8} color={ir.style.muted} opacity={axisP}>
              {fmtValue(t, { ...ir.fmt, decimals: ir.fmt.decimals ?? (Number.isInteger(t) ? 0 : undefined) })}
            </Text>
          ) : (
            <Text key={`t${i}`} ir={ir} x={x0 - s * 0.5} y={p + s * 0.3} textAnchor="end" size={s * 0.8} color={ir.style.muted} opacity={axisP}>
              {fmtValue(t, { ...ir.fmt, decimals: ir.fmt.decimals ?? (Number.isInteger(t) ? 0 : undefined) })}
            </Text>
          ),
        );
    });
  if (ir.show.axis) els.push(horizontal ? <line key="ax" x1={zero} x2={zero} y1={y0} y2={y1} stroke={ir.style.muted} strokeWidth={2} opacity={axisP} /> : <line key="ax" x1={x0} x2={x1} y1={zero} y2={zero} stroke={ir.style.muted} strokeWidth={2} opacity={axisP} />);
  const dim = (cat: string) => (ir.highlight && !ir.highlight.includes(cat) ? 0.3 : 1);
  if (ir.kind === 'line' || ir.kind === 'area') {
    const xAt = (i: number) => x0 + (nC === 1 ? (x1 - x0) / 2 : (i / (nC - 1)) * (x1 - x0));
    const p = grow(0);
    const clipW = (x1 - x0 + 40) * p;
    const id = `clip${Math.round(ir.w)}x${Math.round(ir.h)}${ir.series.length}`;
    els.push(
      <defs key="defs">
        <clipPath id={id}>
          <rect x={x0 - 20} y={0} width={clipW} height={ir.h} />
        </clipPath>
      </defs>,
    );
    vals.forEach((sv, si) => {
      const pts = sv.map((v, i) => [xAt(i), vScale(v)] as const);
      const d = pts.map((q, i) => `${i ? 'L' : 'M'}${q[0].toFixed(1)},${q[1].toFixed(1)}`).join('');
      const col = ir.series[si].color;
      if (ir.kind === 'area') els.push(<path key={`a${si}`} d={`${d}L${pts[pts.length - 1][0]},${zero}L${pts[0][0]},${zero}Z`} fill={withAlpha(col, 0.22)} clipPath={`url(#${id})`} />);
      els.push(<path key={`l${si}`} d={d} fill="none" stroke={col} strokeWidth={Math.max(3, s * 0.2)} strokeLinejoin="round" strokeLinecap="round" clipPath={`url(#${id})`} />);
      pts.forEach((q, i) => {
        const shown = clamp01((x0 - 20 + clipW - q[0]) / 30);
        if (shown <= 0) return;
        els.push(<circle key={`d${si}.${i}`} cx={q[0]} cy={q[1]} r={Math.max(4, s * 0.28) * shown} fill={col} stroke={ir.style.bg} strokeWidth={3} opacity={dim(ir.cats[i])} />);
      });
      // value at the head of the line
      if (ir.show.values) {
        const head = Math.min(nC - 1, Math.max(0, Math.floor(((clipW - 20) / (x1 - x0 || 1)) * (nC - 1) + 1e-6)));
        const q = pts[head];
        els.push(
          <Text key={`hv${si}`} ir={ir} x={q[0]} y={q[1] - s * 0.8} textAnchor="middle" weight={700} size={ir.style.valueSize} color={col}>
            {fmtValue(sv[head], ir.fmt)}
          </Text>,
        );
      }
    });
    if (ir.show.labels) {
      const every = Math.max(1, Math.ceil((nC * s * 3.2) / (x1 - x0)));
      ir.cats.forEach((c, i) => {
        if (i % every && i !== nC - 1) return;
        els.push(
          <Text key={`c${i}`} ir={ir} x={xAt(i)} y={y1 + s * 1.4} textAnchor="middle" size={s * 0.85} color={ir.style.muted} opacity={axisP}>
            {c}
          </Text>,
        );
      });
    }
  } else {
    // bars (grouped or stacked)
    const stacked = ir.kind === 'stack';
    for (let ci = 0; ci < nC; ci++) {
      const g = grow(ci);
      const bandStart = (horizontal ? y0 : x0) + ci * band + (band - inner) / 2;
      let acc = 0;
      for (let si = 0; si < nS; si++) {
        const v = vals[si][ci] * g;
        const col = ir.catColors?.[ci] ?? ir.series[si].color;
        const thick = stacked ? inner : inner / nS;
        const off = stacked ? 0 : si * thick;
        const a = stacked ? vScale(acc) : zero;
        const b = stacked ? vScale(acc + v) : vScale(v);
        acc += stacked ? v : 0;
        const r = Math.min(ir.radius, thick / 2);
        if (horizontal) {
          const xx = Math.min(a, b);
          const ww = Math.abs(b - a);
          els.push(<rect key={`b${ci}.${si}`} x={xx} y={bandStart + off} width={ww} height={thick * 0.94} rx={r} fill={col} opacity={dim(ir.cats[ci])} />);
          if (ir.show.values && !stacked && g > 0.05)
            els.push(
              <Text key={`v${ci}.${si}`} ir={ir} x={b + s * 0.4} y={bandStart + off + thick * 0.47 + ir.style.valueSize * 0.35} weight={700} size={ir.style.valueSize} opacity={clamp01(g * 2 - 0.4)}>
                {fmtValue(vals[si][ci] * g, ir.fmt)}
              </Text>,
            );
        } else {
          const yy = Math.min(a, b);
          const hh = Math.abs(b - a);
          els.push(<rect key={`b${ci}.${si}`} x={bandStart + off} y={yy} width={thick * 0.94} height={hh} rx={r} fill={col} opacity={dim(ir.cats[ci])} />);
          if (ir.show.values && !stacked && g > 0.05)
            els.push(
              <Text key={`v${ci}.${si}`} ir={ir} x={bandStart + off + thick * 0.47} y={(v >= 0 ? b - s * 0.45 : b + s * 1.1)} textAnchor="middle" weight={700} size={Math.min(ir.style.valueSize, thick * 0.5)} opacity={clamp01(g * 2 - 0.4)}>
                {fmtValue(vals[si][ci] * g, ir.fmt)}
              </Text>,
            );
        }
      }
      if (ir.show.values && stacked) {
        const g2 = grow(ci);
        const end = vScale(acc);
        els.push(
          horizontal ? (
            <Text key={`sv${ci}`} ir={ir} x={end + s * 0.4} y={bandStart + inner / 2 + s * 0.35} weight={700} size={ir.style.valueSize} opacity={g2}>
              {fmtValue(acc, ir.fmt)}
            </Text>
          ) : (
            <Text key={`sv${ci}`} ir={ir} x={bandStart + inner / 2} y={end - s * 0.45} textAnchor="middle" weight={700} size={ir.style.valueSize} opacity={g2}>
              {fmtValue(acc, ir.fmt)}
            </Text>
          ),
        );
      }
      if (ir.show.labels)
        els.push(
          horizontal ? (
            <Text key={`c${ci}`} ir={ir} x={x0 - s * 0.5} y={bandStart + inner / 2 + s * 0.35} textAnchor="end" size={s * 0.9} opacity={axisP * dim(ir.cats[ci])}>
              {ir.cats[ci]}
            </Text>
          ) : (
            <Text key={`c${ci}`} ir={ir} x={bandStart + inner / 2} y={y1 + s * 1.4} textAnchor="middle" size={Math.min(s * 0.9, (band / Math.max(1, ir.cats[ci].length)) * 1.7)} color={ir.style.muted} opacity={axisP * dim(ir.cats[ci])}>
              {ir.cats[ci]}
            </Text>
          ),
        );
    }
  }
  if (ir.title)
    els.push(
      <Text key="title" ir={ir} x={0} y={s * 1.1} size={s * 1.25} weight={700} opacity={axisP}>
        {ir.title}
      </Text>,
    );
  if (ir.show.legend) els.push(<Legend key="lg" ir={ir} x={x0} y={(ir.title ? s * 2.6 : s)} />);
  return <>{els}</>;
}

function ScatterChart({ ir, lf }: { ir: ChartIR; lf: number }) {
  const [pt, pr, pb, pl] = ir.pad;
  const x0 = pl;
  const x1 = ir.w - pr;
  const y0 = pt;
  const y1 = ir.h - pb;
  const [xa, xb] = ir.xDomain!;
  const [ya, yb] = ir.domain;
  const X = (v: number) => x0 + ((v - xa) / (xb - xa || 1)) * (x1 - x0);
  const Y = (v: number) => y1 - ((v - ya) / (yb - ya || 1)) * (y1 - y0);
  const s = ir.style.size;
  const axisP = clamp01(lf / Math.max(1, ir.grow[1] * 0.5));
  const els: React.ReactNode[] = [];
  ir.ticks.forEach((t, i) => {
    els.push(<line key={`gy${i}`} x1={x0} x2={x1} y1={Y(t)} y2={Y(t)} stroke={ir.style.grid} strokeWidth={1.5} opacity={axisP} />);
    els.push(
      <Text key={`ty${i}`} ir={ir} x={x0 - s * 0.5} y={Y(t) + s * 0.3} textAnchor="end" size={s * 0.8} color={ir.style.muted} opacity={axisP}>
        {fmtValue(t, ir.fmt)}
      </Text>,
    );
  });
  (ir.xTicks ?? []).forEach((t, i) => {
    els.push(<line key={`gx${i}`} x1={X(t)} x2={X(t)} y1={y0} y2={y1} stroke={ir.style.grid} strokeWidth={1.5} opacity={axisP * 0.6} />);
    els.push(
      <Text key={`tx${i}`} ir={ir} x={X(t)} y={y1 + s * 1.3} textAnchor="middle" size={s * 0.8} color={ir.style.muted} opacity={axisP}>
        {fmtValue(t, {})}
      </Text>,
    );
  });
  for (const [i, p] of (ir.points ?? []).entries()) {
    const g = ease('outBack', (lf - ir.grow[0] - p.at) / Math.max(1, (ir.grow[1] - ir.grow[0]) * 0.6));
    if (g <= 0) continue;
    els.push(<circle key={`p${i}`} cx={X(p.x)} cy={Y(p.y)} r={p.r * g} fill={withAlpha(p.color, 0.8)} stroke={p.color} strokeWidth={2} />);
    if (p.label && ir.show.labels && (ir.points!.length <= 20 || ir.highlight?.includes(p.label)))
      els.push(
        <Text key={`pl${i}`} ir={ir} x={X(p.x) + p.r + 6} y={Y(p.y) + s * 0.3} size={s * 0.8} opacity={clamp01(g)}>
          {p.label}
        </Text>,
      );
  }
  if (ir.xLabel)
    els.push(
      <Text key="xl" ir={ir} x={x1} y={ir.h - 2} textAnchor="end" size={s * 0.8} color={ir.style.muted}>
        {ir.xLabel}
      </Text>,
    );
  if (ir.yLabel)
    els.push(
      <Text key="yl" ir={ir} x={x0} y={y0 - s * 0.6} size={s * 0.8} color={ir.style.muted}>
        {ir.yLabel}
      </Text>,
    );
  if (ir.title)
    els.push(
      <Text key="title" ir={ir} x={0} y={s * 1.1} size={s * 1.25} weight={700}>
        {ir.title}
      </Text>,
    );
  if (ir.show.legend) els.push(<Legend key="lg" ir={ir} x={x0} y={ir.title ? s * 2.6 : s} />);
  return <>{els}</>;
}

function PieChart({ ir, lf }: { ir: ChartIR; lf: number }) {
  const { v: vals } = snapAt(ir.keys, ir.morph, lf, false, mixVals, ir.values);
  const s = ir.style.size;
  const [pt, , pb] = ir.pad;
  const cx = ir.w / 2;
  const legendW = ir.show.labels ? 0 : 0;
  const cy = pt + (ir.h - pt - pb) / 2;
  const R = Math.min((ir.w - legendW) / 2 - s * 5, (ir.h - pt - pb) / 2 - s * 1.5);
  const rIn = ir.kind === 'donut' ? R * 0.58 : 0;
  const values = vals[0].map((v) => Math.max(0, v));
  const total = values.reduce((a, b) => a + b, 0) || 1;
  const sweep = ease(ir.ease, (lf - ir.grow[0]) / Math.max(1, ir.grow[1] - ir.grow[0]));
  const els: React.ReactNode[] = [];
  let a = -Math.PI / 2;
  values.forEach((v, i) => {
    const ang = (v / total) * Math.PI * 2 * sweep;
    const a2 = a + ang;
    const col = ir.catColors?.[i] ?? ir.series[0].color;
    const pop = ir.highlight?.includes(ir.cats[i]) ? R * 0.06 : 0;
    const mid = (a + a2) / 2;
    const ox = Math.cos(mid) * pop;
    const oy = Math.sin(mid) * pop;
    const P = (r: number, t: number) => `${(cx + ox + Math.cos(t) * r).toFixed(2)},${(cy + oy + Math.sin(t) * r).toFixed(2)}`;
    const large = ang > Math.PI ? 1 : 0;
    if (ang > 0.0005) {
      const d = rIn
        ? `M${P(R, a)}A${R},${R} 0 ${large} 1 ${P(R, a2)}L${P(rIn, a2)}A${rIn},${rIn} 0 ${large} 0 ${P(rIn, a)}Z`
        : `M${cx + ox},${cy + oy}L${P(R, a)}A${R},${R} 0 ${large} 1 ${P(R, a2)}Z`;
      els.push(<path key={`s${i}`} d={d} fill={col} stroke={ir.style.bg} strokeWidth={3} opacity={ir.highlight && !ir.highlight.includes(ir.cats[i]) ? 0.45 : 1} />);
      if (ir.show.labels && v / total > 0.03) {
        const lp = clamp01((sweep - 0.7) / 0.3);
        const lx = cx + Math.cos(mid) * (R + s * 1.2);
        const ly = cy + Math.sin(mid) * (R + s * 1.2);
        const right = Math.cos(mid) >= 0;
        els.push(
          <g key={`l${i}`} opacity={lp}>
            <Text ir={ir} x={lx} y={ly} textAnchor={right ? 'start' : 'end'} size={s * 0.9}>
              {ir.cats[i]}
            </Text>
            {ir.show.values ? (
              <Text ir={ir} x={lx} y={ly + s * 1.05} textAnchor={right ? 'start' : 'end'} size={s * 0.85} weight={700} color={col}>
                {ir.fmt.suffix || ir.fmt.prefix ? fmtValue(v, ir.fmt) : `${Math.round((v / total) * 100)}%`}
              </Text>
            ) : null}
          </g>,
        );
      }
    }
    a = a2;
  });
  if (rIn && ir.show.values) {
    const focus = ir.highlight?.length ? ir.cats.indexOf(ir.highlight[0]) : -1;
    els.push(
      <g key="center" opacity={clamp01((sweep - 0.5) * 2)}>
        <Text ir={ir} x={cx} y={cy + s * 0.5} textAnchor="middle" size={rIn * 0.42} weight={800}>
          {focus >= 0 ? `${Math.round((values[focus] / total) * 100)}%` : fmtValue(total, ir.fmt)}
        </Text>
        <Text ir={ir} x={cx} y={cy + s * 0.5 + rIn * 0.3} textAnchor="middle" size={s * 0.85} color={ir.style.muted}>
          {focus >= 0 ? ir.cats[focus] : 'total'}
        </Text>
      </g>,
    );
  }
  if (ir.title)
    els.push(
      <Text key="title" ir={ir} x={0} y={s * 1.1} size={s * 1.25} weight={700}>
        {ir.title}
      </Text>,
    );
  return <>{els}</>;
}

function RaceChart({ ir, lf }: { ir: ChartIR; lf: number }) {
  const { v: vals, k, t } = snapAt(ir.keys, ir.morph, lf, true, mixVals, ir.values);
  const row = vals[0];
  const top = Math.min(ir.top ?? 10, ir.cats.length);
  const [pt, pr, pb, pl] = ir.pad;
  const s = ir.style.size;
  const rankOf = (vs: number[]) => {
    const order = vs.map((v, i) => [v, i] as const).sort((a, b) => b[0] - a[0]);
    const r = new Array(vs.length);
    order.forEach(([, i], pos) => (r[i] = pos));
    return r as number[];
  };
  const rA = rankOf(ir.values[k][0]);
  const rB = rankOf(ir.values[Math.min(ir.values.length - 1, k + 1)][0]);
  const tt = ease('inOut', t);
  const slot = (ir.h - pt - pb) / top;
  const max = Math.max(...row, 1e-9);
  const X = (v: number) => pl + (Math.max(0, v) / max) * (ir.w - pl - pr);
  const g = ease('outCubic', (lf - ir.grow[0]) / Math.max(1, ir.grow[1] - ir.grow[0]));
  const els: React.ReactNode[] = [];
  ir.cats.forEach((c, i) => {
    const rank = lerp(rA[i], rB[i], tt);
    if (rank > top + 0.5) return;
    const y = pt + rank * slot;
    const op = clamp01(top + 0.5 - rank);
    const col = ir.catColors?.[i] ?? ir.series[0].color;
    const w = (X(row[i]) - pl) * g;
    els.push(
      <g key={c} opacity={op}>
        <rect x={pl} y={y + slot * 0.1} width={Math.max(0, w)} height={slot * 0.8} rx={Math.min(ir.radius, slot * 0.2)} fill={col} />
        <Text ir={ir} x={pl - s * 0.5} y={y + slot * 0.5 + s * 0.35} textAnchor="end" size={Math.min(s, slot * 0.45)} weight={600}>
          {c}
        </Text>
        {ir.show.values ? (
          <Text ir={ir} x={pl + w + s * 0.5} y={y + slot * 0.5 + s * 0.35} size={Math.min(ir.style.valueSize, slot * 0.45)} weight={700} color={ir.style.fg}>
            {fmtValue(row[i], ir.fmt)}
          </Text>
        ) : null}
      </g>,
    );
  });
  const label = ir.keyLabels?.[t > 0.5 ? Math.min(ir.keyLabels.length - 1, k + 1) : k];
  if (label !== undefined) {
    const num = Number(label);
    const shown = Number.isFinite(num) && ir.keyLabels!.every((l) => Number.isFinite(Number(l))) ? String(Math.round(lerp(Number(ir.keyLabels![k]), Number(ir.keyLabels![Math.min(ir.keyLabels!.length - 1, k + 1)]), t))) : label;
    els.push(
      <Text key="key" ir={ir} x={ir.w - pr} y={ir.h - pb - s * 0.4} textAnchor="end" size={Math.min(ir.h * 0.16, s * 5)} weight={800} color={ir.style.muted} opacity={0.85}>
        {shown}
      </Text>,
    );
  }
  if (ir.title)
    els.push(
      <Text key="title" ir={ir} x={0} y={s * 1.1} size={s * 1.25} weight={700}>
        {ir.title}
      </Text>,
    );
  return <>{els}</>;
}

// ---------------------------------------------------------------- map
let worldCache: any = null;
function world() {
  if (!worldCache) {
    const topo = worldTopo as any;
    worldCache = (feature(topo, topo.objects.countries) as any).features;
  }
  return worldCache as any[];
}

function makeProjection(kind: MapIR['projection']): GeoProjection {
  switch (kind) {
    case 'mercator':
      return geoMercator();
    case 'equirect':
      return geoEquirectangular();
    case 'orthographic':
      return geoOrthographic().clipAngle(90);
    default:
      return geoNaturalEarth1();
  }
}

function bboxShape(b: [number, number, number, number]) {
  const pts: [number, number][] = [];
  for (let i = 0; i <= 8; i++) for (let j = 0; j <= 8; j++) pts.push([b[0] + ((b[2] - b[0]) * i) / 8, b[1] + ((b[3] - b[1]) * j) / 8]);
  return { type: 'MultiPoint', coordinates: pts } as any;
}

function MapView({ ir, lf }: { ir: MapIR; lf: number }) {
  const { fps } = useVideoConfig();
  const feats = world();
  const s = ir.style.size;
  const margin = s * 1.2;
  const extent: [[number, number], [number, number]] = [[margin, margin], [ir.w - margin, ir.h - margin - (ir.show.legend ? s * 2.5 : 0)]];
  const fitFor = (focusIds: string[], bbox: [number, number, number, number] | null | undefined) => {
    const p = makeProjection(ir.projection);
    let target: any;
    if (focusIds.length) target = { type: 'FeatureCollection', features: feats.filter((f) => focusIds.includes(String(f.id))) };
    else if (bbox) target = bboxShape(bbox);
    else target = ir.projection === 'orthographic' ? { type: 'Sphere' } : { type: 'FeatureCollection', features: feats.filter((f) => f.properties.name !== 'Antarctica') };
    if (ir.projection === 'orthographic') {
      const c = bbox ? [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2] : ir.rotate ?? [0, 20];
      p.rotate([-c[0], -c[1]]);
    }
    p.fitExtent(extent, target);
    return { scale: p.scale(), tr: p.translate(), rot: p.rotate() };
  };
  const base = useMemo(() => fitFor(ir.focus, ir.bbox), [ir]);
  const zooms = useMemo(() => (ir.zooms ?? []).map((z) => ({ ...z, fit: fitFor([], z.bbox) })), [ir]);
  // camera: interpolate between the current fit and the next zoom target
  let cam = base;
  for (const z of zooms) {
    if (lf < z.at) break;
    const t = ease('inOut', (lf - z.at) / Math.max(1, z.d));
    const a = cam;
    const b = z.bbox ? z.fit : base;
    const sc = Math.exp(lerp(Math.log(a.scale), Math.log(b.scale), t));
    // keep the geographic centre moving linearly: interpolate translate relative to scale
    cam = { scale: sc, tr: [lerp(a.tr[0], b.tr[0], t), lerp(a.tr[1], b.tr[1], t)] as [number, number], rot: [lerp(a.rot[0], b.rot[0], t), lerp(a.rot[1], b.rot[1], t), 0] as any };
  }
  const proj = makeProjection(ir.projection).scale(cam.scale).translate(cam.tr as [number, number]);
  if (ir.projection === 'orthographic') {
    const spin = ir.spin ? (ir.spin * lf) / fps : 0;
    proj.rotate([cam.rot[0] + spin, cam.rot[1], 0]);
  }
  const path = geoPath(proj);
  const { v: vals, k } = snapAt<Record<string, number>>(
    ir.keys,
    ir.morph,
    lf,
    false,
    (a, b, t) => {
      const o: Record<string, number> = {};
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) o[key] = lerp(a[key] ?? 0, b[key] ?? 0, t);
      return o;
    },
    ir.values.length ? ir.values : [{}],
  );
  const [d0, d1] = ir.domain;
  const els: React.ReactNode[] = [];
  if (ir.projection === 'orthographic') els.push(<path key="sphere" d={path({ type: 'Sphere' } as any) ?? ''} fill={withAlpha(ir.colors[0], 0.35)} stroke={ir.style.grid} strokeWidth={1.5} />);
  if (ir.show.graticule) els.push(<path key="grat" d={path(geoGraticule10()) ?? ''} fill="none" stroke={ir.style.grid} strokeWidth={1} />);
  const order = feats.map((f) => String(f.id));
  feats.forEach((f) => {
    const id = String(f.id);
    const d = path(f);
    if (!d) return;
    let fill = ir.land;
    if (ir.kind === 'choropleth' && vals[id] !== undefined) {
      const i = order.indexOf(id);
      const g = ease('outCubic', (lf - ir.grow[0] - (i % 40) * ir.stagger * 0.5) / Math.max(1, ir.grow[1] - ir.grow[0]));
      const t = clamp01((vals[id] - d0) / (d1 - d0 || 1));
      fill = mixColor(ir.land, mixColor(ir.colors[0], ir.colors[1], t), g);
    }
    if (ir.highlight.includes(id)) fill = mixColor(fill, ir.highlightColor, clamp01((lf - ir.grow[0]) / Math.max(1, ir.grow[1])));
    els.push(<path key={`c${id}`} d={d} fill={fill} stroke={ir.border} strokeWidth={0.8} />);
  });
  // routes
  ir.routes.forEach((r, i) => {
    const p = clamp01((lf - r.at) / Math.max(1, r.d));
    if (p <= 0) return;
    const interp = geoInterpolate(r.a, r.b);
    const pts: [number, number][] = [];
    const N = 64;
    for (let j = 0; j <= N * p; j++) {
      const q = proj(interp(j / N));
      if (q) pts.push(q);
    }
    if (pts.length < 2) return;
    // lift the arc a little above the great circle for readability
    const lifted = pts.map((q, j) => {
      const u = j / N;
      return [q[0], q[1] - Math.sin(Math.PI * u) * Math.min(120, Math.hypot(pts[pts.length - 1][0] - pts[0][0], pts[pts.length - 1][1] - pts[0][1]) * 0.15)] as [number, number];
    });
    els.push(<polyline key={`r${i}`} points={lifted.map((q) => q.join(',')).join(' ')} fill="none" stroke={r.color} strokeWidth={r.width} strokeLinecap="round" />);
    const head = lifted[lifted.length - 1];
    if (p < 1) els.push(<circle key={`rh${i}`} cx={head[0]} cy={head[1]} r={r.width * 2.2} fill={r.color} />);
    const a = proj(r.a);
    if (a) els.push(<circle key={`ra${i}`} cx={a[0]} cy={a[1]} r={r.width * 1.6} fill={r.color} />);
    if (p >= 1) els.push(<circle key={`rb${i}`} cx={head[0]} cy={head[1]} r={r.width * 1.6 * ease('outBack', (lf - r.at - r.d) / 8)} fill={r.color} />);
  });
  // points
  ir.points.forEach((p, i) => {
    const q = proj([p.lon, p.lat]);
    if (!q) return;
    const g = ease('outBack', (lf - ir.grow[0] - p.at) / Math.max(1, (ir.grow[1] - ir.grow[0]) * 0.6));
    if (g <= 0) return;
    let r = p.r;
    if (ir.kind === 'bubbles' && ir.values.length > 1) {
      const id = Object.keys(ir.values[0])[i];
      const max = d1 || 1;
      r = 4 + 40 * Math.sqrt(Math.max(0, vals[id] ?? 0) / max);
    }
    const ring = ((lf - p.at) % 45) / 45;
    els.push(<circle key={`pr${i}`} cx={q[0]} cy={q[1]} r={r * (1 + ring * 1.4)} fill="none" stroke={p.color} strokeWidth={2} opacity={(1 - ring) * 0.6 * clamp01(g)} />);
    els.push(<circle key={`p${i}`} cx={q[0]} cy={q[1]} r={r * g} fill={withAlpha(p.color, ir.kind === 'bubbles' ? 0.7 : 1)} stroke={ir.style.bg} strokeWidth={2} />);
    if (p.label && (ir.show.labels || ir.kind !== 'bubbles'))
      els.push(
        <text key={`pl${i}`} x={q[0] + r + 8} y={q[1] + s * 0.35} fontFamily={ir.style.font} fontSize={s * 0.85} fontWeight={600} fill={ir.style.fg} opacity={clamp01(g)} paintOrder="stroke" stroke={ir.style.bg} strokeWidth={4}>
          {p.label}
        </text>,
      );
  });
  // legend
  if (ir.show.legend && ir.kind === 'choropleth' && ir.values.length) {
    const lw = Math.min(360, ir.w * 0.3);
    const y = ir.h - s * 1.6;
    els.push(
      <g key="legend" opacity={clamp01((lf - ir.grow[0]) / Math.max(1, ir.grow[1]))}>
        <defs>
          <linearGradient id="mapgrad">
            <stop offset="0" stopColor={ir.colors[0]} />
            <stop offset="1" stopColor={ir.colors[1]} />
          </linearGradient>
        </defs>
        <rect x={margin} y={y} width={lw} height={s * 0.6} rx={s * 0.3} fill="url(#mapgrad)" />
        <text x={margin} y={y - s * 0.4} fontFamily={ir.style.font} fontSize={s * 0.8} fill={ir.style.muted}>
          {fmtValue(d0, ir.fmt)}
        </text>
        <text x={margin + lw} y={y - s * 0.4} textAnchor="end" fontFamily={ir.style.font} fontSize={s * 0.8} fill={ir.style.muted}>
          {fmtValue(d1, ir.fmt)}
        </text>
      </g>,
    );
  }
  if (ir.keyLabels && ir.keyLabels[k])
    els.push(
      <text key="key" x={ir.w - margin} y={ir.h - margin} textAnchor="end" fontFamily={ir.style.font} fontSize={Math.min(ir.h * 0.12, s * 4)} fontWeight={800} fill={ir.style.muted}>
        {ir.keyLabels[k]}
      </text>,
    );
  return <>{els}</>;
}

// ---------------------------------------------------------------- graph
function GraphView({ ir, lf }: { ir: GraphIR; lf: number }) {
  const s = ir.style.size;
  const els: React.ReactNode[] = [];
  const pop = (at: number) => ease('outBack', (lf - at) / Math.max(1, ir.grow));
  const ctrl = (a: GraphIR['nodes'][number], b: GraphIR['nodes'][number], curve: number): [number, number] => {
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    return [mx - dy * curve * 0.5, my + dx * curve * 0.5];
  };
  const pointOn = (e: GraphIR['edges'][number], t: number): [number, number] => {
    const a = ir.nodes[e.a];
    const b = ir.nodes[e.b];
    const [cx, cy] = ctrl(a, b, e.curve);
    const u = 1 - t;
    return [u * u * a.x + 2 * u * t * cx + t * t * b.x, u * u * a.y + 2 * u * t * cy + t * t * b.y];
  };
  const highlightOf = (i: number) => {
    let best = 0;
    let col = '';
    for (const h of ir.highlights) {
      if (!h.nodes.includes(i)) continue;
      const fade = 6;
      const v = clamp01(Math.min((lf - h.at) / fade, (h.at + h.d - lf) / fade + 1));
      if (v > best) {
        best = v;
        col = h.color;
      }
    }
    return { v: best, col };
  };
  ir.edges.forEach((e, i) => {
    const p = ease('inOut', (lf - e.at) / Math.max(1, ir.grow * 1.2));
    if (p <= 0) return;
    const a = ir.nodes[e.a];
    const b = ir.nodes[e.b];
    // trim to the node borders
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const t0 = Math.min(0.45, a.r / len);
    const t1 = 1 - Math.min(0.45, (b.r + (e.directed ? 4 : 0)) / len);
    const pts: string[] = [];
    const N = 24;
    for (let j = 0; j <= N; j++) {
      const t = t0 + (t1 - t0) * (j / N) * p;
      const q = pointOn(e, t);
      pts.push(`${q[0].toFixed(1)},${q[1].toFixed(1)}`);
    }
    els.push(<polyline key={`e${i}`} points={pts.join(' ')} fill="none" stroke={e.color} strokeWidth={e.width} strokeLinecap="round" strokeDasharray={e.dash} />);
    if (e.directed && p >= 0.98) {
      const q = pointOn(e, t1);
      const q0 = pointOn(e, t1 - 0.02);
      const ang = Math.atan2(q[1] - q0[1], q[0] - q0[0]);
      const sz = e.width * 3.5 + 6;
      const P = (k: number, side: number) => `${q[0] - Math.cos(ang) * sz * k - Math.sin(ang) * sz * side * 0.55},${q[1] - Math.sin(ang) * sz * k + Math.cos(ang) * sz * side * 0.55}`;
      els.push(<polygon key={`ea${i}`} points={`${q[0]},${q[1]} ${P(1, 1)} ${P(1, -1)}`} fill={e.color} />);
    }
    if (e.label && p >= 0.9) {
      const q = pointOn(e, 0.5);
      els.push(
        <text key={`el${i}`} x={q[0]} y={q[1] - 8} textAnchor="middle" fontFamily={ir.style.font} fontSize={s * 0.75} fill={ir.style.muted} paintOrder="stroke" stroke={ir.style.bg} strokeWidth={5}>
          {e.label}
        </text>,
      );
    }
  });
  // pulses travelling along a path of nodes
  ir.pulses.forEach((pu, pi) => {
    const hopFrames = Math.max(4, Math.round(18 / Math.max(0.1, pu.speed)));
    for (let r = 0; r < pu.repeat; r++) {
      const start = pu.at + r * pu.every;
      const t = (lf - start) / hopFrames;
      if (t < 0 || t >= pu.path.length - 1) continue;
      const hop = Math.floor(t);
      const a = ir.nodes[pu.path[hop]];
      const b = ir.nodes[pu.path[hop + 1]];
      const e = ir.edges.find((x) => (x.a === pu.path[hop] && x.b === pu.path[hop + 1]) || (x.b === pu.path[hop] && x.a === pu.path[hop + 1]));
      const u = ease('inOut', t - hop);
      let q: [number, number];
      if (e) q = pointOn(e, e.a === pu.path[hop] ? u : 1 - u);
      else q = [lerp(a.x, b.x, u), lerp(a.y, b.y, u)];
      els.push(<circle key={`pg${pi}.${r}`} cx={q[0]} cy={q[1]} r={pu.size * 2.2} fill={withAlpha(pu.color, 0.25)} />);
      els.push(<circle key={`p${pi}.${r}`} cx={q[0]} cy={q[1]} r={pu.size} fill={pu.color} />);
    }
  });
  ir.nodes.forEach((n, i) => {
    const g = pop(n.at);
    if (g <= 0) return;
    const hl = highlightOf(i);
    // node lights up when a pulse arrives
    let flash = 0;
    for (const pu of ir.pulses) {
      const hopFrames = Math.max(4, Math.round(18 / Math.max(0.1, pu.speed)));
      pu.path.forEach((k, h) => {
        if (k !== i || h === 0) return;
        for (let r = 0; r < pu.repeat; r++) {
          const arrive = pu.at + r * pu.every + h * hopFrames;
          const d = lf - arrive;
          if (d >= 0 && d < 12) flash = Math.max(flash, 1 - d / 12);
        }
      });
    }
    const fill = hl.v ? mixColor(n.color, hl.col, hl.v) : n.color;
    if (hl.v > 0) els.push(<circle key={`h${i}`} cx={n.x} cy={n.y} r={n.r * g + 10 * hl.v} fill="none" stroke={hl.col} strokeWidth={4} opacity={hl.v} />);
    if (n.shape === 'circle') els.push(<circle key={`n${i}`} cx={n.x} cy={n.y} r={n.r * g * (1 + flash * 0.15)} fill={fill} stroke={ir.style.bg} strokeWidth={3} />);
    else {
      const wN = n.shape === 'pill' ? Math.max(n.r * 3, (n.label?.length ?? 2) * Math.max(s * 0.85, n.r * 0.62) * 0.62 + n.r * 1.2) : n.r * 2;
      els.push(<rect key={`n${i}`} x={n.x - (wN / 2) * g} y={n.y - n.r * g} width={wN * g} height={n.r * 2 * g} rx={n.shape === 'pill' ? n.r : 8} fill={fill} stroke={ir.style.bg} strokeWidth={3} />);
    }
    if (flash > 0) els.push(<circle key={`f${i}`} cx={n.x} cy={n.y} r={n.r * (1 + (1 - flash) * 0.9)} fill="none" stroke={fill} strokeWidth={3} opacity={flash} />);
    if (n.label) {
      const inside = n.shape === 'pill' || (n.shape === 'rect' && n.label.length * s * 0.6 < n.r * 2);
      const fs = inside ? Math.max(s * 0.85, n.r * 0.62) : s * 0.85;
      els.push(
        <text key={`t${i}`} x={n.x} y={inside ? n.y + fs * 0.36 : n.y + n.r + s * 1.05} textAnchor="middle" fontFamily={ir.style.font} fontSize={fs} fontWeight={600} fill={inside ? n.textColor : ir.style.fg} opacity={clamp01(g)} paintOrder={inside ? undefined : 'stroke'} stroke={inside ? undefined : ir.style.bg} strokeWidth={inside ? undefined : 5}>
          {n.label}
        </text>,
      );
    }
  });
  return <>{els}</>;
}

export const ChartView: React.FC<{ layer: IRLayer; lf: number; st?: ChannelState }> = ({ layer, lf }) => {
  const d = layer.data as any;
  if (!d) return null;
  const w = layer.w ?? d.w;
  const h = layer.h ?? d.h;
  let body: React.ReactNode = null;
  if (layer.type === 'map') body = <MapView ir={d as MapIR} lf={lf} />;
  else if (layer.type === 'graph') body = <GraphView ir={d as GraphIR} lf={lf} />;
  else {
    const ir = d as ChartIR;
    body = ir.kind === 'pie' || ir.kind === 'donut' ? <PieChart ir={ir} lf={lf} /> : ir.kind === 'scatter' ? <ScatterChart ir={ir} lf={lf} /> : ir.kind === 'race' ? <RaceChart ir={ir} lf={lf} /> : <CartesianChart ir={ir} lf={lf} />;
  }
  return (
    <svg width={w} height={h} viewBox={`0 0 ${d.w} ${d.h}`} style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }}>
      {body}
    </svg>
  );
};
