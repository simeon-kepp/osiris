/**
 * ═══════════════════════════════════════════════════════════════
 *  DINGIR — web context for the chat
 *
 *  Two ways the web reaches the analyst:
 *  - search: the provider's own web plugin (OpenRouter), switched on by the
 *    globe toggle in the chat header or by a question that asks for it;
 *  - links: a URL the operator pastes is fetched here, server-side, and its
 *    text handed to the model as FETCHED PAGES.
 *
 *  Fetching runs on the Colony, next to the engine on :8080 and intel on
 *  :4000, so every hop is checked against private address space. Otherwise
 *  "summarise http://127.0.0.1:8080/..." would read our own services.
 * ═══════════════════════════════════════════════════════════════
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { FetchedPage } from './ai-engine';

const MAX_URLS = 3;
const MAX_REDIRECTS = 3;
const MAX_BYTES = 2_000_000;
const MAX_TEXT = 12_000;
const TIMEOUT_MS = 10_000;

/** Questions that ask for the web by name. The toggle covers everything else. */
const WEB_CUES =
  /\b(googl\w*|such\w*\s+(im|online|nach)|recherchier\w*|im\s+(web|netz|internet)|search\s+(the\s+)?(web|online|for)|look\s+up|websuche|web\s*search)\b/i;

export function wantsWebSearch(query: string): boolean {
  return WEB_CUES.test(query);
}

export function extractUrls(text: string): string[] {
  const found = text.match(/https?:\/\/[^\s<>"'()\]]+/gi) ?? [];
  const cleaned = found.map(u => u.replace(/[.,;:!?]+$/, ''));
  return [...new Set(cleaned)].slice(0, MAX_URLS);
}

/** Loopback, private, link-local, CGNAT, multicast, reserved, and the v6 equivalents. */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    if (x === '::' || x === '::1') return true;
    const mapped = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return /^(fc|fd|fe[89ab]|ff)/.test(x);
  }
  return true; // not an IP at all: refuse rather than guess
}

async function assertPublicHost(url: URL): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('only http(s) links');
  if (url.username || url.password) throw new Error('links with credentials are not fetched');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addrs.length || addrs.some(a => isPrivateAddress(a.address))) {
    throw new Error('internal address');
  }
}

export function htmlToText(html: string): { title: string; text: string } {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').replace(/\s+/g, ' ').trim();
  const text = html
    .replace(/<(script|style|noscript|svg|head|nav|footer)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
  return { title, text: text.slice(0, MAX_TEXT) };
}

async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) { await reader.cancel(); break; }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** One page. Redirects are followed by hand so every hop is checked again. */
export async function fetchPage(raw: string): Promise<FetchedPage> {
  let url = new URL(raw);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicHost(url);
    const res = await fetch(url, {
      redirect: 'manual',
      headers: { 'User-Agent': 'DINGIR-analyst/1.0 (+https://rfi-irfos.com)', Accept: 'text/html,text/plain,application/json;q=0.8' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const next = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && next) {
      url = new URL(next, url);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = res.headers.get('content-type') ?? '';
    if (!/text\/|json|xml/i.test(type)) throw new Error(`not a text page (${type.split(';')[0] || 'unknown'})`);
    const body = await readCapped(res);
    if (/html/i.test(type)) {
      const { title, text } = htmlToText(body);
      return { url: url.href, title, text };
    }
    return { url: url.href, title: '', text: body.slice(0, MAX_TEXT) };
  }
  throw new Error('too many redirects');
}

/** Every link in the question, fetched in parallel. A failure becomes a line the
 *  model can report ("could not open X: ...") instead of a silent omission. */
export async function fetchLinkedPages(query: string): Promise<FetchedPage[]> {
  const urls = extractUrls(query);
  const settled = await Promise.allSettled(urls.map(fetchPage));
  return settled.map((r, i) =>
    r.status === 'fulfilled'
      ? r.value
      : { url: urls[i], title: '', text: `[could not open this link: ${r.reason instanceof Error ? r.reason.message : 'error'}]` }
  );
}
