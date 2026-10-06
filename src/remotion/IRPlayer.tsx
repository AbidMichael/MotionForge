import React, { useEffect, useMemo, useState } from 'react';
import { AbsoluteFill, continueRender, delayRender, Freeze, Img, OffthreadVideo, useCurrentFrame } from 'remotion';
import { clipPath, counterText, evaluateAnims, insetClip, mapTime, type ChannelState } from '../ir/evaluate';
import type { IRDoc, IRFont, IRLayer } from '../ir/types';
import { LayerIndex , RenderHints } from './context';
import { ExtraLayer } from './extras';

export type IRPlayerProps = { ir: IRDoc; transparent?: boolean };

// ---------- fonts ----------
function fontUrl(f: IRFont): string | null {
  if (f.source === 'url' && f.url) return f.url;
  if (f.source === 'google') {
    const weights = (f.weights?.length ? f.weights : [400, 700]).slice().sort((a, b) => a - b);
    return `https://fonts.googleapis.com/css2?family=${encodeURIComponent(f.family).replace(/%20/g, '+')}:wght@${weights.join(';')}&display=block`;
  }
  return null;
}

const useFonts = (fonts: IRFont[]) => {
  const [handle] = useState(() => (fonts.length ? delayRender('Loading fonts', { timeoutInMilliseconds: 20000 }) : null));
  useEffect(() => {
    if (handle === null) return;
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        continueRender(handle);
      }
    };
    const timer = setTimeout(finish, 8000); // never block a render on a slow font CDN
    const loads: Promise<unknown>[] = [];
    for (const f of fonts) {
      const url = fontUrl(f);
      if (!url) continue;
      if (f.source === 'url' && /\.(woff2?|ttf|otf)(\?|$)/i.test(url)) {
        const desc: FontFaceDescriptors = {};
        const ff = f as IRFont & { weight?: number; unicodeRange?: string };
        if (ff.weight) desc.weight = String(ff.weight);
        if (ff.unicodeRange) desc.unicodeRange = ff.unicodeRange;
        const face = new FontFace(f.family, `url(${url})`, desc);
        loads.push(face.load().then((loaded) => (document.fonts as any).add(loaded)).catch(() => undefined));
        continue;
      }
      loads.push(
        new Promise<void>((resolve) => {
          const link = document.createElement('link');
          link.rel = 'stylesheet';
          link.href = url;
          link.onload = () => {
            const ws = f.weights?.length ? f.weights : [400, 700];
            Promise.all(ws.map((w) => document.fonts.load(`${w} 32px "${f.family}"`)))
              .catch(() => undefined)
              .then(() => resolve());
          };
          link.onerror = () => resolve();
          document.head.appendChild(link);
        }),
      );
    }
    Promise.all(loads).then(() => (document as any).fonts.ready).then(finish, finish);
    return () => clearTimeout(timer);
  }, [handle, fonts]);
};

// ---------- style helpers ----------
const num = (v: unknown, d = 0) => (typeof v === 'number' ? v : v == null ? d : parseFloat(String(v)) || d);

const TEXT_KEYS = new Set([
  'font', 'size', 'weight', 'color', 'align', 'lineHeight', 'tracking', 'case', 'italic', 'shadow', 'glow',
  'stroke', 'strokeWidth', 'bg', 'padding', 'radius', 'fill', 'fit', 'gradient', 'dash', 'cap', 'tabular', 'glowSize', 'filter',
  'rate', 'trim', 'alpha',
]);

function passThrough(style: Record<string, string | number>): React.CSSProperties {
  const out: Record<string, string | number> = {};
  for (const k in style) if (!TEXT_KEYS.has(k)) out[k] = style[k];
  return out as React.CSSProperties;
}

function glowShadow(color: string, size = 1): string {
  return `0 0 ${12 * size}px ${color}, 0 0 ${32 * size}px ${color}`;
}

function transformOf(st: ChannelState, base: { rot?: number; scale?: number }, anchorTranslate: string | null) {
  const parts: string[] = [];
  if (anchorTranslate) parts.push(anchorTranslate);
  if (st.dx || st.dy) parts.push(`translate(${st.dx}px, ${st.dy}px)`);
  if (st.rotX || st.rotY) parts.push(`perspective(1400px) rotateX(${st.rotX}deg) rotateY(${st.rotY}deg)`);
  const rot = (base.rot ?? 0) + st.rotate;
  if (rot) parts.push(`rotate(${rot}deg)`);
  if (st.skewX) parts.push(`skewX(${st.skewX}deg)`);
  const s = (base.scale ?? 1) * st.scale;
  if (s !== 1 || st.scaleX !== 1 || st.scaleY !== 1) parts.push(`scale(${s * st.scaleX}, ${s * st.scaleY})`);
  return parts.length ? parts.join(' ') : undefined;
}

