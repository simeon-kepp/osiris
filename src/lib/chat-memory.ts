import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listChats, readChat } from '@/lib/chat-store';

/**
 * DINGIR's memory across sessions. Two layers, both shared by the whole team:
 *   1. Facts someone asked it to keep ("merk dir: …"), stored with author and date.
 *   2. The saved team conversations, searched per question and shown as excerpts.
 * Both reach the model as a MEMORY section in the system prompt, so it can answer
 * "what did we discuss on Tuesday" from the record and not from the context window.
 */

const DIR = process.env.DINGIR_MEMORY_DIR || path.join(os.homedir(), '.dingir', 'memory');
const FILE = path.join(DIR, 'facts.json');
const MAX_FACTS = 200;
const MAX_FACT_CHARS = 500;
const RECALL_BUDGET = 5000;

export interface Fact { id: string; text: string; author: string; createdAt: string }

export async function listFacts(): Promise<Fact[]> {
  try { return JSON.parse(await fs.readFile(FILE, 'utf8')); } catch { return []; }
}

async function writeFacts(facts: Fact[]) {
  await fs.mkdir(DIR, { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(facts));
  await fs.rename(tmp, FILE);
}

export async function addFact(text: string, author: string): Promise<Fact> {
  const facts = await listFacts();
  const clean = text.trim().slice(0, MAX_FACT_CHARS);
  const dup = facts.find(f => f.text.toLowerCase() === clean.toLowerCase());
  if (dup) return dup;
  const fact: Fact = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, text: clean, author, createdAt: new Date().toISOString() };
  await writeFacts([...facts, fact].slice(-MAX_FACTS));
  return fact;
}

/** Removes every stored fact that contains `needle`; returns how many went. */
export async function forgetFacts(needle: string): Promise<number> {
  const n = needle.trim().toLowerCase();
  if (n.length < 2) return 0;
  const facts = await listFacts();
  const keep = facts.filter(f => !f.text.toLowerCase().includes(n));
  if (keep.length !== facts.length) await writeFacts(keep);
  return facts.length - keep.length;
}

/** Only explicit phrasing counts, so an ordinary question never writes to memory. */
export function parseMemoryCommand(query: string): { kind: 'remember' | 'forget'; text: string } | null {
  const rem = query.match(/^\s*(?:merk(?:e)?\s+dir|remember\s+that|remember\s*:|speicher(?:e)?)\s*[:,-]?\s+([\s\S]{3,})$/i);
  if (rem) return { kind: 'remember', text: rem[1].trim() };
  const fg = query.match(/^\s*(?:vergiss|forget)\s*[:,-]?\s+([\s\S]{2,})$/i);
  if (fg) return { kind: 'forget', text: fg[1].trim() };
  return null;
}

const day = (iso: string) => iso.slice(0, 10);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s).replace(/\s+/g, ' ');

/** The MEMORY section of the system prompt for one question. Never throws: a broken store must not stop the chat. */
export async function recallMemory(query: string, excludeChatId?: string): Promise<string> {
  const lines: string[] = [
    '## MEMORY (provenance class MEMORY)',
    'This section is your memory across sessions. It is shared by the whole team and survives restarts.',
    'You DO remember what is listed here. Do not say that every turn starts fresh. Cite it as MEMORY with the date and who said it.',
    'What is not listed here, you do not know.',
  ];
  try {
    const facts = (await listFacts()).slice(-60);
    lines.push('', facts.length ? 'Facts the team asked you to keep:' : 'Stored facts: none yet.');
    for (const f of facts) lines.push(`- [${day(f.createdAt)} · ${f.author}] ${f.text}`);

    const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? [])];
    const recent = (await listChats()).filter(c => c.id !== excludeChatId).slice(0, 40);
    const scored: { chat: Awaited<ReturnType<typeof readChat>>; score: number; rank: number }[] = [];
    for (const [rank, c] of recent.entries()) {
      const chat = await readChat(c.id);
      if (!chat) continue;
      const text = chat.messages.map(m => m.content).join(' ').toLowerCase();
      scored.push({ chat, score: terms.filter(t => text.includes(t)).length, rank });
    }
    // Best topical matches first, then the newest conversations so "yesterday" has something to point at.
    const pick = [
      ...scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score || a.rank - b.rank).slice(0, 3),
      ...scored.slice(0, 2),
    ].filter((s, i, all) => all.findIndex(o => o.chat!.id === s.chat!.id) === i);

    if (pick.length) lines.push('', 'Earlier team conversations (excerpts):');
    let used = lines.join('\n').length;
    for (const { chat } of pick) {
      if (!chat) continue;
      const rel = chat.messages
        .map(m => ({ m, hit: terms.filter(t => m.content.toLowerCase().includes(t)).length }))
        .sort((a, b) => b.hit - a.hit || b.m.timestamp.localeCompare(a.m.timestamp))
        .slice(0, 3)
        .sort((a, b) => a.m.timestamp.localeCompare(b.m.timestamp));
      const block = [`### "${chat.title}" · ${day(chat.messages[0]?.timestamp ?? chat.createdAt)} · started by ${chat.author}`,
        ...rel.map(({ m }) => `${m.role === 'user' ? (m.author ?? 'Operator') : 'DINGIR'}: ${clip(m.content, 400)}`)].join('\n');
      if (used + block.length > RECALL_BUDGET) break;
      used += block.length;
      lines.push(block);
    }
  } catch (e) {
    console.warn('[memory] recall failed:', e instanceof Error ? e.message : e);
  }
  return lines.join('\n');
}
