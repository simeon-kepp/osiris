/** Runs once when the server process starts. Wildfire forecasts are issued and scored from here
 *  because the Python forecast worker only knows about earthquakes. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.NODE_ENV !== 'production' && process.env.WILDFIRE_FORECAST !== '1') return;
  const { runCycle } = await import('@/lib/fire-forecast');
  setTimeout(() => { void runCycle(); }, 45_000);
  setInterval(() => { void runCycle(); }, 10 * 60_000).unref();
}