function filterOf(st: ChannelState, extra?: unknown): string | undefined {
  const f: string[] = [];
  if (typeof extra === 'string' && extra && extra !== 'none') f.push(extra);
  if (st.blur > 0.01) f.push(`blur(${st.blur}px)`);
  if (st.brightness !== 1) f.push(`brightness(${st.brightness})`);
  if (st.hue) f.push(`hue-rotate(${st.hue}deg)`);
  return f.length ? f.join(' ') : undefined;
}

// ---------- text ----------
function textStyle(layer: IRLayer, st: ChannelState): React.CSSProperties {
  const s = layer.style;
  const color = st.color ?? (s.color as string) ?? '#fff';
  const shadows: string[] = [];
  if (s.shadow) shadows.push(String(s.shadow));
  if (s.glow) shadows.push(glowShadow(String(s.glow), num(s.glowSize, 1)));
  const css: React.CSSProperties = {
    fontFamily: (s.font as string) ?? 'Inter, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    fontSize: num(s.size, 64),
    fontWeight: (s.weight as any) ?? 700,
    color,
    textAlign: (s.align as any) ?? 'center',
    lineHeight: s.lineHeight != null ? (s.lineHeight as any) : 1.1,
    letterSpacing: `${num(s.tracking, 0) + st.letterSpacing}em`,
    textTransform: s.case === 'upper' ? 'uppercase' : s.case === 'lower' ? 'lowercase' : undefined,
    fontStyle: s.italic ? 'italic' : undefined,
    textShadow: shadows.length ? shadows.join(', ') : undefined,
    WebkitTextStroke: s.stroke ? `${num(s.strokeWidth, 2)}px ${s.stroke}` : undefined,
    fontVariantNumeric: s.tabular || layer.counter ? 'tabular-nums' : undefined,
    whiteSpace: layer.w ? 'pre-wrap' : 'pre',
    width: layer.w,
    background: s.bg as string | undefined,
    padding: s.padding != null ? (typeof s.padding === 'number' ? `${s.padding}px` : String(s.padding)) : undefined,
    borderRadius: s.radius != null ? num(s.radius) : undefined,
  };
  if (s.gradient) {
    css.backgroundImage = String(s.gradient);
    css.WebkitBackgroundClip = 'text';
    (css as any).backgroundClip = 'text';
    css.color = 'transparent';
  }
  return { ...css, ...passThrough(s) };
}

function unitStyle(st: ChannelState): React.CSSProperties {
  return {
    display: 'inline-block',
    opacity: st.opacity,
    transform: transformOf(st, {}, null),
    filter: filterOf(st),
    color: st.color,
    clipPath: clipPath(st.clip, st.clipDir),
  };
}

const TextBody: React.FC<{ layer: IRLayer; lf: number; st: ChannelState }> = ({ layer, lf, st }) => {
  const text = layer.counter ? counterText(layer.counter, lf) : layer.text ?? '';
  if (!layer.split) {
    if (st.chars < 0.9999) {
      const n = Math.round(Math.max(0, st.chars) * text.length);
      return (
        <>
          {text.slice(0, n)}
          <span style={{ opacity: 0 }}>{text.slice(n)}</span>
        </>
      );
    }
    return <>{text}</>;
  }
  const stagger = layer.stagger ?? 2;
  if (layer.split === 'lines') {
    return (
      <>
        {text.split('\n').map((line, i) => (
          <div key={i} style={{ ...unitStyle(evaluateAnims(layer.anims, lf, 'unit', i * stagger)), display: 'block' }}>
            {line || ' '}
          </div>
        ))}
      </>
    );
  }
  const tokens = text.split(/(\s+)/);
  let unit = 0;
  return (
    <>
      {tokens.map((tok, ti) => {
        if (/^\s+$/.test(tok)) {
          return tok.includes('\n') ? <br key={ti} /> : <span key={ti} style={{ whiteSpace: 'pre' }}>{tok}</span>;
        }
        if (!tok) return null;
        if (layer.split === 'words') {
          const st2 = evaluateAnims(layer.anims, lf, 'unit', unit++ * stagger);
          return <span key={ti} style={unitStyle(st2)}>{tok}</span>;
        }
        return (
          <span key={ti} style={{ display: 'inline-block', whiteSpace: 'pre' }}>
            {Array.from(tok).map((ch, ci) => {
              const st2 = evaluateAnims(layer.anims, lf, 'unit', unit++ * stagger);
              return <span key={ci} style={unitStyle(st2)}>{ch}</span>;
            })}
          </span>
        );
      })}
    </>
  );
};

