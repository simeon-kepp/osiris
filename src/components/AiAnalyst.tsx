'use client';

import { LLM_MODELS, DEFAULT_LLM_MODEL } from '@/lib/llm-models';
import { useState, useRef, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Brain,
  Send,
  Eye,
  Settings,
  X,
  Bot,
  User,
  AlertTriangle,
  Shield,
  ChevronDown,
  Loader2,
  Key,
  Check,
  Trash2,
  Globe,
  History as HistoryIcon,
  Plus,
  Maximize2,
  Minimize2,
  Paperclip,
  Copy,
} from 'lucide-react';
import type { IntelligenceContext, GraphContext, GraphEdgeFact } from '@/lib/ai-engine';
import { useLocale } from '@/lib/LocaleProvider';

/* ═══════════════════════════════════════════════════════════════
   DINGIR — AI Intelligence Analyst Panel
   Premium glass-panel chat interface for real-time intelligence
   analysis powered by Gemini 2.0 Flash
   ═══════════════════════════════════════════════════════════════ */

/* ─────────────────────────────────────────────────────────────
   Interfaces
   ───────────────────────────────────────────────────────────── */

interface DashboardData {
  earthquakes?: EarthquakeItem[];
  news?: NewsItem[];
  gdelt?: GdeltEvent[];
  markets?: MarketData;
  [key: string]: unknown;
}

interface EarthquakeItem {
  id: string;
  magnitude: number;
  /** The dashboard's USGS transform emits `place`; `location` was the shape
   *  this panel was originally written against. Both are accepted -- reading
   *  only `location` put the literal string "undefined" into the model's
   *  context for every quake, which is worse than omitting the field. */
  location?: string;
  place?: string;
  lat: number;
  lng: number;
  depth: number;
  /** USGS ships epoch milliseconds; other sources ship an ISO string. */
  time: string | number;
  tsunami: boolean;
  felt: number | null;
  alert: string | null;
}

interface NewsItem {
  id: string;
  title: string;
  description: string;
  link: string;
  published: string;
  source: string;
  risk_score: number;
  coords: [number, number] | null;
  machine_assessment: string | null;
}

interface GdeltEvent {
  title: string;
  type: string;
  lat: number;
  lng: number;
  date: string;
  source: string;
  tone: number;
}

interface MarketData {
  indices?: MarketIndex[];
  commodities?: MarketCommodity[];
}

interface MarketIndex {
  name: string;
  value: number;
  change: number;
  changePercent: number;
}

interface MarketCommodity {
  name: string;
  price: number;
  change: number;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'analyst';
  content: string;
  timestamp: string;
  isError?: boolean;
  /** GitHub login of the sender, stamped by the server once the conversation is saved. */
  author?: string;
}

/** A conversation in the team list. The list carries metadata only; messages load when one is opened. */
interface ChatSession { id: string; title: string; updatedAt: string; author?: string; count: number; messages?: ChatMessage[] }
/** Conversations live on the server (shared by the whole team). The browser keeps only which one was open
 *  last, and the old per-browser list, which is uploaded once and then removed. */
const LEGACY_SESSIONS_KEY = 'dingir-chat-sessions';
const CURRENT_KEY = 'dingir-chat-current';
const MAX_SESSION_MESSAGES = 300;
const CHAT_REFRESH_MS = 15_000;

interface AiAnalystProps {
  data: DashboardData;
  /** Owned by the tool strip. The panel used to carry its own floating brain
   *  button in the bottom-right corner, which put a second, differently-shaped
   *  control for the same class of thing outside the strip that holds all the
   *  others. */
  open: boolean;
  onClose: () => void;
  /** True behind the DINGIR login. When set, every question is answered against
   *  the reasoning graph as well as the live feeds. Off on the public demo,
   *  where the graph is not exposed at all. */
  graphEnabled?: boolean;
  /** Distance from the right edge at md+; the dock reserves the rail and any open forecast/feed. */
  offsetRight?: number;
  /** The node the operator currently has open, if any. */
  focusNode?: string;
}

/* ─────────────────────────────────────────────────────────────
   Helpers
   ───────────────────────────────────────────────────────────── */

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function buildContext(data: DashboardData): IntelligenceContext {
  const earthquakes = (data.earthquakes || []).slice(0, 100).map((eq) => ({
    id: eq.id || generateId(),
    magnitude: eq.magnitude,
    location: eq.location || eq.place || 'unknown location',
    latitude: eq.lat,
    longitude: eq.lng,
    depth: eq.depth,
    timestamp: typeof eq.time === 'number' ? new Date(eq.time).toISOString() : eq.time,
    tsunami: eq.tsunami ?? false,
    felt: eq.felt ?? null,
    alert: eq.alert ?? null,
  }));

  const news = (data.news || []).slice(0, 80).map((item) => ({
    id: item.id || generateId(),
    title: item.title,
    description: item.description || '',
    link: item.link || '',
    published: item.published,
    source: item.source,
    risk_score: item.risk_score,
    coords: item.coords,
    machine_assessment: item.machine_assessment,
  }));

  const threats = (data.gdelt || []).slice(0, 60).map((ev) => ({
    id: generateId(),
    type: ev.type || 'INCIDENT',
    title: ev.title,
    description: ev.title,
    severity: (ev.tone < -5 ? 'CRITICAL' : ev.tone < -2 ? 'HIGH' : ev.tone < 0 ? 'ELEVATED' : 'LOW') as
      | 'CRITICAL'
      | 'HIGH'
      | 'ELEVATED'
      | 'LOW',
    region: ev.source || 'Unknown',
    latitude: ev.lat,
    longitude: ev.lng,
    timestamp: ev.date,
    source: ev.source || 'GDELT',
  }));

  return {
    earthquakes,
    news,
    threats,
    cyberAlerts: [],
    timestamp: new Date().toISOString(),
  };
}

/* ─────────────────────────────────────────────────────────────
   Graph context — DINGIR's own reasoning, fetched at send time

   Deliberately fetched per question rather than subscribed to. The feed's SSE
   poller is shared server-side, so ?once=1 reads the same snapshot every open
   feed panel is reading; a second subscription here would add a lifecycle to
   manage for data that only matters at the moment a question is asked.

   The provenance class travels with every item. That is the whole point of
   handing the graph to a language model at all: without it the model has no way
   to tell an audit finding from its own guess, and it will write both in the
   same confident sentence.
   ───────────────────────────────────────────────────────────── */

type FeedSnapshot = {
  items: {
    kind: string;
    provenance: string;
    score: number;
    title: string;
    nodes: string[];
    relation?: string;
  }[];
  graph: { nodes: number; edges: number };
  /** Held-out scores of the checkpoint that produced the predictions above,
   *  shipped alongside them rather than restated here. See bi_api's
   *  route_reasoning_feed for why this does not live in the client. */
  model?: { test_auc?: number; relation_mrr?: number; best_epoch?: number; trained_at?: string };
};

