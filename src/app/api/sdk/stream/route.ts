import { NextResponse } from 'next/server';
import { currentLogin } from '@/lib/dingirSessionServer';

/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  POLYBOLOS SDK — SSE Stream Endpoint                            ║
 * ║  Server-Sent Events for real-time entity streaming              ║
 * ║                                                                 ║
 * ║  GET /api/sdk/stream → Opens an SSE connection that pushes      ║
 * ║  normalized Polybolos entities to the client in real-time.       ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

// In-memory entity store shared across the SDK endpoints
const globalForSDK = globalThis as unknown as {
  sdkEntityStore: Map<string, any>;
  sdkLastUpdate: number;
};

if (!globalForSDK.sdkEntityStore) {
  globalForSDK.sdkEntityStore = new Map();
  globalForSDK.sdkLastUpdate = Date.now();
}

export const dynamic = 'force-dynamic';

const MAX_STREAMS = 50;
let openStreams = 0;

export async function GET(request: Request) {
  // Partner-pushed entities are not public data. 404 rather than 403, like the rest of the gated surface.
  if (!(await currentLogin())) return new NextResponse(null, { status: 404 });
  if (openStreams >= MAX_STREAMS) return new NextResponse('Too many streams', { status: 503 });
  openStreams++;
  const encoder = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let entityPush: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  // One cleanup for every exit: client disconnect, cancel(), or a failed enqueue.
  // Without it the two intervals outlived the connection and ran for ever.
  const close = () => {
    if (closed) return;
    closed = true;
    openStreams--;
    clearInterval(heartbeat);
    clearInterval(entityPush);
  };
  request.signal.addEventListener('abort', close);

  const stream = new ReadableStream({
    start(controller) {
      // Send initial status
      const statusEvent = {
        type: 'status',
        timestamp: new Date().toISOString(),
        payload: {
          connected: true,
          entityCount: globalForSDK.sdkEntityStore.size,
          feedCount: 9,
          latticeStatus: 'disconnected',
          lastUpdate: new Date().toISOString(),
          uptime: Date.now() - globalForSDK.sdkLastUpdate,
        },
      };
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(statusEvent)}\n\n`));

      // Send heartbeat every 15 seconds
      heartbeat = setInterval(() => {
        try {
          const hb = {
            type: 'heartbeat',
            timestamp: new Date().toISOString(),
            payload: { entityCount: globalForSDK.sdkEntityStore.size },
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(hb)}\n\n`));
        } catch {
          close();
        }
      }, 15000);

      // Send entity updates every 5 seconds if data has changed
      let lastSentVersion = 0;
      entityPush = setInterval(() => {
        try {
          if (globalForSDK.sdkLastUpdate > lastSentVersion) {
            lastSentVersion = globalForSDK.sdkLastUpdate;
            const entities = Array.from(globalForSDK.sdkEntityStore.values()).slice(0, 500);
            const event = {
              type: 'entity_update',
              timestamp: new Date().toISOString(),
              payload: entities,
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          }
        } catch {
          close();
        }
      }, 5000);
    },
    cancel() { close(); },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