// ---------- shapes ----------
function shapeStyle(layer: IRLayer, st: ChannelState): React.CSSProperties {
  const s = layer.style;
  const fill = st.color ?? (s.fill as string) ?? (s.color as string) ?? 'transparent';
  const shadows: string[] = [];
  if (s.shadow) shadows.push(String(s.shadow));
  if (s.glow) shadows.push(glowShadow(String(s.glow), num(s.glowSize, 1)));
  return {
    width: st.bw ?? layer.w ?? 0,
    height: st.bh ?? layer.h ?? 0,
    background: fill,
    borderRadius: layer.type === 'ellipse' ? '50%' : s.radius != null ? num(s.radius) : undefined,
    border: s.stroke ? `${num(s.strokeWidth, 2)}px ${s.dash ? 'dashed' : 'solid'} ${s.stroke}` : undefined,
    boxShadow: shadows.length ? shadows.join(', ') : undefined,
    boxSizing: 'border-box',
    ...passThrough(s),
  };
}

const LineBody: React.FC<{ layer: IRLayer; st: ChannelState }> = ({ layer, st }) => {
  const [x1, y1, x2, y2] = layer.points ?? [0, 0, 100, 0];
  const sw = num(layer.style.strokeWidth, 4);
  const pad = sw * 2;
  const minX = Math.min(x1, x2) - pad;
  const minY = Math.min(y1, y2) - pad;
  const w = Math.abs(x2 - x1) + pad * 2;
  const h = Math.abs(y2 - y1) + pad * 2;
  const stroke = st.color ?? (layer.style.stroke as string) ?? (layer.style.color as string) ?? '#fff';
  return (
    <svg width={w} height={h} style={{ position: 'absolute', left: minX, top: minY, overflow: 'visible' }}>
      <line
        x1={x1 - minX}
        y1={y1 - minY}
        x2={x2 - minX}
        y2={y2 - minY}
        stroke={stroke}
        strokeWidth={sw}
        strokeLinecap={(layer.style.cap as any) ?? 'round'}
        pathLength={1}
        strokeDasharray={1}
        strokeDashoffset={1 - Math.max(0, Math.min(1, st.draw))}
        style={{ filter: layer.style.glow ? `drop-shadow(0 0 8px ${layer.style.glow})` : undefined }}
      />
    </svg>
  );
};

const PathBody: React.FC<{ layer: IRLayer; st: ChannelState }> = ({ layer, st }) => {
  const s = layer.style;
  const stroke = (s.stroke as string) ?? 'none';
  const fill = st.color ?? (s.fill as string) ?? 'none';
  const drawing = st.draw < 0.9999;
  return (
    <svg width={layer.w} height={layer.h} viewBox={layer.viewBox ?? `0 0 ${layer.w} ${layer.h}`} style={{ overflow: 'visible', display: 'block' }}>
      <path
        d={layer.d}
        fill={fill}
        stroke={stroke}
        strokeWidth={num(s.strokeWidth, 4)}
        strokeLinecap={(s.cap as any) ?? 'round'}
        strokeLinejoin="round"
        pathLength={1}
        strokeDasharray={drawing ? 1 : undefined}
        strokeDashoffset={drawing ? 1 - Math.max(0, st.draw) : undefined}
        style={{ filter: s.glow ? `drop-shadow(0 0 8px ${s.glow})` : undefined }}
      />
    </svg>
  );
};

