import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';

/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  POLYBOLOS SDK — Ingestion Endpoint                             ║
 * ║  Secure webhook for external platform data push                 ║
 * ║                                                                 ║
 * ║  POST /api/sdk/ingest → Accepts Polybolos-format entities       ║
 * ║  from external systems (e.g., Anduril Lattice) and merges       ║
 * ║  them into the Common Operating Picture.                        ║
 * ║                                                                 ║
 * ║  GET  /api/sdk/ingest → Returns current SDK entity count        ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

// Share the entity store with the stream endpoint
const globalForSDK = globalThis as unknown as {
  sdkEntityStore: Map<string, any>;
  sdkLastUpdate: number;
  sdkIngestLog: Array<{ source: string; count: number; timestamp: string }>;
};

if (!globalForSDK.sdkEntityStore) {
  globalForSDK.sdkEntityStore = new Map();
  globalForSDK.sdkLastUpdate = Date.now();
}
if (!globalForSDK.sdkIngestLog) {
  globalForSDK.sdkIngestLog = [];
}

// Fail-closed: require SDK_INGEST_KEY env var, disable endpoint when unset
const SDK_KEY = process.env.SDK_INGEST_KEY;
const VALID_KEYS = SDK_KEY ? new Set([SDK_KEY]) : null;
const MAX_ENTITIES_PER_POST = 1000;
const MAX_STORE = 5000; // oldest entity goes first; the stream only ever sends 500 anyway

function keyMatches(given: unknown): boolean {
  if (typeof given !== 'string' || !SDK_KEY) return false;
  const a = Buffer.from(given), b = Buffer.from(SDK_KEY);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    // Validate structure
    if (!body.source || !body.apiKey || !Array.isArray(body.entities)) {
      return NextResponse.json({
        accepted: 0,
        rejected: 0,
        errors: ['Invalid payload structure. Required: { source, apiKey, entities[] }'],
        timestamp: new Date().toISOString(),
      }, { status: 400 });
    }

    // Validate API key (fail-closed: endpoint disabled when SDK_INGEST_KEY is unset)
    if (!VALID_KEYS) {
      return NextResponse.json({
        accepted: 0,
        rejected: 0,
        errors: ['Ingest endpoint disabled — SDK_INGEST_KEY not configured'],
        timestamp: new Date().toISOString(),
      }, { status: 503 });
    }
    if (!keyMatches(body.apiKey)) {
      return NextResponse.json({
        accepted: 0,
        rejected: 0,
        errors: ['Invalid API key'],
        timestamp: new Date().toISOString(),
      }, { status: 401 });
    }

    let accepted = 0;
    let rejected = 0;
    const errors: string[] = [];

    if (body.entities.length > MAX_ENTITIES_PER_POST) {
      return NextResponse.json({
        accepted: 0, rejected: body.entities.length,
        errors: [`Too many entities in one request (max ${MAX_ENTITIES_PER_POST})`],
        timestamp: new Date().toISOString(),
      }, { status: 413 });
    }

    for (const entity of body.entities) {
      // Validate minimum required fields. 0 is a real latitude and longitude, so test finiteness, not truthiness.
      const lat = Number(entity?.position?.lat), lng = Number(entity?.position?.lng);
      if (!entity?.id || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
        rejected++;
        errors.push(`Entity missing required fields (id, position.lat, position.lng): ${entity.id || 'unknown'}`);
        continue;
      }

      // Normalize and store
      const normalized = {
        id: `ext-${body.source}-${entity.id}`,
        name: entity.name || `ENTITY-${entity.id}`,
        domain: entity.domain || 'LAND',
        entityType: entity.entityType || 'TRACK',
        position: {
          lat,
          lng,
          alt: entity.position.alt,
          heading: entity.position.heading,
          speed: entity.position.speed,
        },
        threat: entity.threat || 'NONE',
        classification: entity.classification || 'UNCLASSIFIED',
        source: {
          provider: body.source,
          feed: 'ingest-api',
          originalId: entity.id,
          confidence: entity.confidence || 0.8,
        },
        timestamp: entity.timestamp || new Date().toISOString(),
        properties: entity.properties || {},
        display: entity.display || {
          color: '#D4AF37',
          icon: 'dot-gold',
          layerType: 'circle',
          glow: false,
          scale: 1.0,
        },
      };

      globalForSDK.sdkEntityStore.delete(normalized.id); // re-insert so an updated entity counts as newest
      globalForSDK.sdkEntityStore.set(normalized.id, normalized);
      if (globalForSDK.sdkEntityStore.size > MAX_STORE) {
        const oldest = globalForSDK.sdkEntityStore.keys().next().value;
        if (oldest !== undefined) globalForSDK.sdkEntityStore.delete(oldest);
      }
      accepted++;
    }

    // Update timestamp to trigger SSE push
    globalForSDK.sdkLastUpdate = Date.now();

    // Log ingestion
    globalForSDK.sdkIngestLog.push({
      source: body.source,
      count: accepted,
      timestamp: new Date().toISOString(),
    });
    // Keep log to last 100 entries
    if (globalForSDK.sdkIngestLog.length > 100) {
      globalForSDK.sdkIngestLog = globalForSDK.sdkIngestLog.slice(-100);
    }

    return NextResponse.json({
      accepted,
      rejected,
      errors: errors.slice(0, 10), // Limit error list
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    return NextResponse.json({
      accepted: 0,
      rejected: 0,
      errors: [`Server error: ${e instanceof Error ? e.message : 'Unknown'}`],
      timestamp: new Date().toISOString(),
    }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({
    sdk: 'polybolos',
    version: '1.0.0',
    entityCount: globalForSDK.sdkEntityStore.size,
    recentIngestions: globalForSDK.sdkIngestLog.slice(-10),
    timestamp: new Date().toISOString(),
  });
}
