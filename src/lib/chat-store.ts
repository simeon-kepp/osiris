import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Team-shared chat store: one JSON file per conversation on the server, so every
 * signed-in team member sees the same list from any machine. Writes go through a temp
 * file and a rename, so a crash never leaves a half-written conversation behind.
 */

export interface StoredMessage {
  id: string;
  role: 'user' | 'analyst';
  content: string;
  timestamp: string;
  isError?: boolean;
  /** GitHub login of whoever sent it. Stamped by the server, never trusted from the client. */
  author?: string;
}

export interface StoredChat {
  id: string;
  title: string;
  /** GitHub login of whoever started the conversation. */
  author: string;
  createdAt: string;
  updatedAt: string;
  messages: StoredMessage[];
}

export type ChatSummary = Omit<StoredChat, 'messages'> & { count: number };

const DIR = process.env.CHAT_STORE_DIR || path.join(os.homedir(), '.dingir', 'chats');
export const MAX_MESSAGES = 300;
const MAX_CONTENT = 100_000;
const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

export const validId = (id: string) => ID_RE.test(id);
const fileFor = (id: string) => path.join(DIR, `${id}.json`);

export async function listChats(): Promise<ChatSummary[]> {
  await fs.mkdir(DIR, { recursive: true });
  const out: ChatSummary[] = [];
  for (const f of await fs.readdir(DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const c: StoredChat = JSON.parse(await fs.readFile(path.join(DIR, f), 'utf8'));
      const { messages, ...meta } = c;
      out.push({ ...meta, count: messages.length });
    } catch { /* skip unreadable file */ }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 200);
}

export async function readChat(id: string): Promise<StoredChat | null> {
  try { return JSON.parse(await fs.readFile(fileFor(id), 'utf8')); } catch { return null; }
}

/** Keeps only well-formed messages and stamps the sender on any message that has no author yet. */
function clean(messages: unknown, login: string, known: Map<string, StoredMessage>): StoredMessage[] {
  if (!Array.isArray(messages)) return [];
  const out: StoredMessage[] = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const { id, role, content, timestamp, isError } = m as Record<string, unknown>;
    if (typeof id !== 'string' || id.length < 1 || id.length > 80) continue;
    if (role !== 'user' && role !== 'analyst') continue;
    if (typeof content !== 'string' || typeof timestamp !== 'string') continue;
    const before = known.get(id);
    out.push({
      id, role, content: content.slice(0, MAX_CONTENT), timestamp,
      ...(isError ? { isError: true } : {}),
      // An author that is already on file stays; a new user message gets the caller.
      ...(before?.author ? { author: before.author } : role === 'user' ? { author: login } : {}),
    });
  }
  return out;
}

/** Merges the caller's copy into the stored one by message id, so two people writing into the
 *  same conversation never wipe each other's turns. */
export async function saveChat(id: string, login: string, title: unknown, messages: unknown): Promise<StoredChat> {
  await fs.mkdir(DIR, { recursive: true });
  const existing = await readChat(id);
  const known = new Map((existing?.messages ?? []).map(m => [m.id, m]));
  const incoming = clean(messages, login, known);
  const merged = new Map(known);
  for (const m of incoming) merged.set(m.id, m);
  const all = [...merged.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp)).slice(-MAX_MESSAGES);
  const now = new Date().toISOString();
  const chat: StoredChat = {
    id,
    title: (typeof title === 'string' && title.trim() ? title : existing?.title || 'Conversation').slice(0, 80),
    author: existing?.author ?? login,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    messages: all,
  };
  const tmp = `${fileFor(id)}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(chat));
  await fs.rename(tmp, fileFor(id));
  return chat;
}

export async function deleteChat(id: string): Promise<void> {
  await fs.rm(fileFor(id), { force: true });
}