// ---------- layer ----------
const LayerView: React.FC<{ layer: IRLayer; frame: number; flow?: boolean }> = ({ layer, frame, flow }) => {
  if (frame < layer.from || frame >= layer.to) return null;
  const lf = frame - layer.from;
  const st = evaluateAnims(layer.anims, lf, layer.split ? 'layer' : 'all');
  const opacity = (layer.opacity ?? 1) * st.opacity;
  if (opacity <= 0.001 && !layer.children) return null;
  const [ax, ay] = layer.anchor;
  const isLine = layer.type === 'line';
  const anchorT = flow || isLine || (ax === 0 && ay === 0) ? null : `translate(${-ax * 100}%, ${-ay * 100}%)`;
  const wrapper: React.CSSProperties = {
    position: flow ? 'relative' : 'absolute',
    left: flow || isLine ? undefined : layer.x,
    top: flow || isLine ? undefined : layer.y,
    opacity,
    transform: transformOf(st, layer, anchorT),
    transformOrigin: flow ? '50% 50%' : `${ax * 100}% ${ay * 100}%`,
    filter: filterOf(st, layer.style.filter),
    mixBlendMode: layer.blend as any,
    zIndex: layer.z,
    clipPath: insetClip(st) ?? clipPath(st.clip, st.clipDir ?? layer.clipDir) ?? layer.mask,
    flexShrink: flow ? 0 : undefined,
  };

  switch (layer.type) {
    case 'text':
      return (
        <div style={{ ...wrapper, ...textStyle(layer, st) }}>
          <TextBody layer={layer} lf={lf} st={st} />
        </div>
      );
    case 'rect':
    case 'ellipse':
      return <div style={{ ...wrapper, ...shapeStyle(layer, st) }} />;
    case 'line':
      return (
        <div style={{ ...wrapper, position: 'absolute', left: 0, top: 0 }}>
          <LineBody layer={layer} st={st} />
        </div>
      );
    case 'path':
      return (
        <div style={wrapper}>
          <PathBody layer={layer} st={st} />
        </div>
      );
    case 'svg':
      return (
        <div
          style={{ ...wrapper, width: layer.w, height: layer.h, color: st.color ?? (layer.style.color as string) }}
          dangerouslySetInnerHTML={{ __html: layer.svg ?? '' }}
        />
      );
    case 'image':
      return (
        <div style={{ ...wrapper, width: st.bw ?? layer.w, height: st.bh ?? layer.h, overflow: 'hidden', borderRadius: num(layer.style.radius, 0) }}>
          {layer.src ? (
            <Img src={layer.src} style={{ width: '100%', height: '100%', objectFit: (layer.style.fit as any) ?? 'cover', display: 'block' }} />
          ) : null}
        </div>
      );
    case 'video':
      return (
        <div style={{ ...wrapper, width: st.bw ?? layer.w, height: st.bh ?? layer.h, overflow: 'hidden', borderRadius: num(layer.style.radius, 0) }}>
          {layer.src ? (
            // Freeze pins the video to this layer's own clock (layer-local frame, sub-composition time maps)
            <Freeze frame={Math.max(0, Math.floor(lf * num(layer.style.rate, 1)) + Math.round(num(layer.style.trim, 0)))}>
              <OffthreadVideo
                muted
                transparent={layer.style.alpha === 1}
                src={layer.src}
                style={{ width: '100%', height: '100%', objectFit: (layer.style.fit as any) ?? 'cover' }}
              />
            </Freeze>
          ) : null}
        </div>
      );
    case 'group': {
      const kids = layer.children ?? [];
      const cf = layer.time ? mapTime(layer.time.segs, lf) : lf;
      const box: React.CSSProperties = {
        ...wrapper,
        width: st.bw ?? layer.w ?? (layer.layout ? undefined : 0),
        height: st.bh ?? layer.h ?? (layer.layout ? undefined : 0),
        overflow: layer.overflow ?? 'visible',
        background: (layer.style.bg as string) ?? (layer.style.fill as string),
        borderRadius: layer.style.radius != null ? num(layer.style.radius) : undefined,
        padding: layer.style.padding != null ? (typeof layer.style.padding === 'number' ? `${layer.style.padding}px` : String(layer.style.padding)) : undefined,
        ...passThrough(layer.style),
      };
      if (layer.layout) {
        const L = layer.layout;
        const map = { start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch', between: 'space-between' } as const;
        Object.assign(box, {
          display: 'flex',
          flexDirection: L.dir,
          gap: L.gap ?? 0,
          alignItems: map[L.align ?? 'center'],
          justifyContent: map[L.justify ?? 'start'],
          flexWrap: L.wrap ? 'wrap' : 'nowrap',
        });
      }
      return (
        <div style={box}>
          {kids.map((k) => (
            <LayerView key={k.id} layer={k} frame={cf} flow={!!layer.layout} />
          ))}
        </div>
      );
    }
    default:
      return <ExtraLayer layer={layer} lf={lf} st={st} wrapper={wrapper} />;
  }
};

export const IRPlayer: React.FC<IRPlayerProps> = ({ ir, transparent }) => {
  const frame = useCurrentFrame();
  useFonts(ir.fonts);
  const index = useMemo(() => {
    const m = new Map<string, IRLayer>();
    const walk = (l: IRLayer) => {
      m.set(l.id, l);
      l.children?.forEach(walk);
    };
    ir.layers.forEach(walk);
    return m;
  }, [ir]);
  const hints = useMemo(() => ({ draft: ir.q3 === 'draft' }), [ir.q3]);
  return (
    <LayerIndex.Provider value={index}>
      <RenderHints.Provider value={hints}>
      <AbsoluteFill style={{ backgroundColor: transparent ? 'transparent' : ir.bg, overflow: 'hidden' }}>
        {ir.layers.map((l) => (
          <LayerView key={l.id} layer={l} frame={frame} />
        ))}
      </AbsoluteFill>
      </RenderHints.Provider>
    </LayerIndex.Provider>
  );
};
