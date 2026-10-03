import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../core/config';
import type { IRFont } from '../ir/types';

const LATIN = 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';
const LATIN_EXT = 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF';

export const fontsourceDir = (pkg: string) => path.join(ROOT, 'node_modules', '@fontsource', pkg, 'files');

const slugOf = (family: string) => family.trim().toLowerCase().replace(/\s+/g, '-');

function availableWeights(pkg: string): number[] {
  const dir = fontsourceDir(pkg);
  if (!fs.existsSync(dir)) return [];
  const ws = new Set<number>();
  for (const f of fs.readdirSync(dir)) {
    const m = new RegExp(`^${pkg}-latin-(\\d+)-normal\\.woff2$`).exec(f);
    if (m) ws.add(Number(m[1]));
  }
  return [...ws].sort((a, b) => a - b);
}

/**
 * Replace Google font requests with locally installed @fontsource files when available
 * (offline, deterministic). Anything else is left for the player to fetch.
 */
export function resolveFonts(fonts: IRFont[], baseUrl: string, assetUrl: (id: string) => string | null): (IRFont & { weight?: number; unicodeRange?: string })[] {
  const out: (IRFont & { weight?: number; unicodeRange?: string })[] = [];
  for (const f of fonts) {
    if ((f as any).asset) {
      const id = String((f as any).asset).replace(/^asset:/, '');
      const url = assetUrl(id);
      if (url) out.push({ family: f.family, source: 'url', url, weight: f.weights?.[0] });
      continue;
    }
    if (f.source === 'system') continue;
    if (f.source === 'google') {
      const pkg = slugOf(f.family);
      const avail = availableWeights(pkg);
      if (avail.length) {
        const want = f.weights?.length ? f.weights : [400, 700];
        const picked = new Set(want.map((w) => avail.reduce((best, a) => (Math.abs(a - w) < Math.abs(best - w) ? a : best), avail[0])));
        for (const w of picked) {
          out.push({ family: f.family, source: 'url', url: `${baseUrl}/v1/fonts/${pkg}/${pkg}-latin-${w}-normal.woff2`, weight: w, unicodeRange: LATIN });
          if (fs.existsSync(path.join(fontsourceDir(pkg), `${pkg}-latin-ext-${w}-normal.woff2`))) {
            out.push({ family: f.family, source: 'url', url: `${baseUrl}/v1/fonts/${pkg}/${pkg}-latin-ext-${w}-normal.woff2`, weight: w, unicodeRange: LATIN_EXT });
          }
        }
        continue;
      }
    }
    out.push(f);
  }
  return out;
}
