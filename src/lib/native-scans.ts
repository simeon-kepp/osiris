import tls from 'node:tls';
import { safeFetch } from '@/lib/ssrf-guard';

/**
 * Recon scans that run inside DINGIR, with no external scanner service.
 *
 * Everything here is passive or a single ordinary request to the target: one TLS
 * handshake, one HTTP GET, one certificate-transparency query, one InternetDB lookup.
 * Nothing probes ports or sends exploit traffic. Callers must run `validateHost`
 * first and pass the addresses it resolved, so the connection goes to the address
 * that was checked and not to a second DNS answer.
 */

/** `https://a.example/x` and `a.example` both become `a.example`. */
export function toHost(target: string): string {
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(target) ? target : `https://${target}`).hostname;
  } catch {
    return target;
  }
}

const UA = 'DINGIR-Recon/1.0 (+https://rfi-irfos.com)';

/* ── SSL/TLS ───────────────────────────────────────────────── */

export async function sslScan(host: string, ip: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: ip, port: 443, servername: host, rejectUnauthorized: false, timeout: 8000 }, () => {
      const cert = socket.getPeerCertificate(true);
      const cipher = socket.getCipher();
      const notAfter = cert?.valid_to ? new Date(cert.valid_to) : null;
      const daysLeft = notAfter ? Math.floor((notAfter.getTime() - Date.now()) / 86_400_000) : null;
      const sans = (cert?.subjectaltname || '').split(',').map(s => s.trim().replace(/^DNS:/, '')).filter(Boolean);
      const out = {
        target: host,
        ip,
        protocol: socket.getProtocol(),
        cipher: cipher?.name,
        valid: socket.authorized,
        trust_error: socket.authorized ? undefined : String(socket.authorizationError),
        issuer: cert?.issuer ? [cert.issuer.O, cert.issuer.CN].filter(Boolean).join(' · ') : undefined,
        subject: cert?.subject?.CN,
        not_before: cert?.valid_from,
        expires: cert?.valid_to,
        days_left: daysLeft,
        expiring_soon: daysLeft !== null && daysLeft < 21,
        sans,
        fingerprint_sha256: cert?.fingerprint256,
        key_bits: (cert as { bits?: number })?.bits,
      };
      socket.end();
      resolve(out);
    });
    socket.on('timeout', () => { socket.destroy(); reject(new Error('TLS handshake timed out')); });
    socket.on('error', reject);
  });
}

/* ── HTTP security headers ─────────────────────────────────── */

const SECURITY_HEADERS: { key: string; label: string; weight: number }[] = [
  { key: 'strict-transport-security', label: 'HSTS', weight: 2 },
  { key: 'content-security-policy', label: 'CSP', weight: 2 },
  { key: 'x-frame-options', label: 'X-Frame-Options', weight: 1 },
  { key: 'x-content-type-options', label: 'X-Content-Type-Options', weight: 1 },
  { key: 'referrer-policy', label: 'Referrer-Policy', weight: 1 },
  { key: 'permissions-policy', label: 'Permissions-Policy', weight: 1 },
];

export async function headersScan(host: string): Promise<Record<string, unknown>> {
  const res = await safeFetch(`https://${host}/`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(9000) });
  const present: Record<string, string> = {};
  const missing: string[] = [];
  let score = 0;
  const max = SECURITY_HEADERS.reduce((n, h) => n + h.weight, 0);
  for (const h of SECURITY_HEADERS) {
    const v = res.headers.get(h.key);
    if (v) { present[h.label] = v.slice(0, 200); score += h.weight; } else missing.push(h.label);
  }
  const ratio = score / max;
  const grade = ratio >= 0.95 ? 'A' : ratio >= 0.75 ? 'B' : ratio >= 0.5 ? 'C' : ratio >= 0.25 ? 'D' : 'F';
  // Headers that tell an attacker what runs here.
  const disclosure: Record<string, string> = {};
  for (const k of ['server', 'x-powered-by', 'x-aspnet-version', 'x-generator']) {
    const v = res.headers.get(k);
    if (v) disclosure[k] = v;
  }
  return {
    target: host,
    status: res.status,
    grade,
    score: `${score}/${max}`,
    present,
    missing,
    information_disclosure: disclosure,
    all_headers: Object.fromEntries(res.headers.entries()),
  };
}

/* ── Subdomains (certificate transparency) ─────────────────── */