let _cyberCache: { at: number; alerts: IntelligenceContext['cyberAlerts'] } | null = null;
/** Cyber alerts (CISA KEV, last 30 days) from /api/cyber-threats. buildContext used to hardcode
 *  an empty list, so every cyber question was answered from a context that had none. */
async function fetchCyberAlerts(): Promise<IntelligenceContext['cyberAlerts']> {
  if (_cyberCache && Date.now() - _cyberCache.at < 300_000) return _cyberCache.alerts;
  try {
    const res = await fetch('/api/cyber-threats', { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return _cyberCache?.alerts ?? [];
    const body = await res.json();
    const alerts = (body?.threats ?? []) as IntelligenceContext['cyberAlerts'];
    _cyberCache = { at: Date.now(), alerts };
    return alerts;
  } catch {
    return _cyberCache?.alerts ?? [];
  }
}

async function fetchGraphContext(focusNode?: string): Promise<GraphContext | undefined> {
  try {
    const [snapRes, mycRes] = await Promise.all([
      fetch('/api/reasoning/feed?once=1', { signal: AbortSignal.timeout(4000) }),
      focusNode
        ? fetch(`/api/reasoning/mycelium?node=${encodeURIComponent(focusNode)}&k=25`, { signal: AbortSignal.timeout(4000) })
        : Promise.resolve(null),
    ]);
    if (!snapRes.ok) return undefined;
    const snap = (await snapRes.json()) as FeedSnapshot;

    const predictions: GraphEdgeFact[] = snap.items
      .filter(i => i.kind === 'PREDICTION' && i.nodes.length >= 2)
      .map(i => ({
        subject: i.nodes[0],
        relation: i.relation || 'RELATED_TO',
        object: i.nodes[1],
        provenance: 'PREDICTED',
        score: i.score,
      }));

    const anomalies = snap.items
      .filter(i => i.kind === 'ANOMALY')
      .map(i => ({ node: i.nodes[0] || i.title, type: '', degree: 0, score: i.score }));

    let neighbours: GraphEdgeFact[] = [];
    let focusType: string | undefined;
    if (mycRes && mycRes.ok) {
      const myc = await mycRes.json();
      focusType = myc?.type;
      // Mycelium returns nearest neighbours in the embedding space. Those are
      // DERIVED -- a cosine distance is computed, not stated by any source --
      // and are labelled as such rather than being passed off as edges.
      neighbours = (myc?.neighbors ?? myc?.neighbours ?? [])
        .slice(0, 25)
        .map((n: { word?: string; id?: string; similarity?: number }) => ({
          subject: focusNode as string,
          relation: 'NEAR_IN_EMBEDDING_SPACE',
          object: n.word || n.id || '',
          provenance: 'DERIVED',
          score: n.similarity,
        }))
        .filter((e: GraphEdgeFact) => e.object);
    }

    return {
      focus: focusNode,
      focusType,
      neighbours,
      anomalies,
      predictions,
      totals: snap.graph,
      // Read from the checkpoint via the feed, never hardcoded: the analyst
      // uses this to say what a PREDICTED edge is actually worth, and a stale
      // copy of the number would be a confident claim about a model that no
      // longer exists. Undefined when the checkpoint predates metric
      // persistence, in which case the analyst simply says nothing about it.
      modelTestAuc: snap.model?.test_auc,
    };
  } catch {
    // No graph context is a normal condition (signed out, API down). The chat
    // still answers from the live feeds and simply has less to work with.
    return undefined;
  }
}

/** Render markdown-lite: bold, headers, bullet points, links */
function renderMarkdown(text: string): string {
  // Basic HTML escape to prevent XSS
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");

  return escaped
    // Web answers cite as [site](url). Only http(s) after escaping, so neither
    // javascript: nor an attribute break-out can get through.
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" class="text-[var(--cyan-primary,#00e5ff)] underline underline-offset-2 hover:opacity-80">$1</a>')
    .replace(/### (.+)/g, '<h4 class="text-[11px] font-bold text-[var(--gold-primary)] mt-3 mb-1 tracking-wider uppercase font-mono">$1</h4>')
    .replace(/## (.+)/g, '<h3 class="text-[12px] font-bold text-[var(--gold-primary)] mt-3 mb-1.5 tracking-wider uppercase font-mono border-b border-[var(--border-secondary)] pb-1">$1</h3>')
    .replace(/# (.+)/g, '<h2 class="text-[13px] font-bold text-[var(--gold-primary)] mt-3 mb-1.5 tracking-wider uppercase font-mono">$1</h2>')
    .replace(/\*\*(.+?)\*\*/g, '<strong class="text-[var(--text-heading)] font-semibold">$1</strong>')
    .replace(/\*(.+?)\*/g, '<em class="text-[var(--text-secondary)] italic">$1</em>')
    .replace(/^- (.+)/gm, '<div class="flex items-start gap-1.5 ml-1 my-0.5"><span class="text-[var(--gold-dim)] mt-[3px] text-[8px]">◆</span><span>$1</span></div>')
    .replace(/\n/g, '<br />');
}

/* ─────────────────────────────────────────────────────────────
   Component
   ───────────────────────────────────────────────────────────── */

/** Writes a fresh answer out progressively so a long reply reads as it arrives, not as one wall of
 *  text. The reply is already complete on the client; this only paces how it appears (~2.5 s at most),
 *  and restored conversations skip it. */
function RevealedMarkdown({ text, animate, className, onTick }: { text: string; animate: boolean; className: string; onTick?: () => void }) {
  const [n, setN] = useState(animate ? 0 : text.length);
  useEffect(() => {
    if (!animate || n >= text.length) return;
    const step = Math.max(8, Math.ceil(text.length / 150));
    const t = setTimeout(() => { setN(v => Math.min(text.length, v + step)); onTick?.(); }, 16);
    return () => clearTimeout(t);
  }, [n, text, animate, onTick]);
  return <div className={className} dangerouslySetInnerHTML={{ __html: renderMarkdown(text.slice(0, animate ? n : text.length)) }} />;
}

export default function AiAnalyst({ data, graphEnabled, offsetRight = 64, focusNode, open, onClose }: AiAnalystProps) {
  const { t: tr } = useLocale();
  const isOpen = open;
  const setIsOpen = (v: boolean) => { if (!v) onClose(); };
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [sessionId, setSessionId] = useState<string>(() => generateId());
  const [showHistory, setShowHistory] = useState(false);
  const [expanded, setExpanded] = useState(false);
  /** Fullscreen keeps the conversation list as a permanent left column, like a normal chat app. */
  const [sideOpen, setSideOpen] = useState(true);
  /** An older conversation the operator pinned as reference for the next questions. */
  const [attachedId, setAttachedId] = useState<string | null>(null);
  const sessionsHydrated = useRef(false);
  /** Ids of answers that arrived in this view and should be written out, not shown at once. */
  const freshRef = useRef<Set<string>>(new Set());

  const refreshSessions = useCallback(async () => {
    try {
      const res = await fetch('/api/chats');
      if (!res.ok) return;
      const { chats } = await res.json();
      setSessions(chats as ChatSession[]);
    } catch { /* offline: keep what is shown */ }
  }, []);

  const loadSession = useCallback(async (id: string): Promise<ChatMessage[] | null> => {
    try {
      const res = await fetch(`/api/chats/${encodeURIComponent(id)}`);
      if (!res.ok) return null;
      return (await res.json()).messages as ChatMessage[];
    } catch { return null; }
  }, []);

  // On mount: upload any conversations the old per-browser store still holds, then load the team list
  // and reopen the conversation that was open last.
  useEffect(() => {
    (async () => {
      try {
        const legacy: { id: string; title: string; messages: ChatMessage[] }[] = JSON.parse(localStorage.getItem(LEGACY_SESSIONS_KEY) || '[]');
        for (const l of legacy) {
          await fetch(`/api/chats/${encodeURIComponent(l.id)}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: l.title, messages: l.messages }),
          });
        }
        if (legacy.length) localStorage.removeItem(LEGACY_SESSIONS_KEY);
      } catch { /* corrupt or offline: leave it for the next start */ }
      await refreshSessions();
      const last = localStorage.getItem(CURRENT_KEY);
      if (last) {
        const msgs = await loadSession(last);
        if (msgs) { setSessionId(last); setMessages(msgs); }
      }
      sessionsHydrated.current = true;
    })();
  }, [refreshSessions, loadSession]);

  // Other people add conversations too: refresh the list while the panel is open.
  useEffect(() => {
    if (!isOpen) return;
    const t = setInterval(refreshSessions, CHAT_REFRESH_MS);
    return () => clearInterval(t);
  }, [isOpen, refreshSessions]);

  // Save the open conversation shortly after it changes. The server merges by message id.
  useEffect(() => {
    if (!sessionsHydrated.current || messages.length === 0) return;
    const firstUser = messages.find(m => m.role === 'user')?.content ?? 'Conversation';
    const title = firstUser.replace(/\s+/g, ' ').slice(0, 70);
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/chats/${encodeURIComponent(sessionId)}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, messages: messages.slice(-MAX_SESSION_MESSAGES) }),
        });
        if (res.ok) { localStorage.setItem(CURRENT_KEY, sessionId); refreshSessions(); }
      } catch { /* retried on the next change */ }
    }, 700);
    return () => clearTimeout(t);
  }, [messages, sessionId, refreshSessions]);

  const [historyNote, setHistoryNote] = useState('');
  const newChat = useCallback(() => {
    setMessages([]);
    setSessionId(generateId());
    setAttachedId(null);
    setShowHistory(false);
    try { localStorage.setItem(CURRENT_KEY, ''); } catch { /* ignore */ }
  }, []);
  const openSession = useCallback(async (sess: ChatSession) => {
    const msgs = await loadSession(sess.id);
    if (!msgs) { setHistoryNote('Could not open this conversation.'); return; }
    setSessionId(sess.id);
    setMessages(msgs);
    setShowHistory(false);
    try { localStorage.setItem(CURRENT_KEY, sess.id); } catch { /* ignore */ }
  }, [loadSession]);
  const deleteSession = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/chats/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (res.status === 403) { setHistoryNote('Only the person who started a conversation can delete it.'); return; }
      if (res.ok) setHistoryNote('');
    } catch { /* ignore */ }
    if (id === sessionId) { setMessages([]); setSessionId(generateId()); }
    setAttachedId(a => (a === id ? null : a));
    refreshSessions();
  }, [sessionId, refreshSessions]);
  const [inputText, setInputText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  /** True from the first streamed token on; the "thinking" bubble gives way to the growing answer. */
  const [streaming, setStreaming] = useState(false);
  /** What the analyst is looking up right now ("Reading the map: europe, last 24 h"). */
  const [lookupNote, setLookupNote] = useState('');
  const [briefingInFlight, setBriefingInFlight] = useState(false);
  const [thinkingLabel, setThinkingLabel] = useState('Thinking');
  const [showSettings, setShowSettings] = useState(false);
  const [showBriefingMenu, setShowBriefingMenu] = useState(false);
  const [customBriefing, setCustomBriefing] = useState('');
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [keySaved, setKeySaved] = useState(false);
  const [llmModel, setLlmModel] = useState(DEFAULT_LLM_MODEL);
  // Off by default: a search costs real money per question (~$0.008 measured)
  // and most questions are about the feeds. A question that asks for the web
  // by name ("google", "such im Netz") searches anyway; the route decides that.
  // Read once on first render: the toggle only shows inside the open panel, so
  // the server-rendered HTML never contains it and cannot mismatch.
  const [webSearch, setWebSearch] = useState(
    () => typeof window !== 'undefined' && localStorage.getItem('osiris-web-search') === '1'
  );
  const toggleWebSearch = useCallback(() => {
    setWebSearch(prev => {
      localStorage.setItem('osiris-web-search', prev ? '0' : '1');
      return !prev;
    });
  }, []);
  useEffect(() => {
    const saved = localStorage.getItem('osiris-llm-model');
    if (saved && LLM_MODELS.some(m => m.id === saved)) setLlmModel(saved);
  }, []);
  const changeModel = useCallback((id: string) => {
    setLlmModel(id);
    localStorage.setItem('osiris-llm-model', id);
  }, []);
  // Filled from the response, never guessed. The header used to read
  // "GEMINI 2.0 FLASH • ONLINE" as static text -- it said Gemini while the
  // request was failing for want of a Gemini key, which is the one thing a
  // status line must never do.
  const [providerLabel, setProviderLabel] = useState('READY');

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!isLoading || briefingInFlight) return;
    const labels = ['Thinking', 'Pondering', 'Matching patterns', 'Querying live data'];
    let index = 0;
    setThinkingLabel(labels[index]);
    const timer = setInterval(() => {
      index = (index + 1) % labels.length;
      setThinkingLabel(labels[index]);
    }, 1800);
    return () => clearInterval(timer);
  }, [isLoading, briefingInFlight]);

  // Load saved key on mount
  useEffect(() => {
    const saved = localStorage.getItem('osiris-llm-key') || localStorage.getItem('osiris-gemini-key');
    if (saved) {
      setApiKeyInput(saved);
      setKeySaved(true);
    }
  }, []);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Focus input when opened
  useEffect(() => {
    if (isOpen && !showSettings) {
      setTimeout(() => inputRef.current?.focus(), 300);
    }
  }, [isOpen, showSettings]);

  const getHeaders = useCallback((): Record<string, string> => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const savedKey = localStorage.getItem('osiris-llm-key') || localStorage.getItem('osiris-gemini-key');
    if (savedKey) {
      headers['x-llm-key'] = savedKey;
    }
    const savedModel = localStorage.getItem('osiris-llm-model');
    if (savedModel) headers['x-llm-model'] = savedModel;
    return headers;
  }, []);

  const handleSend = useCallback(async () => {
    const query = inputText.trim();
    if (!query || isLoading) return;

    const userMsg: ChatMessage = {
      id: generateId(),
      role: 'user',
      content: query,
      timestamp: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setInputText('');
    setIsLoading(true);

    try {
      const context = buildContext(data);
      context.cyberAlerts = await fetchCyberAlerts();
      if (graphEnabled) context.graph = await fetchGraphContext(focusNode);
      // Earlier turns go as real chat messages; the route trims them. Error
      // bubbles are UI, not something DINGIR said, so they stay out.
      const own = messages
        .filter(m => !m.isError)
        .map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content }));
      // Back-reference: an older conversation the operator pinned rides along as the first turns.
      const attached = attachedId ? sessions.find(x => x.id === attachedId) : undefined;
      const attachedMsgs = attached ? (attached.messages ?? await loadSession(attached.id) ?? []) : [];
      const earlier = attached ? [
        { role: 'user', content: `[Reference: earlier conversation "${attached.title}"]\n` +
          attachedMsgs.filter(m => !m.isError).map(m => `${m.role === 'user' ? 'Operator' : 'DINGIR'}: ${m.content}`).join('\n').slice(0, 6000) },
        { role: 'assistant', content: 'Understood. I will use that earlier conversation as reference.' },
      ] : [];
      const history = [...earlier, ...own];
      const res = await fetch('/api/ai/analyze', {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ query, messages: history, context, webSearch, stream: true, chatId: sessionId }),
      });

      if (!res.ok || !res.body) {
        const errorBody = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(errorBody.error || `HTTP ${res.status}`);
      }

      // The answer arrives as JSON lines: {"t": text}…, then {"done": true, model, timestamp, web} or {"error"}.
      // Text is painted at most once per frame, however fast the model delivers it.
      const analystId = generateId();
      let text = '';
      let frame = 0;
      const paint = () => {
        frame = 0;
        setMessages(prev => prev.map(m => (m.id === analystId ? { ...m, content: text } : m)));
        messagesEndRef.current?.scrollIntoView({ block: 'end' });
      };
      let started = false;
      let finished = false;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const ev = JSON.parse(line) as { t?: string; done?: boolean; error?: string; model?: string; timestamp?: string; s?: string; web?: { searched: boolean; pages: number } };
          if (ev.error) throw new Error(ev.error);
          if (ev.s) setLookupNote(ev.s);
          if (ev.t) {
            setLookupNote('');
            text += ev.t;
            if (!started) {
              started = true;
              setStreaming(true);
              setMessages(prev => [...prev, { id: analystId, role: 'analyst', content: text, timestamp: new Date().toISOString() }]);
            } else if (!frame) {
              frame = requestAnimationFrame(paint);
            }
          }
          if (ev.done) {
            finished = true;
            if (ev.model) {
              const via = [ev.web?.searched && 'WEB', ev.web?.pages && `${ev.web.pages} LINK`].filter(Boolean).join(' + ');
              setProviderLabel(`${ev.model.toUpperCase()}${via ? ` · ${via}` : ''}`);
            }
          }
        }
      }
      if (frame) cancelAnimationFrame(frame);
      if (started) paint();
      if (!finished && !started) throw new Error('The model sent no answer. Try again.');
    } catch (err: unknown) {
      const message = err instanceof TypeError && err.message === 'Failed to fetch'
        ? 'DINGIR API is unreachable. Check that `dingir status` shows web and engine online, then retry.'
        : err instanceof Error ? err.message : 'Analysis failed';
      const errorMsg: ChatMessage = {
        id: generateId(),
        role: 'analyst',
        content: `INTELLIGENCE ANALYSIS ERROR\n\n${message}`,
        timestamp: new Date().toISOString(),
        isError: true,
      };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      setStreaming(false);
      setIsLoading(false);
      setLookupNote('');
    }
  }, [inputText, isLoading, messages, data, getHeaders, graphEnabled, focusNode, webSearch, attachedId, sessions, loadSession, sessionId]);

  const handleBriefing = useCallback(async (request = 'Generate the full current intelligence briefing.') => {
    if (isLoading) return;
    setBriefingInFlight(true);

    const userMsg: ChatMessage = {
      id: generateId(),
      role: 'user',
      content: request,
      timestamp: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setIsLoading(true);

    try {
      const context = buildContext(data);
      context.cyberAlerts = await fetchCyberAlerts();
      if (graphEnabled) context.graph = await fetchGraphContext(focusNode);
      const res = await fetch('/api/ai/briefing', {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ context, request }),
      });

      const json = await res.json();

      if (!res.ok) {
        const errorBody = json as { error: string; code: string };
        throw new Error(errorBody.error || `HTTP ${res.status}`);
      }

      const responseBody = json as { briefing: string; generatedAt: string; model?: string };
      if (responseBody.model) setProviderLabel(responseBody.model.toUpperCase());

      const analystMsg: ChatMessage = {
        id: generateId(),
        role: 'analyst',
        content: responseBody.briefing,
        timestamp: responseBody.generatedAt,
      };
      freshRef.current.add(analystMsg.id);
      setMessages((prev) => [...prev, analystMsg]);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Briefing generation failed';
      const errorMsg: ChatMessage = {
        id: generateId(),
        role: 'analyst',
        content: `BRIEFING GENERATION ERROR\n\n${message}`,
        timestamp: new Date().toISOString(),
        isError: true,
      };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      setIsLoading(false);
      setLookupNote('');
      setBriefingInFlight(false);
    }
  }, [isLoading, data, getHeaders, graphEnabled, focusNode]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  const saveApiKey = useCallback(() => {
    const key = apiKeyInput.trim();
    if (key) {
      localStorage.setItem('osiris-llm-key', key);
      localStorage.removeItem('osiris-gemini-key');
      setKeySaved(true);
      setTimeout(() => setShowSettings(false), 600);
    }
  }, [apiKeyInput]);

  const clearApiKey = useCallback(() => {
    localStorage.removeItem('osiris-llm-key');
    localStorage.removeItem('osiris-gemini-key');
    setApiKeyInput('');
    setKeySaved(false);
  }, []);

  const clearMessages = useCallback(() => {
    deleteSession(sessionId);
  }, [deleteSession, sessionId]);

  /* ── Panel ── */
  return (
    <>
      {/* Panel */}
      <AnimatePresence>
        {isOpen && (
          <>
            {/* Backdrop on mobile */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[600] md:hidden"
              onClick={() => setIsOpen(false)}
            />

            {/* Main Panel */}
            <motion.div
              layout
              initial={{ opacity: 0, y: 40, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 40, scale: 0.95 }}
              transition={{ type: 'spring', stiffness: 300, damping: 25, layout: { type: 'tween', duration: 0.38, ease: [0.2, 0.8, 0.2, 1] } }}
              className="fixed inset-x-0 bottom-0 right-0 md:inset-x-auto md:top-6 md:bottom-6 md:right-[var(--dock-right)] z-[700] w-full md:w-[min(560px,42vw)] h-[85vh] md:h-auto md:max-h-none flex flex-col md:rounded-2xl overflow-hidden border border-white/10 bg-[#080c15]"
              style={{
                ['--dock-right' as string]: `${offsetRight}px`,
                ...(expanded ? { top: 12, bottom: 12, left: 12, right: 12, width: 'auto', height: 'auto' } : {}),
                background: 'linear-gradient(180deg, rgba(8, 10, 20, 0.96) 0%, rgba(6, 6, 12, 0.98) 100%)',
                border: '1px solid rgba(212, 175, 55, 0.2)',
                boxShadow:
                  '0 0 60px rgba(0, 0, 0, 0.8), 0 0 30px rgba(212, 175, 55, 0.08), 0 1px 0 rgba(212, 175, 55, 0.1) inset',
                backdropFilter: 'blur(40px) saturate(1.5)',
              }}
            >
              {/* ── Header ── */}
              <div
                className="relative flex items-center justify-between px-4 py-3 shrink-0"
                style={{
                  background: 'linear-gradient(90deg, rgba(212, 175, 55, 0.06) 0%, transparent 50%, rgba(0, 229, 255, 0.04) 100%)',
                  borderBottom: '1px solid rgba(212, 175, 55, 0.15)',
                }}
              >
                {/* Scan line accent */}
                <motion.div
                  className="absolute bottom-0 left-0 right-0 h-[1px]"
                  style={{ background: 'linear-gradient(90deg, transparent, var(--gold-primary), transparent)' }}
                  animate={{ opacity: [0.3, 0.7, 0.3] }}
                  transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
                />

                <div className="flex items-center gap-2.5">
                  <div className="relative">
                    <Shield className="w-4.5 h-4.5 text-[var(--gold-primary)]" />
                    <div className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-[var(--alert-green)] animate-osiris-pulse" />
                  </div>
                  <div className="flex flex-col">
                    <span className="hud-text text-[13px] text-[var(--text-heading)]">{tr('analyst.title')}</span>
                    <span className="text-[9px] font-mono tracking-[0.15em] text-[#b8c1cf]">
                      CHAT · {providerLabel}
                    </span>
                    {attachedId && (
                      <button onClick={() => setAttachedId(null)} className="mt-0.5 flex items-center gap-1 text-[9px] font-mono text-[var(--gold-primary)] hover:text-white" title="Stop using this conversation as reference">
                        <Paperclip className="w-2.5 h-2.5" /> {(sessions.find(x => x.id === attachedId)?.title ?? '').slice(0, 36)} <X className="w-2.5 h-2.5" />
                      </button>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-1">
                  <button onClick={newChat} className="p-1.5 rounded-lg hover:bg-[var(--hover-accent)] transition-colors group" title="New chat">
                    <Plus className="w-3.5 h-3.5 text-[var(--text-muted)] group-hover:text-[var(--text-primary)]" />
                  </button>
                  <button onClick={() => (expanded ? setSideOpen(o => !o) : setShowHistory(h => !h))} className={`relative p-1.5 rounded-lg transition-colors group ${(expanded ? sideOpen : showHistory) ? 'bg-[var(--hover-accent)]' : 'hover:bg-[var(--hover-accent)]'}`} title="Earlier conversations">
                    <HistoryIcon className={`w-3.5 h-3.5 ${(expanded ? sideOpen : showHistory) ? 'text-[var(--gold-primary)]' : 'text-[var(--text-muted)] group-hover:text-[var(--text-primary)]'}`} />
                  </button>
                  <button onClick={() => setExpanded(x => !x)} className="p-1.5 rounded-lg hover:bg-[var(--hover-accent)] transition-colors group" title={expanded ? 'Shrink' : 'Fullscreen'}>
                    {expanded ? <Minimize2 className="w-3.5 h-3.5 text-[var(--text-muted)] group-hover:text-[var(--text-primary)]" /> : <Maximize2 className="w-3.5 h-3.5 text-[var(--text-muted)] group-hover:text-[var(--text-primary)]" />}
                  </button>
                  <button
                    onClick={toggleWebSearch}
                    aria-pressed={webSearch}
                    className={`p-1.5 rounded-lg transition-colors group ${webSearch ? 'bg-[var(--hover-accent)]' : 'hover:bg-[var(--hover-accent)]'}`}
                    title={webSearch ? 'Web search on: every question also searches the web' : 'Web search off: answers from the live data (links you paste are still opened)'}
                  >
                    <Globe
                      className={`w-3.5 h-3.5 transition-colors ${
                        webSearch ? 'text-[var(--gold-primary)]' : 'text-[var(--text-muted)] group-hover:text-[var(--text-primary)]'
                      }`}
                    />
                  </button>
                  {messages.length > 0 && (
                    <button
                      onClick={clearMessages}
                      className="p-1.5 rounded-lg hover:bg-[var(--hover-accent)] transition-colors group"
                      title="Clear conversation"
                    >
                      <Trash2 className="w-3.5 h-3.5 text-[var(--text-muted)] group-hover:text-[var(--alert-red)]" />
                    </button>
                  )}
                  <button
                    onClick={() => setShowSettings(!showSettings)}
                    className="p-1.5 rounded-lg hover:bg-[var(--hover-accent)] transition-colors group"
                    title="Settings"
                  >
                    <Settings
                      className={`w-3.5 h-3.5 transition-colors ${
                        showSettings ? 'text-[var(--gold-primary)]' : 'text-[var(--text-muted)] group-hover:text-[var(--text-primary)]'
                      }`}
                    />
                  </button>
                  <button
                    onClick={() => setIsOpen(false)}
                    className="p-1.5 rounded-lg hover:bg-[var(--hover-accent)] transition-colors group"
                    title="Close"
                  >
                    <X className="w-3.5 h-3.5 text-[var(--text-muted)] group-hover:text-[var(--text-primary)]" />
                  </button>
                </div>
              </div>

              {/* ── History overlay ── */}
              {((showHistory && !expanded) || (expanded && sideOpen)) && (
                <div className={`absolute top-[57px] bottom-0 z-20 overflow-y-auto styled-scrollbar bg-[#080c15]/98 backdrop-blur-md p-3 space-y-1.5 ${expanded ? 'left-0 w-[280px] border-r border-white/10' : 'inset-x-0'}`}>
                  <div className="flex items-center justify-between px-1 pb-1">
                    <span className="hud-label" style={{ fontSize: '10px' }}>TEAM CONVERSATIONS · {sessions.length}</span>
                    <button onClick={newChat} className="flex items-center gap-1 rounded border border-white/10 px-2 py-1 text-[10px] font-mono text-[var(--text-primary)] hover:border-[var(--gold-primary)]/60"><Plus className="w-3 h-3" /> NEW</button>
                  </div>
                  {historyNote && <div className="px-1 text-[11px] font-mono text-[var(--alert-red)]">{historyNote}</div>}
                  {sessions.length === 0 && <div className="px-1 py-6 text-center text-[11px] font-mono text-[var(--text-muted)]">Nothing saved yet. Conversations are saved for the whole team automatically.</div>}
                  {sessions.map(sess => (
                    <div key={sess.id} className={`group flex items-center gap-2 rounded-lg border px-3 py-2 ${sess.id === sessionId ? 'border-[var(--gold-primary)]/50 bg-white/[0.04]' : 'border-white/5 hover:border-white/15'}`}>
                      <button onClick={() => openSession(sess)} className="min-w-0 flex-1 text-left">
                        <div className="truncate text-[12px] text-[var(--text-primary)]">{sess.title}</div>
                        <div className="text-[9px] font-mono text-[var(--text-muted)]">{new Date(sess.updatedAt).toLocaleString()} · {sess.count} msgs{sess.author ? ` · ${sess.author}` : ''}</div>
                      </button>
                      {sess.id !== sessionId && (
                        <button onClick={() => { setAttachedId(sess.id); setShowHistory(false); }} title="Use as reference in the current chat" className={`p-1.5 rounded hover:bg-white/10 ${attachedId === sess.id ? 'text-[var(--gold-primary)]' : 'text-[var(--text-muted)]'}`}>
                          <Paperclip className="w-3.5 h-3.5" />
                        </button>
                      )}
                      <button onClick={() => deleteSession(sess.id)} title="Delete" className="p-1.5 rounded text-[var(--text-muted)] hover:bg-white/10 hover:text-[var(--alert-red)]"><Trash2 className="w-3.5 h-3.5" /></button>
                    </div>
                  ))}
                </div>
              )}

              {/* ── Settings Panel ── */}
              <AnimatePresence>
                {showSettings && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="overflow-hidden shrink-0"
                    style={expanded && sideOpen ? { marginLeft: 280 } : undefined}
                  >
                    <div
                      className="px-4 py-3 space-y-2.5"
                      style={{
                        background: 'rgba(212, 175, 55, 0.03)',
                        borderBottom: '1px solid rgba(212, 175, 55, 0.1)',
                      }}
                    >
                      <div className="flex items-center gap-2">
                        <Bot className="w-3 h-3 text-[var(--gold-dim)]" />
                        <span className="hud-label" style={{ fontSize: '10px' }}>MODEL</span>
                      </div>
                      <select
                        value={llmModel}
                        onChange={(e) => changeModel(e.target.value)}
                        className="w-full bg-[var(--bg-tertiary)] border border-[var(--border-secondary)] rounded-lg px-3 py-2 text-[11px] font-mono text-[var(--text-primary)] focus:outline-none focus:border-[var(--gold-dim)]"
                      >
                        {LLM_MODELS.map(m => (
                          <option key={m.id} value={m.id}>{m.label}{m.note ? ` - ${m.note}` : ''}</option>
                        ))}
                      </select>
                      <div className="text-[9px] font-mono text-[var(--text-muted)]">
                        Applies to the next message. A pasted API key below overrides the server key.
                      </div>
                      <div className="flex items-center gap-2">
                        <Key className="w-3 h-3 text-[var(--gold-dim)]" />
                        <span className="hud-label" style={{ fontSize: '10px' }}>
                          NVIDIA / GEMINI API KEY (OPTIONAL)
                        </span>
                      </div>
                      <div className="flex gap-2">
                        <input
                          type="password"
                          value={apiKeyInput}
                          onChange={(e) => {
                            setApiKeyInput(e.target.value);
                            setKeySaved(false);
                          }}
                          placeholder="nvapi-... or AIza..."
                          className="flex-1 bg-[var(--bg-tertiary)] border border-[var(--border-secondary)] rounded-lg px-3 py-2 text-[11px] font-mono text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--gold-dim)] transition-colors"
                        />
                        {apiKeyInput.trim() && (
                          <>
                            <button
                              onClick={saveApiKey}
                              className="px-3 rounded-lg text-[9px] font-mono tracking-wider transition-all"
                              style={{
                                background: keySaved ? 'rgba(0, 230, 118, 0.15)' : 'rgba(212, 175, 55, 0.1)',
                                border: `1px solid ${keySaved ? 'rgba(0, 230, 118, 0.3)' : 'rgba(212, 175, 55, 0.2)'}`,
                                color: keySaved ? 'var(--alert-green)' : 'var(--gold-primary)',
                              }}
                            >
                              {keySaved ? <Check className="w-3 h-3" /> : 'SAVE'}
                            </button>
                            <button
                              onClick={clearApiKey}
                              className="px-2 rounded-lg text-[9px] font-mono tracking-wider transition-all hover:bg-red-500/10"
                              style={{
                                border: '1px solid rgba(255, 61, 61, 0.2)',
                                color: 'var(--alert-red)',
                              }}
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </>
                        )}
                      </div>
                      <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">
                        Your key is stored locally and sent only to the DINGIR server. NVIDIA keys use Nemotron; Gemini keys remain supported. Get a free NVIDIA key at{' '}
                        <a
                          href="https://build.nvidia.com/explore/discover?api-key=true"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[var(--cyan-primary)] hover:underline"
                        >
                          build.nvidia.com
                        </a>
                      </p>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* ── Messages Area ── */}
              <div className={`flex-1 overflow-y-auto styled-scrollbar ${expanded ? 'px-8 py-6' : 'px-4 py-3'}`} style={expanded && sideOpen ? { paddingLeft: 312 } : undefined}>
               <div className={expanded ? 'mx-auto w-full max-w-[820px] space-y-7' : 'space-y-3'}>
                {/* Empty state */}
                {messages.length === 0 && !isLoading && (
                  <div className="h-full flex flex-col items-center justify-center text-center px-6 gap-5">
                    {/* Animated brain icon */}
                    <div className="relative">
                      <motion.div
                        animate={{ rotate: [0, 360] }}
                        transition={{ duration: 20, repeat: Infinity, ease: 'linear' }}
                        className="absolute inset-[-10px] rounded-full border border-[var(--gold-primary)]"
                        style={{ opacity: 0.15 }}
                      />
                      <motion.div
                        animate={{ rotate: [0, -360] }}
                        transition={{ duration: 14, repeat: Infinity, ease: 'linear' }}
                        className="absolute inset-[-20px] rounded-full border border-[var(--cyan-primary)]"
                        style={{ opacity: 0.08 }}
                      />
                      <div
                        className="w-16 h-16 rounded-2xl flex items-center justify-center"
                        style={{
                          background: 'linear-gradient(135deg, rgba(212, 175, 55, 0.1) 0%, rgba(0, 229, 255, 0.05) 100%)',
                          border: '1px solid rgba(212, 175, 55, 0.2)',
                        }}
                      >
                        <Brain className="w-7 h-7 text-[var(--gold-primary)]" />
                      </div>
                    </div>

                    <div className="space-y-2">
                      <h3 className="hud-text text-[12px] text-[var(--text-heading)]">
                        {tr('analyst.ready')}
                      </h3>
                      <p className="text-[13px] text-[#d7dbe3] leading-relaxed max-w-[360px]">
                        Schreib einfach mit DINGIR. Es kann locker antworten, Fragen zum Live-Lagebild einordnen oder auf Knopfdruck ein vollständiges Briefing erzeugen.
                      </p>
                    </div>

                    {/* Quick prompts */}
                    <div className="w-full space-y-1.5">
                      <span className="hud-label block text-center mb-2" style={{ fontSize: '9px' }}>
                        CHAT STARTEN
                      </span>
                      {[
                        'What are the top 3 threats right now?',
                        'Are there seismic patterns correlating with conflicts?',
                        'Assess cyber risks to critical infrastructure',
                      ].map((prompt) => (
                        <button
                          key={prompt}
                          onClick={() => {
                            setInputText(prompt);
                            setTimeout(() => inputRef.current?.focus(), 50);
                          }}
                          className="w-full text-left px-3 py-2.5 rounded-lg text-[12px] text-[var(--text-secondary)] transition-all hover:text-[var(--text-primary)] hover:bg-[var(--hover-accent)]"
                          style={{
                            border: '1px solid rgba(212, 175, 55, 0.08)',
                          }}
                        >
                          <span className="text-[var(--gold-dim)] mr-1.5">›</span>
                          {prompt}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Messages */}
                {messages.map((msg) => (
                  <motion.div
                    key={msg.id}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.3 }}
                    className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                  >
                    <div
                      className={`${expanded ? (msg.role === 'user' ? 'max-w-[72%]' : 'w-full') : 'max-w-[90%]'} rounded-xl ${expanded && msg.role !== 'user' ? 'px-1 py-1' : 'px-3.5 py-2.5'} ${
                        msg.role === 'user' ? 'rounded-br-sm' : 'rounded-bl-sm'
                      }`}
                      style={
                        msg.role === 'user'
                          ? {
                              background: 'linear-gradient(135deg, rgba(0, 229, 255, 0.12) 0%, rgba(0, 229, 255, 0.06) 100%)',
                              border: '1px solid rgba(0, 229, 255, 0.2)',
                            }
                          : msg.isError
                          ? {
                              background: 'linear-gradient(135deg, rgba(255, 61, 61, 0.1) 0%, rgba(255, 61, 61, 0.05) 100%)',
                              border: '1px solid rgba(255, 61, 61, 0.2)',
                            }
                          : expanded
                          ? { background: 'transparent', border: 'none' }
                          : {
                              background: 'linear-gradient(135deg, rgba(212, 175, 55, 0.08) 0%, rgba(212, 175, 55, 0.03) 100%)',
                              border: '1px solid rgba(212, 175, 55, 0.12)',
                            }
                      }
                    >
                      {/* Message header */}
                      <div className="flex items-center gap-1.5 mb-1.5">
                        {msg.role === 'user' ? (
                          <User className="w-3 h-3 text-[var(--cyan-primary)]" />
                        ) : msg.isError ? (
                          <AlertTriangle className="w-3 h-3 text-[var(--alert-red)]" />
                        ) : (
                          <Bot className="w-3 h-3 text-[var(--gold-primary)]" />
                        )}
                        <span
                          className="text-[9px] font-mono tracking-[0.15em] uppercase"
                          style={{
                            color: msg.role === 'user'
                              ? 'var(--cyan-primary)'
                              : msg.isError
                              ? 'var(--alert-red)'
                              : 'var(--gold-primary)',
                          }}
                        >
                          {msg.role === 'user' ? (msg.author ? msg.author.toUpperCase() : 'OPERATOR') : 'DINGIR ANALYST'}
                        </span>
                        <span className="text-[9px] font-mono text-[var(--text-muted)] ml-auto">
                          {new Date(msg.timestamp).toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </span>
                      </div>

                      {/* Message content */}
                      {msg.role === 'analyst' && !msg.isError ? (
                        <>
                        <RevealedMarkdown
                          text={msg.content}
                          animate={freshRef.current.has(msg.id)}
                          onTick={() => messagesEndRef.current?.scrollIntoView({ block: 'end' })}
                          className={`${expanded ? 'text-[15px] leading-[1.75]' : 'text-[13px] leading-[1.6]'} text-[var(--text-primary)] whitespace-pre-wrap break-words`}
                        />
                        <button
                          onClick={() => navigator.clipboard?.writeText(msg.content)}
                          className="mt-2 flex items-center gap-1 rounded-md px-1.5 py-1 text-[10px] font-mono text-[var(--text-muted)] hover:bg-white/10 hover:text-[var(--text-primary)] transition-colors"
                          title="Copy answer"
                        >
                          <Copy className="w-3 h-3" /> COPY
                        </button>
                        </>
                      ) : (
                        <p className={`${expanded ? 'text-[15px] leading-[1.75]' : 'text-[13px] leading-[1.6]'} text-[var(--text-primary)] whitespace-pre-wrap break-words`}>
                          {msg.content}
                        </p>
                      )}
                    </div>
                  </motion.div>
                ))}

                {/* Loading indicator */}
                {isLoading && !streaming && (
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="flex justify-start"
                  >
                    <div
                      className="rounded-xl rounded-bl-sm px-4 py-3 flex items-center gap-2.5"
                      style={{
                        background: 'linear-gradient(135deg, rgba(212, 175, 55, 0.08) 0%, rgba(212, 175, 55, 0.03) 100%)',
                        border: '1px solid rgba(212, 175, 55, 0.12)',
                      }}
                    >
                      <Loader2 className="w-3.5 h-3.5 text-[var(--gold-primary)] animate-spin" />
                      <div className="flex items-center gap-1">
                        <span className="text-[10px] font-mono tracking-[0.15em] text-[var(--gold-primary)] uppercase">
                          {briefingInFlight ? 'Analyzing intelligence' : (lookupNote || thinkingLabel)}
                        </span>
                        <motion.span
                          animate={{ opacity: [0, 1, 0] }}
                          transition={{ duration: 1.5, repeat: Infinity }}
                          className="text-[var(--gold-primary)]"
                        >
                          ...
                        </motion.span>
                      </div>
                    </div>
                  </motion.div>
                )}

                <div ref={messagesEndRef} />
               </div>
              </div>

              {/* ── Input Area ── */}
              <div
                className="shrink-0 px-3 py-2.5"
                style={{
                  borderTop: '1px solid rgba(212, 175, 55, 0.1)',
                  background: 'rgba(6, 6, 12, 0.8)',
                  ...(expanded && sideOpen ? { paddingLeft: 292 } : {}),
                }}
              >
               <div className={expanded ? 'mx-auto w-full max-w-[820px]' : ''}>
                {/* Quick action */}
                <div className="relative flex gap-2 mb-2">
                  <button
                    onClick={() => setShowBriefingMenu((value) => !value)}
                    disabled={isLoading}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[9px] font-mono tracking-[0.1em] uppercase transition-all disabled:opacity-40"
                    style={{
                      background: 'rgba(212, 175, 55, 0.08)',
                      border: '1px solid rgba(212, 175, 55, 0.2)',
                      color: 'var(--gold-primary)',
                    }}
                  >
                    <Eye className="w-3 h-3" />
                    BRIEFING ERZEUGEN
                  </button>
                  <AnimatePresence>
                    {showBriefingMenu && !isLoading && (
                      <motion.div
                        initial={{ opacity: 0, y: 6, scale: 0.98 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 6, scale: 0.98 }}
                        className="absolute bottom-full left-0 mb-2 w-[min(390px,92vw)] max-h-[60vh] overflow-y-auto styled-scrollbar rounded-xl p-2 z-20"
                        style={{ background: 'rgba(7, 10, 18, 0.98)', border: '1px solid rgba(212,175,55,.28)', boxShadow: '0 18px 45px rgba(0,0,0,.55)' }}
                      >
                        <div className="px-2 py-1 text-[9px] font-mono tracking-[.16em] text-[#d7dbe3]">BRIEFING-VORLAGE AUSWÄHLEN</div>
                        {[
                          ['FULL SITUATION', 'Full situation briefing: what changed, hazard picture, intersections, watch items, confidence and gaps.'],
                          ['HAZARD WATCH', 'Focused hazard briefing: seismic, disaster, weather and infrastructure risks.'],
                          ['THREAT WATCH', 'Focused threat briefing: geopolitical, OSINT, cyber and critical-infrastructure signals.'],
                          ['SUPPLY CHAIN', 'Supply chain risk briefing: ports, shipping lanes, chokepoints, energy and manufacturing disruptions, and what they could hit downstream.'],
                          ['EXTREME WEATHER', 'Extreme weather and natural hazard briefing: storms, floods, heat, wildfire, seismic and tsunami exposure, with affected regions and what to watch next.'],
                          ['CYBER', 'Cyber briefing: newly exploited vulnerabilities (CISA KEV), affected vendors and products, deadlines, and links to geopolitical activity.'],
                          ['CONFLICT & SECURITY', 'Conflict and security briefing: active conflict zones, escalation or de-escalation signals, attacks on infrastructure, and civilian impact.'],
                          ['ENERGY & INFRASTRUCTURE', 'Energy and critical infrastructure briefing: power, pipelines, grids, telecoms and transport disruptions, and their cause where observed.'],
                          ['MARKETS & EXPOSURE', 'Markets and exposure briefing: which of today\'s events plausibly move commodities, currencies or sectors, separating observed facts from inference.'],
                          ['WHAT CHANGED', 'Delta briefing: only what is new or unusual versus a normal day, ranked by importance, with the reason each item matters.'],
                        ].map(([label, request]) => (
                          <button key={label} onClick={() => { setShowBriefingMenu(false); handleBriefing(request); }} className="w-full text-left rounded-lg px-2 py-2 mt-1 hover:bg-white/[.07] transition-colors">
                            <div className="text-[10px] font-mono font-bold text-[var(--gold-primary)]">{label}</div>
                            <div className="text-[10px] leading-relaxed text-[#b8c1cf]">{request}</div>
                          </button>
                        ))}
                        <div className="mt-1 border-t border-white/10 pt-2">
                          <textarea value={customBriefing} onChange={(e) => setCustomBriefing(e.target.value)} rows={2} placeholder="Eigenes Briefing: z. B. 'Nur Südostasien, nächste 24h'" className="w-full resize-none rounded-lg bg-black/30 border border-white/10 px-2 py-1.5 text-[11px] text-white placeholder:text-[#8993a3] outline-none focus:border-[var(--gold-primary)]" />
                          <button disabled={!customBriefing.trim()} onClick={() => { const request = customBriefing.trim(); setCustomBriefing(''); setShowBriefingMenu(false); handleBriefing(request); }} className="mt-1 rounded-lg px-2.5 py-1.5 text-[9px] font-mono text-[var(--gold-primary)] border border-[var(--gold-primary)]/30 disabled:opacity-35">EIGENES BRIEFING STARTEN</button>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                  <div className="flex-1" />
                  <span className="flex items-center text-[9px] font-mono text-[#b8c1cf] tracking-wider">
                    <ChevronDown className="w-2.5 h-2.5 mr-0.5" />
                    SHIFT+ENTER FOR NEWLINE
                  </span>
                </div>

                {/* Input row */}
                <div className="flex gap-2 items-end">
                  <div
                    className={`flex-1 overflow-hidden transition-colors ${expanded ? 'rounded-3xl px-2' : 'rounded-xl'}`}
                    style={{
                      background: 'var(--bg-tertiary)',
                      border: expanded ? '1px solid rgba(255, 255, 255, 0.16)' : '1px solid rgba(212, 175, 55, 0.1)',
                    }}
                  >
                    <textarea
                      ref={inputRef}
                      value={inputText}
                      onChange={(e) => setInputText(e.target.value)}
                      onKeyDown={handleKeyDown}
                      placeholder={tr('analyst.placeholder')}
                      rows={1}
                      className={`w-full bg-transparent px-3 py-2.5 ${expanded ? 'text-[15px]' : 'text-[13px]'} text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none resize-none`}
                      style={{ maxHeight: '120px', minHeight: '36px' }}
                      disabled={isLoading}
                      onInput={(e) => {
                        const target = e.target as HTMLTextAreaElement;
                        target.style.height = 'auto';
                        target.style.height = Math.min(target.scrollHeight, 120) + 'px';
                      }}
                    />
                  </div>

                  <motion.button
                    whileHover={{ scale: 1.05 }}
                    whileTap={{ scale: 0.95 }}
                    onClick={handleSend}
                    disabled={!inputText.trim() || isLoading}
                    className={`shrink-0 ${expanded ? 'w-10 h-10 rounded-full' : 'w-9 h-9 rounded-xl'} flex items-center justify-center transition-all disabled:opacity-30`}
                    style={{
                      background:
                        inputText.trim() && !isLoading
                          ? 'linear-gradient(135deg, rgba(0, 229, 255, 0.2) 0%, rgba(0, 229, 255, 0.1) 100%)'
                          : 'rgba(255, 255, 255, 0.03)',
                      border: `1px solid ${
                        inputText.trim() && !isLoading ? 'rgba(0, 229, 255, 0.3)' : 'rgba(255, 255, 255, 0.06)'
                      }`,
                    }}
                  >
                    <Send
                      className="w-3.5 h-3.5"
                      style={{
                        color: inputText.trim() && !isLoading ? 'var(--cyan-primary)' : 'var(--text-muted)',
                      }}
                    />
                  </motion.button>
                </div>

                {/* Footer */}
                <div className="flex items-center justify-between mt-1.5 px-1">
                  <span className="text-[9px] font-mono text-[#b8c1cf] tracking-wider">
                    CHAT LIVE · {keySaved ? 'CUSTOM KEY' : 'SERVER KEY'} • {messages.filter((m) => m.role === 'user').length} QUERIES
                  </span>
                  <span className="text-[9px] font-mono text-[var(--text-muted)] tracking-wider">
                    FEEDS: {(data.earthquakes?.length || 0) + (data.news?.length || 0) + (data.gdelt?.length || 0)} ITEMS
                  </span>
                </div>
               </div>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  );
}
