import { NextRequest, NextResponse } from 'next/server';

/**
 * OSIRIS — ArcGIS Public Data Integration
 *
 * Two query modes:
 *   1. Search:  ?q=keyword&bbox=-105,35,-94,42
 *      Searches the ArcGIS Online catalog for public Feature Services.
 *
 *   2. Query:   ?service=<FeatureServiceURL>&bbox=-105,35,-94,42
 *      Runs a spatial query against a specific Feature Service layer and
 *      returns raw GeoJSON.
 *
 * No API key required — all requests target public data only.
 */

const ARCGIS_SEARCH_URL = 'https://www.arcgis.com/sharing/rest/search';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);

  const q = searchParams.get('q');
  const service = searchParams.get('service');
  const bbox = searchParams.get('bbox'); // "west,south,east,north"

  // ── Mode 1: Catalog Search ──────────────────────────────────────────
  if (q) {
    try {
      const params = new URLSearchParams({
        q,
        type: 'Feature Service',
        filter: 'access:public',
        num: '20',
        f: 'json',
      });
      if (bbox) params.set('bbox', bbox);

      const fetchWithRetry = async (url: string, attempts = 2) => {
        for (let i = 0; i < attempts; i++) {
          try {
            const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
            return r;
          } catch (e) {
            if (i === attempts - 1) throw e;
          }
        }
        throw new Error('All retries exhausted');
      };

      const res = await fetchWithRetry(`${ARCGIS_SEARCH_URL}?${params.toString()}`);

      if (!res.ok) {
        return NextResponse.json(
          { error: `ArcGIS search failed (${res.status})` },
          { status: res.status },
        );
      }

      const data = await res.json();

      if (data.error) {
        return NextResponse.json(
          { error: data.error.message || 'ArcGIS error' },
          { status: 502 },
        );
      }

      const results = (data.results || []).map((item: any) => ({
        id: item.id,
        title: item.title,
        url: item.url,
        snippet: item.snippet || '',
        owner: item.owner,
        numViews: item.numViews ?? 0,
        extent: item.extent,
        tags: item.tags || [],
      }));

      return NextResponse.json(
        { results },
        {
          headers: {
            'Cache-Control': 'public, s-maxage=120, stale-while-revalidate=300',
          },
        },
      );
    } catch (err: any) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        return NextResponse.json({ error: 'ArcGIS search timed out' }, { status: 504 });
      }
      return NextResponse.json({ error: err.message || 'Search failed' }, { status: 500 });
    }
  }

  // ── Mode 2: Feature Service Spatial Query ───────────────────────────
  if (service) {
    try {
      // Normalise the URL — ensure it ends with /query
      let serviceUrl = service.replace(/\/+$/, '');
      if (!serviceUrl.endsWith('/query')) {
        // If the URL points at the service root, pick layer 0 by default
        if (!/\/\d+$/.test(serviceUrl)) {
          serviceUrl += '/0';
        }
        serviceUrl += '/query';
      }

      // THIS QUERY IS WHY THE TAB CRASHED. outFields '*' returns every attribute
      // of every feature, and nothing in the dashboard renders any of them --
      // a transmission-line layer at 2000 features with full attributes is tens
      // of megabytes, and six of those imported at once took Chrome out with
      // error 61696 (renderer out of memory).
      //
      // Two changes, both server-side so the browser never receives the weight:
      // no attributes at all, and coordinates rounded to five decimals -- about
      // a metre, far finer than a line drawn at world zoom can show.
      //
      // outFields is EMPTY, not a field name. The first attempt used 'OBJECTID'
      // and every service tested rejected it with "'outFields' parameter is
      // invalid" -- there is no field name that exists everywhere. Empty is the
      // documented way to ask for geometry only, and where a service refuses it
      // the code below retries with '*' and strips the attributes here instead,
      // so the browser never sees them either way.
      // Measured on the natural-gas pipeline service, 50 features:
      // outFields='' 7,255 bytes vs outFields='*' 15,277 bytes.
      const params = new URLSearchParams({
        where: '1=1',
        geometryType: 'esriGeometryEnvelope',
        spatialRel: 'esriSpatialRelIntersects',
        inSR: '4326',
        outSR: '4326',
        outFields: '',
        returnGeometry: 'true',
        geometryPrecision: '5',
        resultRecordCount: '2000',
        f: 'geojson',
      });

      if (bbox) {
        // bbox format: "west,south,east,north"
        params.set('geometry', bbox);
      }

      let res = await fetch(`${serviceUrl}?${params.toString()}`, {
        signal: AbortSignal.timeout(20000),
      });

      // A service that will not take an empty outFields gets asked for
      // everything, and the attributes are dropped below. Slower over the wire
      // between here and Esri; identical for the browser.
      if (res.ok) {
        const peek = await res.clone().json().catch(() => null);
        if (peek?.error) {
          params.set('outFields', '*');
          res = await fetch(`${serviceUrl}?${params.toString()}`, {
            signal: AbortSignal.timeout(20000),
          });
        }
      }

      if (!res.ok) {
        return NextResponse.json(
          { error: `Feature Service query failed (${res.status})` },
          { status: res.status },
        );
      }

      const geojson = await res.json();

      // Belt and braces: some services ignore outFields. Properties are dropped
      // here as well, and the feature count and byte size are reported so the
      // client can refuse a layer instead of discovering the size by dying.
      if (Array.isArray(geojson?.features)) {
        for (const f of geojson.features) {
          if (f && typeof f === 'object') f.properties = {};
        }
      }

      if (geojson.error) {
        return NextResponse.json(
          { error: geojson.error.message || 'Feature Service error' },
          { status: 502 },
        );
      }

      return NextResponse.json(geojson, {
        headers: {
          'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120',
        },
      });
    } catch (err: any) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        return NextResponse.json({ error: 'Feature Service query timed out' }, { status: 504 });
      }
      return NextResponse.json({ error: err.message || 'Query failed' }, { status: 500 });
    }
  }

  // ── No valid mode ───────────────────────────────────────────────────
  return NextResponse.json(
    { error: 'Provide ?q=keyword or ?service=URL' },
    { status: 400 },
  );
}