export async function subdomainScan(host: string): Promise<Record<string, unknown>> {
  // The registrable part is a guess (last two labels); good enough for crt.sh's wildcard query.
  const parts = host.split('.');
  const base = parts.length > 2 ? parts.slice(-2).join('.') : host;
  const res = await fetch(`https://crt.sh/?q=${encodeURIComponent(`%.${base}`)}&output=json`, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`crt.sh answered ${res.status}`);
  const rows: { name_value?: string }[] = await res.json();
  const names = new Set<string>();
  for (const r of rows) {
    for (const n of (r.name_value || '').split('\n')) {
      const clean = n.trim().toLowerCase().replace(/^\*\./, '');
      if (clean.endsWith(base)) names.add(clean);
    }
  }
  const subdomains = [...names].sort();
  return { target: base, source: 'crt.sh (certificate transparency)', count: subdomains.length, subdomains: subdomains.slice(0, 300), truncated: subdomains.length > 300 };
}

/* ── Technology fingerprint ────────────────────────────────── */

const BODY_SIGNATURES: { name: string; re: RegExp }[] = [
  { name: 'WordPress', re: /wp-content|wp-includes/i },
  { name: 'Next.js', re: /_next\/static|__NEXT_DATA__/ },
  { name: 'React', re: /data-reactroot|react(\.production|-dom)/i },
  { name: 'Vue.js', re: /vue(\.runtime)?(\.min)?\.js|data-v-[0-9a-f]{6}/i },
  { name: 'Angular', re: /ng-version=|ng-app/i },
  { name: 'jQuery', re: /jquery[.-][\d.]*(min\.)?js/i },
  { name: 'Bootstrap', re: /bootstrap(\.min)?\.(css|js)/i },
  { name: 'Tailwind CSS', re: /tailwind/i },
  { name: 'Shopify', re: /cdn\.shopify\.com|Shopify\.theme/ },
  { name: 'Google Analytics', re: /googletagmanager\.com|google-analytics\.com|gtag\(/ },
  { name: 'Matomo', re: /matomo|piwik/i },
  { name: 'Cloudflare', re: /cdn-cgi\//i },
  { name: 'Drupal', re: /Drupal\.settings|sites\/default\/files/ },
  { name: 'Joomla', re: /\/media\/jui\/|Joomla!/ },
];

export async function techScan(host: string): Promise<Record<string, unknown>> {
  const res = await safeFetch(`https://${host}/`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(9000) });
  const html = (await res.text()).slice(0, 300_000);
  const found = new Map<string, string>();
  const add = (name: string, evidence: string) => { if (!found.has(name)) found.set(name, evidence); };

  const server = res.headers.get('server');
  if (server) add(server.split('/')[0], `Server: ${server}`);
  const powered = res.headers.get('x-powered-by');
  if (powered) add(powered.split('/')[0], `X-Powered-By: ${powered}`);
  if (res.headers.get('cf-ray')) add('Cloudflare', 'cf-ray header');
  if (res.headers.get('x-vercel-id')) add('Vercel', 'x-vercel-id header');
  const gen = html.match(/<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)/i)?.[1];
  if (gen) add(gen, 'meta generator');
  for (const s of BODY_SIGNATURES) if (s.re.test(html)) add(s.name, 'page source');

  return {
    target: host,
    status: res.status,
    technologies: [...found.entries()].map(([name, evidence]) => ({ name, evidence })),
    title: html.match(/<title[^>]*>([^<]{0,160})/i)?.[1]?.trim(),
  };
}

/* ── Known CVEs for an address (passive, InternetDB) ───────── */

export async function vulnLookup(host: string, ip: string): Promise<Record<string, unknown>> {
  const res = await fetch(`https://internetdb.shodan.io/${encodeURIComponent(ip)}`, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(9000),
  });
  if (res.status === 404) {
    return { target: host, ip, vulnerabilities: [], risk_level: 'NONE', note: 'No record for this address in Shodan InternetDB.' };
  }
  if (!res.ok) throw new Error(`InternetDB answered ${res.status}`);
  const db: { ports?: number[]; vulns?: string[]; cpes?: string[] } = await res.json();
  const vulns = db.vulns ?? [];
  return {
    target: host,
    ip,
    source: 'Shodan InternetDB · passive lookup, nothing was scanned',
    open_ports: db.ports ?? [],
    cpes: db.cpes ?? [],
    vulnerabilities: vulns.map(id => ({ id, type: 'cve' })),
    risk_level: vulns.length === 0 ? 'NONE' : vulns.length < 5 ? 'MODERATE' : 'HIGH',
  };
}
