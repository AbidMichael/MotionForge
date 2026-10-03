import type { IRDoc, IRLayer } from '../ir/types';

/**
 * A compact text "motion summary" so an agent can check timing without looking at frames:
 *   S1 0.00–2.50s kinetic:title-slam
 *     text "LAUNCH DAY" 0.00–2.50 · in kinetic:slam 0.00–0.40 (per unit) · out core:fade-out 2.10–2.50
 */
export function motionSummary(ir: IRDoc, maxLayersPerScene = 14): string {
  const fps = ir.fps;
  const t = (f: number) => (f / fps).toFixed(2);
  const lines: string[] = [`${ir.width}x${ir.height}@${fps} · ${t(ir.duration)}s · ${ir.scenes.length} scenes`];
  const describe = (l: IRLayer, offset: number, depth: number, budget: { n: number }) => {
    if (budget.n <= 0) return;
    const abs0 = offset + l.from;
    const abs1 = offset + l.to;
    const anims = l.anims.map((a) => `${a.loop ? 'loop ' : ''}${a.n ?? 'anim'} ${t(abs0 + a.s)}–${t(abs0 + (a.loop ? l.to - l.from : a.e))}${a.unit ? ' per unit' : ''}`);
    const isText = l.text !== undefined || !!l.counter;
    const isElement = l.type === 'group' && !!l.src_preset;
    // backgrounds and plain static shapes are noise in a summary
    if (l.src_preset === 'core:backdrop' || l.src_preset === 'core:dots-field') {
      budget.n--;
      lines.push(`${'  '.repeat(depth)}${l.src_preset}`);
      return;
    }
    const rich = ['chart', 'map', 'graph', 'sim', 'three', 'connector', 'states', 'list'].includes(l.type);
    if (!isText && !isElement && !anims.length && l.type !== 'group' && !rich) return;
    if (l.type === 'group' && !isElement && !anims.length) {
      for (const c of l.children ?? []) describe(c, abs0, depth, budget);
      return;
    }
    budget.n--;
    let label: string = isElement ? l.src_preset! : l.type;
    const d = l.data as any;
    if (rich && d) {
      if (l.type === 'chart') label += ` ${d.kind} ${d.cats?.length ?? d.points?.length ?? 0} items${d.keys?.length > 1 ? ` · ${d.keys.length} snapshots` : ''}${d.title ? ` "${d.title}"` : ''}`;
      else if (l.type === 'map') label += ` ${d.kind} ${d.projection}${d.points?.length ? ` · ${d.points.length} points` : ''}${d.routes?.length ? ` · ${d.routes.length} routes` : ''}`;
      else if (l.type === 'graph') label += ` ${d.nodes?.length} nodes · ${d.edges?.length} edges${d.pulses?.length ? ` · ${d.pulses.length} pulses` : ''}`;
      else if (l.type === 'sim') label += ` ${d.kind}${d.algorithm ? ` ${d.algorithm}` : ''}`;
      else if (l.type === 'three') label += ` ${d.objects?.length} objects${d.camera?.orbit ? ' · orbit' : ''}${d.explode ? ' · explode' : ''}`;
    }
    if (l.src_preset?.startsWith('comp:')) label = `sub-composition ${l.src_preset.slice(5)}`;
    if (l.text !== undefined) label += ` "${l.text.replace(/\s+/g, ' ').slice(0, 32)}${l.text.length > 32 ? '…' : ''}"`;
    if (l.counter) label += ` counter ${l.counter.from}→${l.counter.to}`;
    const span = l.from > 0 ? ` from ${t(abs0)}` : '';
    void abs1;
    lines.push(`${'  '.repeat(depth)}${label}${span}${anims.length ? ' · ' + anims.join(' · ') : ''}`);
    if (l.children && depth < 4) for (const c of l.children) describe(c, abs0, depth + 1, budget);
  };
  ir.scenes.forEach((s) => {
    const layer = ir.layers.find((l) => l.id === s.id);
    lines.push(`S${s.index + 1} ${t(s.start)}–${t(s.end)}s ${s.preset ?? 'inline'}`);
    if (!layer) return;
    const tr = layer.anims.map((a) => `${a.n ?? 'transition'} ${t(s.start + a.s)}–${t(s.start + a.e)}`);
    if (tr.length) lines.push(`  transitions: ${tr.join(' · ')}`);
    const budget = { n: maxLayersPerScene };
    for (const c of layer.children ?? []) describe(c, s.start, 1, budget);
    if (budget.n <= 0) lines.push('  …');
  });
  for (const o of ir.layers.filter((l) => l.id.startsWith('t'))) {
    lines.push(`overlay ${o.src_preset ?? ''} ${t(o.from)}–${t(o.to)}`);
  }
  return lines.join('\n');
}
