import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * Starting points for the Entity Intel panel, taken from what the live feeds show right now:
 * conflict zones with fresh reports, countries under cyber attack, and the targeted IPs with the
 * highest severity. Reads the same public feed routes the map uses, so nothing here is new data.
 */

const BASE = `http://127.0.0.1:${process.env.PORT || 3005}`;

// Conflict-zone ids that are not a country name the intel layer resolves are left out on purpose.
const ZONE_COUNTRY: Record<string, string> = {
  ukraine: 'Ukraine', lebanon: 'Lebanon', sudan: 'Sudan', myanmar: 'Myanmar', yemen: 'Yemen',
  syria: 'Syria', somalia: 'Somalia', iraq: 'Iraq', ethiopia: 'Ethiopia', taiwan: 'Taiwan',
};

export interface Suggestion { type: 'country' | 'ip'; id: string; note: string }
export interface SuggestionGroup { title: string; items: Suggestion[] }

let cache: { at: number; groups: SuggestionGroup[] } | null = null;

async function feed<T>(route: string): Promise<T | null> {
  try {
    const r = await fetch(`${BASE}/api/${route}`, { signal: AbortSignal.timeout(12_000), cache: 'no-store' });
    return r.ok ? await r.json() as T : null;
  } catch { return null; }
}

async function build(): Promise<SuggestionGroup[]> {
  const [conf, cyber] = await Promise.all([
    feed<{ zones?: Array<{ id: string; region: string; severity: string; events?: unknown[] }> }>('conflicts'),
    feed<{ attacks?: Array<{ target_country?: string; target_ip?: string; severity?: number; malware?: string }> }>('cyber-attacks'),
  ]);
  const groups: SuggestionGroup[] = [];

  const zones = (conf?.zones ?? [])
    .filter(z => ZONE_COUNTRY[z.region])
    .map(z => ({ name: ZONE_COUNTRY[z.region], n: z.events?.length ?? 0, sev: z.severity }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 5);
  if (zones.length) groups.push({ title: 'Conflict zones with fresh reports', items: zones.map(z => ({ type: 'country', id: z.name, note: z.n ? `${z.n} report${z.n === 1 ? '' : 's'}` : z.sev })) });

  const attacks = cyber?.attacks ?? [];
  if (attacks.length) {
    const names = new Intl.DisplayNames(['en'], { type: 'region' });
    const byCountry = new Map<string, number>();
    for (const a of attacks) if (a.target_country) byCountry.set(a.target_country, (byCountry.get(a.target_country) ?? 0) + 1);
    const top = [...byCountry.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
    const items: Suggestion[] = [];
    for (const [code, n] of top) {
      let name = code;
      try { name = names.of(code) || code; } catch { /* not a region code */ }
      if (name !== code) items.push({ type: 'country', id: name, note: `${n} attacks` });
    }
    if (items.length) groups.push({ title: 'Targeted by cyber attacks now', items });

    const seen = new Set<string>();
    const ips: Suggestion[] = [];
    for (const a of [...attacks].sort((x, y) => (y.severity ?? 0) - (x.severity ?? 0))) {
      if (!a.target_ip || seen.has(a.target_ip)) continue;
      seen.add(a.target_ip);
      ips.push({ type: 'ip', id: a.target_ip, note: a.malware ?? 'attack' });
      if (ips.length === 4) break;
    }
    if (ips.length) groups.push({ title: 'Most severe attack targets', items: ips });
  }
  return groups;
}

export async function GET() {
  if (!cache || Date.now() - cache.at > 60_000) cache = { at: Date.now(), groups: await build() };
  return NextResponse.json({ groups: cache.groups }, { headers: { 'Cache-Control': 'no-store' } });
}
