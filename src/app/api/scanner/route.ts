import { NextResponse } from 'next/server';
import { validateHost, isRateLimited, getClientIp } from '@/lib/ssrf-guard';
import { toHost, sslScan, headersScan, subdomainScan, techScan, vulnLookup } from '@/lib/native-scans';

/**
 * OSIRIS — Scanner Proxy (Hardened)
 * Rate-limited, target-validated, scope-restricted
 */

const SCANNER_URL = process.env.SCANNER_URL || '';
const SCANNER_KEY = process.env.SCANNER_KEY || '';

// The string-based regex previously here matched only literal dotted-quad
// IPv4, missed every IPv6 form, and never resolved hostnames — so an attacker
// could bypass it with `target=metadata.example.com` (DNS A → 169.254.169.254),
// `target=2130706433` (decimal 127.0.0.1), or `target=::1`. Validation now
// canonicalises the input and resolves hostnames before deciding. See
// `src/lib/ssrf-guard.ts`.

// ── ALLOWED SCAN TYPES (safe subset only) ──
const ALLOWED_SCANS: Record<string, { endpoint: string; timeout: number }> = {
  quick:      { endpoint: '/scan/quick',      timeout: 15000 },
  ssl:        { endpoint: '/scan/ssl',        timeout: 10000 },
  headers:    { endpoint: '/scan/headers',    timeout: 10000 },
  rdns:       { endpoint: '/scan/rdns',       timeout: 8000  },
  subdomains: { endpoint: '/scan/subdomains', timeout: 15000 },
  tech:       { endpoint: '/scan/tech',       timeout: 15000 },
  whois:      { endpoint: '/scan/whois',      timeout: 10000 },
  geoloc:     { endpoint: '/scan/geoloc',     timeout: 8000  },
  vuln:       { endpoint: '/scan/vuln',       timeout: 90000 },
};

// REMOVED from public access: deep, ports, banner, traceroute
// These are dangerous in an unauthenticated context:
//   deep     → scans 65,535 ports (DDoS amplifier)
//   banner   → harvests software versions from targets using our IP
//   traceroute → reveals hosting infrastructure
//   ports    → arbitrary port range scanning

export async function GET(req: Request) {
  // 1. Without an external scanner the passive scans in native-scans.ts answer.
  //    Only types it cannot do (rdns, geoloc, quick, ...) still report 503.
  const nativeMode = !SCANNER_KEY;

  // 2. Rate limit by client IP
  const clientIp = getClientIp(req);
  if (isRateLimited(clientIp, 5, 60_000)) {
    return NextResponse.json({
      error: 'Rate limit exceeded',
      detail: `Maximum 5 scans per minute. Please wait before scanning again.`,
    }, { status: 429 });
  }

  // 3. Validate params
  const { searchParams } = new URL(req.url);
  const target = searchParams.get('target')?.trim();
  const scanType = searchParams.get('type') || 'quick';

  if (!target) {
    return NextResponse.json({ error: 'Missing target parameter' }, { status: 400 });
  }

  // 4. Block private/internal targets (DNS-resolves before deciding so a
  //    hostname pointing at a reserved range is rejected, and IPv6 + non-
  //    canonical IPv4 forms are no longer free bypasses).
  const guard = await validateHost(target);
  if (!guard.ok) {
    return NextResponse.json({
      error: 'Target blocked',
      detail: `Target validation failed: ${guard.reason}`,
    }, { status: 403 });
  }

  if (nativeMode) {
    const host = toHost(target);
    const hostCheck = host === target ? guard : await validateHost(host);
    if (!hostCheck.ok) {
      return NextResponse.json({ error: 'Target blocked', detail: `Target validation failed: ${hostCheck.reason}` }, { status: 403 });
    }
    const ip = (hostCheck.resolved ?? [])[0];
    try {
      let data: Record<string, unknown>;
      switch (scanType) {
        case 'ssl': data = await sslScan(host, ip); break;
        case 'headers': data = await headersScan(host); break;
        case 'subdomains': data = await subdomainScan(host); break;
        case 'tech': data = await techScan(host); break;
        case 'vuln': data = await vulnLookup(host, ip); break;
        default:
          return NextResponse.json({ error: 'Scanner not configured', hint: `"${scanType}" needs an external scanner. Use PORT SCAN for open ports.` }, { status: 503 });
      }
      return NextResponse.json(data);
    } catch (e: unknown) {
      return NextResponse.json({ error: 'Scan failed', detail: e instanceof Error ? e.message : String(e) }, { status: 502 });
    }
  }

  // 5. Validate scan type (only safe scans allowed)
  const scanConfig = ALLOWED_SCANS[scanType];
  if (!scanConfig) {
    return NextResponse.json({
      error: 'Scan type not available',
      detail: `"${scanType}" is restricted. Available: ${Object.keys(ALLOWED_SCANS).join(', ')}`,
      available_scans: Object.keys(ALLOWED_SCANS),
    }, { status: 403 });
  }

  // 6. Execute scan with tight timeout
  try {
    const params = new URLSearchParams({ key: SCANNER_KEY, target });
    const res = await fetch(`${SCANNER_URL}${scanConfig.endpoint}?${params.toString()}`, {
      signal: AbortSignal.timeout(scanConfig.timeout),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (e: any) {
    return NextResponse.json({
      error: 'Scanner unreachable',
      detail: e.message,
    }, { status: 502 });
  }
}
