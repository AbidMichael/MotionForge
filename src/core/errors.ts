/** Errors carry a status code and, for validation, a list of path-addressed issues. */
export interface Issue {
  path: string;
  msg: string;
}

export class MFError extends Error {
  constructor(
    public status: number,
    message: string,
    public issues: Issue[] = [],
    public hint?: string,
  ) {
    super(message);
  }
}

export const notFound = (what: string, hint?: string) => new MFError(404, `${what} not found`, [], hint);
export const badRequest = (msg: string, issues: Issue[] = [], hint?: string) => new MFError(400, msg, issues, hint);
export const forbidden = (msg: string) => new MFError(403, msg);

export const fmtIssue = (i: Issue) => (i.path ? `${i.path}: ${i.msg}` : i.msg);

export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

export function didYouMean(input: string, candidates: Iterable<string>, max = 3): string[] {
  const scored: [string, number][] = [];
  for (const c of candidates) {
    const d = levenshtein(input.toLowerCase(), c.toLowerCase());
    const limit = Math.max(2, Math.floor(c.length / 3));
    if (d <= limit || c.includes(input) || input.includes(c)) scored.push([c, d]);
  }
  return scored.sort((a, b) => a[1] - b[1]).slice(0, max).map((s) => s[0]);
}
