import { NextRequest, NextResponse } from 'next/server';
import https from 'https';
import http from 'http';
import { execFile } from 'child_process';

export const dynamic = 'force-dynamic';
export const maxDuration = 15;

/**
 * CCTV image proxy — bypasses CORS / hotlink protection on camera CDNs.
 * Whitelisted domains only to prevent open-proxy abuse.
 *
 * The allowlist is enforced on EVERY hop. Checking only the first URL let an
 * allowed host redirect the server to 127.0.0.1 or a metadata address.
 */
const ALLOWED_HOSTS = [
  'cdn.skylinewebcams.com',
  'cdn2.skylinewebcams.com',
  's3-eu-west-1.amazonaws.com',
  'voyage.aprr.fr',
  'thb.gov.tw',
  'etraffic.dgt.es',
];

// THB servers send non-standard HTTP headers that Node's strict parser rejects.
// These need special handling via curl fallback.
const LENIENT_HOSTS = ['thb.gov.tw'];

const MAX_BYTES = 3 * 1024 * 1024;
const MAX_HOPS = 3;

type Fetched = { status: number; contentType: string; data: Buffer };

function isAllowed(hostname: string): boolean {
  return ALLOWED_HOSTS.some(h => hostname === h || hostname.endsWith('.' + h));
}

function needsLenientParsing(hostname: string): boolean {
  return LENIENT_HOSTS.some(h => hostname === h || hostname.endsWith('.' + h));
}

/** Parse and check one hop. Throws on anything outside the allowlist. */
function checkHop(url: string): URL {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('blocked protocol');
  if (!isAllowed(parsed.hostname.toLowerCase())) throw new Error('blocked host ' + parsed.hostname);
  return parsed;
}

/** Standard proxy for well-behaved servers. Certificates are verified. */
function proxyFetch(url: string, referer: string, hops = 0): Promise<Fetched> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try { parsed = checkHop(url); } catch (e) { reject(e); return; }
    const mod = parsed.protocol === 'https:' ? https : http;

    const req = mod.get(parsed.toString(), {
      headers: {
        'Accept': 'image/*,*/*',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Referer': referer,
      },
      timeout: 12000,
    }, (res) => {
      const code = res.statusCode || 502;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        if (hops >= MAX_HOPS) { reject(new Error('too many redirects')); return; }
        let next: string;
        try { next = new URL(res.headers.location, parsed).toString(); } catch (e) { reject(e); return; }
        proxyFetch(next, referer, hops + 1).then(resolve).catch(reject);
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BYTES) { req.destroy(); reject(new Error('response too large')); return; }
        chunks.push(chunk);
      });
      res.on('end', () => {
        resolve({
          status: code,
          contentType: String(res.headers['content-type'] || 'image/jpeg'),
          data: Buffer.concat(chunks),
        });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

/** Lenient proxy using curl for servers with non-standard HTTP headers.
 *  curl does not follow redirects itself: -w appends the status and redirect
 *  target after the body, and every hop goes through checkHop. -k stays for
 *  these hosts only, whose certificate chains are broken. */
function curlFetch(url: string, hops = 0): Promise<Fetched> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try { parsed = checkHop(url); } catch (e) { reject(e); return; }
    execFile('curl', [
      '-s', '-k', '--max-time', '10', '--max-filesize', String(MAX_BYTES),
      '--proto', '=http,https', '-w', '\n%{http_code} %{redirect_url}', '--', parsed.toString(),
    ], { maxBuffer: MAX_BYTES + 1024, timeout: 12000, encoding: 'buffer' }, (err, stdout) => {
      if (err) { reject(err); return; }
      const cut = stdout.lastIndexOf(0x0a);
      if (cut < 0) { reject(new Error('curl: no trailer')); return; }
      const [codeStr, ...rest] = stdout.subarray(cut + 1).toString().split(' ');
      const code = Number(codeStr) || 502;
      const location = rest.join(' ').trim();
      if (code >= 300 && code < 400 && location) {
        if (hops >= MAX_HOPS) { reject(new Error('too many redirects')); return; }
        curlFetch(location, hops + 1).then(resolve).catch(reject);
        return;
      }
      resolve({ status: code, contentType: 'image/jpeg', data: stdout.subarray(0, cut) });
    });
  });
}

export async function GET(request: NextRequest) {
  const url = request.nextUrl.searchParams.get('url');

  if (!url) {
    return NextResponse.json({ error: 'Missing url parameter' }, { status: 400 });
  }

  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return NextResponse.json({ error: 'Invalid URL' }, { status: 400 });
  }

  if (!isAllowed(target.hostname.toLowerCase())) {
    return NextResponse.json({ error: 'Forbidden domain: ' + target.hostname }, { status: 403 });
  }

  try {
    const result = needsLenientParsing(target.hostname.toLowerCase())
      ? await curlFetch(target.toString())
      : await proxyFetch(target.toString(), `https://${target.hostname}/`);

    if (result.status >= 400) {
      return NextResponse.json({ error: `Upstream ${result.status}` }, { status: result.status });
    }
    // Only images leave this proxy. s3-eu-west-1.amazonaws.com is a shared host,
    // so without this a bucket could serve HTML from our origin.
    if (!/^image\//i.test(result.contentType)) {
      return NextResponse.json({ error: 'Upstream is not an image' }, { status: 415 });
    }

    // Buffer is a Uint8Array underneath, but it is not a BodyInit; handing over
    // the underlying bytes says what is actually being sent.
    return new NextResponse(new Uint8Array(result.data), {
      status: 200,
      headers: {
        'Content-Type': result.contentType,
        'Cache-Control': 'public, max-age=5, stale-while-revalidate=10',
        'Access-Control-Allow-Origin': '*',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'",
      },
    });
  } catch (error: any) {
    console.error('Camera proxy error:', error?.message || error);
    return NextResponse.json({ error: 'Proxy failed: ' + (error?.message || 'unknown') }, { status: 502 });
  }
}
