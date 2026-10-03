import React, { useContext } from 'react';
import { evaluateAnims, type ChannelState } from '../ir/evaluate';
import { pointAt, routeConnector, sample, slice, type Pt, type Rect } from '../ir/geometry';
import type { IREnd, IRLayer } from '../ir/types';
import { LayerIndex } from './context';

function endRect(end: IREnd, lf: number, index: Map<string, IRLayer>): Rect {
  let dx = 0;
  let dy = 0;
  for (const f of end.follow ?? []) {
    const L = index.get(f.id);
    if (!L) continue;
    const st = evaluateAnims(L.anims, lf - f.at);
    dx += st.dx;
    dy += st.dy;
  }
  return { x: end.rect.x + dx, y: end.rect.y + dy, w: end.rect.w, h: end.rect.h };
}

const arrowHead = (p: Pt, angle: number, size: number) => {
  const a = (angle * Math.PI) / 180;
  const back = (k: number, side: number): Pt => [p[0] - Math.cos(a) * size * k - Math.sin(a) * size * side * 0.55, p[1] - Math.sin(a) * size * k + Math.cos(a) * size * side * 0.55];
  const l = back(1, 1);
  const r = back(1, -1);
  return `${p[0]},${p[1]} ${l[0]},${l[1]} ${r[0]},${r[1]}`;
};

/** Connectors follow the boxes they attach to, route around obstacles and carry signals. */
export const ConnectorView: React.FC<{ layer: IRLayer; lf: number; st: ChannelState }> = ({ layer, lf, st }) => {
  const index = useContext(LayerIndex);
  const c = layer.conn;
  if (!c) return null;
  const a = endRect(c.a, lf, index);
  const b = endRect(c.b, lf, index);
  const pa: Rect | Pt = a.w || a.h ? a : [a.x, a.y];
  const pb: Rect | Pt = b.w || b.h ? b : [b.x, b.y];
  const route = routeConnector({ a: pa, b: pb, route: c.route, fromSide: c.fromSide, toSide: c.toSide, gap: c.gap, radius: c.radius, curvature: c.curvature, obstacles: c.obstacles });
  const sm = sample(route.samples);
  const draw = Math.max(0, Math.min(1, st.draw));
  const stroke = st.color ?? c.stroke;
  const els: React.ReactNode[] = [];
  els.push(
    <path
      key="p"
      d={route.d}
      fill="none"
      stroke={stroke}
      strokeWidth={c.width}
      strokeLinecap="round"
      strokeLinejoin="round"
      pathLength={draw < 1 ? 1 : undefined}
      strokeDasharray={draw < 1 ? '1' : c.dash}
      strokeDashoffset={draw < 1 ? 1 - draw : undefined}
    />,
  );
  if (draw > 0.02 && (c.arrow === 'end' || c.arrow === 'both')) {
    const e = pointAt(sm, draw);
    els.push(<polygon key="ae" points={arrowHead([e.x, e.y], e.angle, c.arrowSize)} fill={stroke} />);
  }
  if (draw > 0.02 && (c.arrow === 'start' || c.arrow === 'both')) {
    const s0 = pointAt(sm, 0);
    els.push(<polygon key="as" points={arrowHead([s0.x, s0.y], s0.angle + 180, c.arrowSize)} fill={stroke} />);
  }
  const sig = c.signal;
  if (sig && draw >= 0.999 && lf >= sig.s && lf < sig.e + sig.travel) {
    const t = lf - sig.s;
    const first = Math.max(0, Math.ceil((t - sig.travel) / sig.every));
    const last = Math.min(sig.count - 1, Math.floor(t / sig.every));
    for (let n = first; n <= last; n++) {
      if (n * sig.every > sig.e - sig.s) break;
      let p = (t - n * sig.every) / sig.travel;
      if (p < 0 || p > 1) continue;
      if (sig.dir < 0) p = 1 - p;
      const head = pointAt(sm, p);
      if (sig.trail > 0) {
        const tail = slice(sm, sig.dir > 0 ? p - sig.trail : p, sig.dir > 0 ? p : p + sig.trail);
        if (tail.length > 1) {
          els.push(
            <polyline
              key={`t${n}`}
              points={tail.map((q) => q.join(',')).join(' ')}
              fill="none"
              stroke={sig.color}
              strokeWidth={sig.size * 0.6}
              strokeLinecap="round"
              opacity={0.55}
            />,
          );
        }
      }
      els.push(<circle key={`s${n}`} cx={head.x} cy={head.y} r={sig.size / 2} fill={sig.color} style={{ filter: sig.glow ? `drop-shadow(0 0 ${sig.size}px ${sig.glow})` : undefined }} />);
    }
  }
  let label: React.ReactNode = null;
  if (c.label && draw > 0.6) {
    const m = pointAt(sm, 0.5);
    label = (
      <div
        style={{
          position: 'absolute',
          left: m.x,
          top: m.y,
          transform: 'translate(-50%, -50%)',
          font: `600 ${c.label.size}px ${c.label.font}`,
          color: c.label.color,
          background: c.label.bg,
          padding: c.label.bg ? '4px 10px' : undefined,
          borderRadius: 6,
          whiteSpace: 'pre',
          opacity: Math.min(1, (draw - 0.6) / 0.3),
        }}
      >
        {c.label.text}
      </div>
    );
  }
  return (
    <>
      <svg style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }} width={1} height={1}>
        {els}
      </svg>
      {label}
    </>
  );
};
