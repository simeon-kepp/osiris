/** Runs once when the server process starts. Wildfire forecasts are issued and scored from here
 *  because the Python forecast worker only knows about earthquakes. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.NODE_ENV !== 'production' && process.env.WILDFIRE_FORECAST !== '1') return;
  const { runCycle } = await import('@/lib/fire-forecast');
  const market = await import('@/lib/market-forecast');
  const space = await import('@/lib/space-forecast');
  const weather = await import('@/lib/weather-forecast');
  setTimeout(() => { void runCycle(); }, 45_000);
  setTimeout(() => { void market.runCycle(); }, 90_000);
  setTimeout(() => { void weather.runCycle(); }, 180_000);
  setInterval(() => { void weather.runCycle(); }, 20 * 60_000).unref();
  setTimeout(() => { void space.runCycle(); }, 135_000);
  setInterval(() => { void space.runCycle(); }, 20 * 60_000).unref();
  setInterval(() => { void runCycle(); }, 10 * 60_000).unref();
  setInterval(() => { void market.runCycle(); }, 30 * 60_000).unref();
}
