import { NextResponse } from 'next/server';
import { cachedRoute } from '@/lib/routeCache';

/**
 * OSIRIS — SCM Supplier Risk Overlay
 * Calculates intersection between live global threats (Earthquakes, Fires, Conflicts)
 * and static Tier 1/2 Supplier coordinates.
 */

const SUPPLIERS = [
  // Semiconductor & Electronics (Taiwan, Korea, Japan)
  { id: 'sup-tsmc-hsinchu', name: 'TSMC Fab 12 (Tier 1)', city: 'Hsinchu', country: 'Taiwan', lat: 24.774, lng: 120.992, category: 'Semiconductor' },
  { id: 'sup-tsmc-tainan', name: 'TSMC Fab 14 (Tier 1)', city: 'Tainan', country: 'Taiwan', lat: 23.111, lng: 120.273, category: 'Semiconductor' },
  { id: 'sup-sec-giheung', name: 'Samsung Electronics (Tier 1)', city: 'Giheung', country: 'South Korea', lat: 37.221, lng: 127.098, category: 'Semiconductor' },
  { id: 'sup-sk-icheon', name: 'SK Hynix (Tier 1)', city: 'Icheon', country: 'South Korea', lat: 37.256, lng: 127.483, category: 'Semiconductor' },
  { id: 'sup-sony-kumamoto', name: 'Sony Semiconductor (Tier 2)', city: 'Kikuyo', country: 'Japan', lat: 32.883, lng: 130.825, category: 'Electronics' },
  { id: 'sup-mlcc-murata', name: 'Murata MLCC (Tier 2)', city: 'Izumo', country: 'Japan', lat: 35.361, lng: 132.756, category: 'Electronics' },
  
  // Automotive & Machinery (Europe, Mexico)
  { id: 'sup-bosch-stuttgart', name: 'Bosch Auto Parts (Tier 1)', city: 'Stuttgart', country: 'Germany', lat: 48.815, lng: 9.176, category: 'Automotive' },
  { id: 'sup-zf-bavaria', name: 'ZF Friedrichshafen (Tier 1)', city: 'Friedrichshafen', country: 'Germany', lat: 47.662, lng: 9.489, category: 'Automotive' },
  { id: 'sup-valeo-paris', name: 'Valeo R&D (Tier 2)', city: 'Paris', country: 'France', lat: 48.878, lng: 2.308, category: 'Automotive' },
  { id: 'sup-magna-celaya', name: 'Magna Assembly (Tier 2)', city: 'Celaya', country: 'Mexico', lat: 20.525, lng: -100.814, category: 'Automotive' },
  { id: 'sup-denso-monterrey', name: 'Denso Corp (Tier 1)', city: 'Monterrey', country: 'Mexico', lat: 25.772, lng: -100.174, category: 'Automotive' },

  // Battery & Energy (China, US)
  { id: 'sup-catl-ningde', name: 'CATL Battery HQ (Tier 1)', city: 'Ningde', country: 'China', lat: 26.666, lng: 119.544, category: 'Battery' },
  { id: 'sup-byd-shenzhen', name: 'BYD Gigafactory (Tier 1)', city: 'Shenzhen', country: 'China', lat: 22.684, lng: 114.341, category: 'Battery' },
  { id: 'sup-panasonic-nevada', name: 'Panasonic Giga (Tier 1)', city: 'Sparks', country: 'US', lat: 39.539, lng: -119.439, category: 'Battery' },
];

const ORIGIN = `http://127.0.0.1:${process.env.PORT || 3005}`;

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
}

async function compute() {
  const dynamicSuppliers = [...SUPPLIERS].map(s => ({ ...s, risk_level: 'NORMAL', active_threats: [] as string[] }));
  // A feed that could not be read is reported, not silently treated as "no threat":
  // an all-NORMAL answer with a 200 looks exactly like a calm world.
  const unavailable: string[] = [];

  // Fast distance approximation (km)
  const getDistanceKm = (lat1: number, lng1: number, lat2: number, lng2: number) => {
    const dx = (lng1 - lng2) * Math.cos((lat1 + lat2) / 2 * Math.PI / 180);
    const dy = lat1 - lat2;
    return Math.sqrt(dx * dx + dy * dy) * 111.32;
  };

  const [eq, fire, gdelt] = await Promise.allSettled([
    getJson('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson'),
    getJson(`${ORIGIN}/api/fires`),
    getJson(`${ORIGIN}/api/gdelt`),
  ]);

  if (eq.status === 'fulfilled') {
    const earthquakes = eq.value.features || [];
    dynamicSuppliers.forEach(sup => {
      const nearbyEq = earthquakes.filter((e: any) => {
        const [lng, lat] = e.geometry.coordinates;
        return getDistanceKm(sup.lat, sup.lng, lat, lng) < 150; // 150km impact zone
      });
      if (nearbyEq.length > 0) {
        sup.risk_level = 'CRITICAL';
        sup.active_threats.push(`SEISMIC SHOCK (M${Math.max(...nearbyEq.map((e: any) => e.properties.mag)).toFixed(1)})`);
      }
    });
  } else { unavailable.push('earthquakes'); }

  if (fire.status === 'fulfilled') {
    const fires = fire.value.fires || [];
    dynamicSuppliers.forEach(sup => {
      const nearbyFires = fires.filter((f: any) => getDistanceKm(sup.lat, sup.lng, f.lat, f.lng) < 50); // 50km fire zone
      if (nearbyFires.length > 0) {
        if (sup.risk_level === 'NORMAL') sup.risk_level = 'HIGH';
        sup.active_threats.push(`WILDFIRE PROXIMITY (${nearbyFires.length} hotspots)`);
      }
    });
  } else { unavailable.push('fires'); }

  if (gdelt.status === 'fulfilled') {
    // The feed also carries GDACS earthquakes and storms; only conflict events count here.
    const conflicts = (gdelt.value.events || []).filter((c: any) => c.type === 'conflict');
    dynamicSuppliers.forEach(sup => {
      const nearbyConflicts = conflicts.filter((c: any) => getDistanceKm(sup.lat, sup.lng, c.lat, c.lng) < 100);
      if (nearbyConflicts.length > 0) {
        sup.risk_level = 'CRITICAL';
        sup.active_threats.push(`ARMED CONFLICT / RIOT`);
      }
    });
  } else { unavailable.push('conflicts'); }

  return NextResponse.json({
    suppliers: dynamicSuppliers,
    total: dynamicSuppliers.length,
    critical_count: dynamicSuppliers.filter(s => s.risk_level === 'CRITICAL').length,
    feeds_unavailable: unavailable,
    timestamp: new Date().toISOString(),
  }, {
    headers: { 'Cache-Control': 'no-store' },
  });
}

export async function GET() {
  return cachedRoute('src/app/api/scm-suppliers/route.ts', 120_000, () => compute());
}
