import { promises as fs } from 'fs';

/**
 * Shared file plumbing for the four forecast engines.
 *
 * The record is an append-only JSONL file written by whichever process runs the
 * cycle. Two things have to hold for it to stay trustworthy: only one writer at
 * a time, and no row lands twice. Both used to be done per module and both were
 * subtly wrong (a live lock was deleted by the process that had just seen it;
 * a retry after a crash could append the same issue again).
 */

const running = new Set<string>();
const LOCK_MAX_AGE_MS = 15 * 60_000;

/** Run fn under a single-writer lock file. Returns false when someone else holds it.
 *  The lock is taken with an exclusive create (wx), so two processes cannot both
 *  win, and it is released only if it still holds OUR token. */
export async function withLock(lockFile: string, fn: () => Promise<void>): Promise<boolean> {
  if (running.has(lockFile)) return false; // an earlier cycle in this process is still going
  running.add(lockFile);
  const token = `${process.pid}:${Date.now()}`;
  let held = false;
  try {
    for (let attempt = 0; attempt < 2 && !held; attempt++) {
      try {
        const fh = await fs.open(lockFile, 'wx');
        await fh.writeFile(token);
        await fh.close();
        held = true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        const raw = await fs.readFile(lockFile, 'utf8').catch(() => '');
        const [pid, at] = raw.split(':').map(Number);
        let alive = false;
        if (pid && pid !== process.pid && Date.now() - at < LOCK_MAX_AGE_MS) {
          try { process.kill(pid, 0); alive = true; } catch (err) { alive = (err as NodeJS.ErrnoException).code === 'EPERM'; } // EPERM: exists, not ours
        }
        if (alive) return false;
        // Stale (owner gone or too old). Remove it only if it is still the same stale file.
        const again = await fs.readFile(lockFile, 'utf8').catch(() => '');
        if (again === raw) await fs.rm(lockFile, { force: true });
      }
    }
    if (!held) return false;
    await fn();
    return true;
  } finally {
    if (held) {
      const cur = await fs.readFile(lockFile, 'utf8').catch(() => '');
      if (cur === token) await fs.rm(lockFile, { force: true }).catch(() => undefined);
    }
    running.delete(lockFile);
  }
}

type Row = { type?: string; id?: string };

/** Append rows to a JSONL record. Skips rows whose (type, id) is already in the
 *  file, and starts on a fresh line if a crash left the last line without one --
 *  otherwise the new row would be glued onto the torn one and both would be lost. */
export async function appendJsonl(file: string, rows: Row[]): Promise<number> {
  let text = '';
  try { text = await fs.readFile(file, 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  const have = new Set<string>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (r && r.id) have.add(`${r.type}:${r.id}`); } catch { /* torn line */ }
  }
  const fresh = rows.filter(r => !r.id || !have.has(`${r.type}:${r.id}`));
  if (!fresh.length) return 0;
  const prefix = text && !text.endsWith('\n') ? '\n' : '';
  await fs.appendFile(file, prefix + fresh.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return fresh.length;
}

/** First index whose value is >= x in an ascending array. */
export function lowerBound(sorted: number[], x: number): number {
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < x) lo = m + 1; else hi = m; }
  return lo;
}
