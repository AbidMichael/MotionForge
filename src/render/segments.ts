import { sha256, stableStringify } from '../core/util';
import type { IRDoc, IRLayer } from '../ir/types';
import { IR_PLAYER_VERSION } from '../ir/types';

export interface Segment {
  a: number; // first frame (inclusive)
  b: number; // end frame (exclusive)
  hash: string;
}

/**
 * Split the timeline at every scene boundary (transition overlaps become their own segment).
 * A segment's hash covers only the layers visible in it, shifted to segment-local time,
 * so editing one scene leaves every other segment's cache entry valid.
 */
export function segmentRanges(ir: IRDoc, salt: string): Segment[] {
  const cuts = new Set<number>([0, ir.duration]);
  for (const s of ir.scenes) {
    cuts.add(s.start);
    cuts.add(s.end);
  }
  for (const l of ir.layers) {
    if (l.id.startsWith('t')) {
      cuts.add(l.from);
      cuts.add(l.to);
    }
  }
  const pts = [...cuts].filter((c) => c >= 0 && c <= ir.duration).sort((x, y) => x - y);
  const globals = stableStringify({ w: ir.width, h: ir.height, fps: ir.fps, bg: ir.bg, fonts: ir.fonts, v: IR_PLAYER_VERSION, salt });
  const out: Segment[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (b <= a) continue;
    const visible = ir.layers
      .filter((l) => l.from < b && l.to > a)
      .map((l: IRLayer) => ({ ...l, from: l.from - a, to: l.to - a }));
    out.push({ a, b, hash: sha256(globals + '|' + (b - a) + '|' + stableStringify(visible)).slice(0, 24) });
  }
  return out;
}
