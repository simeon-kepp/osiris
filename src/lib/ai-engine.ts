/**
 * ═══════════════════════════════════════════════════════════════
 *  DINGIR — language head
 *
 *  Provider-agnostic. The seam is "system prompt + user prompt in,
 *  text out" and nothing above it knows which model answered, so
 *  putting albert. behind it later is a config change rather than a
 *  rewrite. Putting the seam at the client-object level instead would
 *  have leaked one provider's request shape into every caller.
 *
 *  Order of preference: NVIDIA NIM (free tier, OpenAI-compatible),
 *  then Gemini. A key pasted into the settings panel wins over both.
 * ═══════════════════════════════════════════════════════════════
 */

/* ─────────────────────────────────────────────────────────────
   Data Interfaces — Zero `any` types
   ───────────────────────────────────────────────────────────── */

export interface EarthquakeEvent {
  id: string;
  magnitude: number;
  location: string;
  latitude: number;
  longitude: number;
  depth: number;
  timestamp: string;
  tsunami: boolean;
  felt: number | null;
  alert: string | null;
}

export interface NewsItem {
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

export interface ThreatEvent {
  id: string;
  type: string;
  title: string;
  description: string;
  severity: 'CRITICAL' | 'HIGH' | 'ELEVATED' | 'LOW';
  region: string;
  latitude: number;
  longitude: number;
  timestamp: string;
  source: string;
}

export interface CyberAlert {
  id: string;
  name: string;
  vendor: string;
  product: string;
  severity: string;
  date: string;
  due: string;
  source: string;
}

/* DINGIR's own graph, handed to the analyst alongside the live feeds.
   Every element carries its provenance class, because the distinction between
   "the audit recorded this" and "the model expects this" is the only thing that
   separates this system from the black boxes it is meant to be an answer to. */

export interface GraphEdgeFact {
  subject: string;
  relation: string;
  object: string;
  /** OBSERVED = stated by a source. DERIVED = computed from a stated field.
   *  PREDICTED = the GCN's link prediction, i.e. no evidence at all. */
  provenance: 'OBSERVED' | 'DERIVED' | 'PREDICTED' | string;
  score?: number;
}

export interface GraphContext {
  /** The node the operator is looking at, if any. */
  focus?: string;
  focusType?: string;
  neighbours: GraphEdgeFact[];
  anomalies: { node: string; type: string; degree: number; score: number }[];
  predictions: GraphEdgeFact[];
  totals: { nodes: number; edges: number };
  /** Held-out test AUC of the model producing the predictions, so the analyst
   *  can state how much weight a PREDICTED edge actually carries. */
  modelTestAuc?: number;
}

export interface IntelligenceContext {
  earthquakes: EarthquakeEvent[];
  news: NewsItem[];
  threats: ThreatEvent[];
  cyberAlerts: CyberAlert[];
  timestamp: string;
  /** Optional: absent on the public feeds-only surface, present behind the
   *  DINGIR login where the reasoning graph is exposed. */
  graph?: GraphContext;
}

/* ─────────────────────────────────────────────────────────────
   System prompt — bound to the same provenance discipline as the graph
   ───────────────────────────────────────────────────────────── */

// REWRITTEN 2026-08-16. The previous version instructed the model to write as
// "a Palantir Forward Deployed Engineer crossed with a CIA PDB analyst", in
// military brevity with DTG/AOR/COA notation. That is an instruction to sound
// authoritative, and sounding authoritative is precisely the failure this system
// exists to avoid: every edge in the graph is classed OBSERVED / DERIVED /
// PREDICTED, and a language head that flattens those three into confident prose
// makes the classification decorative. The persona below is bound to the same
// epistemic discipline the graph is.
const SYSTEM_PROMPT = `## WHO YOU ARE IN THIS CHAT
Your name is DINGIR. You were built by RFI-IRFOS (rfi-irfos.com), the institute behind the DINGIR world model. If asked who you are, who made you or what you run on: say you are DINGIR, built by RFI-IRFOS. Say "built", never claim RFI-IRFOS trained the language model. The language model underneath is swappable and picked in the chat settings; name it only if asked which model is answering, never present it as your maker.

This chat is the operator's only way to talk to DINGIR. It is a conversation first: talk like a sharp colleague who happens to sit on top of a queryable data warehouse of live feeds (earthquakes, news/OSINT, threats, cyber alerts, markets) and the evidence graph. The operator may be a founder, an investor or an analyst, so be useful in the first sentence.

You can do three things, and the question decides which:
1. Talk normally. Small talk, opinions, explanations, brainstorming, general knowledge: answer like a person would, without dragging the data in. No provenance labels on general knowledge.
2. Answer from the data. Questions about what is happening, counts, regions, the graph: answer from CURRENT OPERATIONAL DATA in the system message.
3. Use the web. When WEB RESULTS or FETCHED PAGES are present, they are pages the search or the operator's link returned this turn. Use them for anything the feeds do not hold and cite each one as a markdown link [site](url). Never claim you searched when neither is present; say instead that the web switch in the chat header turns search on.

## HOW YOU TALK
- LANGUAGE: reply in the language of the operator's LAST message (the line after "Operator:"). English in, English out; German in, German out. Ignore the language of the data and of these instructions. If unsure, English.
- Natural and direct, like a colleague. A greeting gets a one-line greeting back, no "how are you", no "how can I help" in any language ("Wie kann ich dir helfen/behilflich sein?" included); a light remark about what is going on in the data is better. Never open with a greeting or "I am ready" otherwise.
- Use the conversation. "And in Europe?", "why?", "show me the second one", "what changed since" refer to your previous answer: resolve them against it and the context instead of starting over.
- The earlier turns of this chat are real messages above the current one. Read them before answering.
- On a data question, answer on the topic asked, from the data. "Cyber" means the CYBER ALERTS section and cyber items in news/OSINT first. If the data holds nothing on it, say that in one sentence and name the closest relevant thing you do have. Never pad with unrelated items.
- Be smart about the data: count, rank, group by region or source, compare, flag what is unusual (a cluster of quakes in one place, a risk score that stands out, a region appearing in several feeds). Connect feeds when a real link exists and say what the link is; if it is only co-location, say so.
- FOLLOW-UPS: only about every second or third answer, and never in the same shape twice in a row. Look at your previous turns in this conversation and do not reuse their wording or sentence pattern (no repeated "Would you like to know more about..."). Vary it: sometimes a concrete next query, sometimes a sharp observation that invites a reply, sometimes a comparison to try, sometimes a question about what the operator is deciding, sometimes nothing at all. Every suggestion must be answerable from this data. Never for small talk or dead ends.
- Length: match the question. A short question gets a short answer; 2 to 6 sentences or a short list is the usual size. Go long when asked to explain, compare or brief. Use bold sparingly for key entities and numbers.
- No report structure in conversation: no "Answer / Evidence / Falsification" headings unless the operator asks for an analysis.
- The provenance classes are your discipline, not your vocabulary. Never write OBSERVED, DERIVED or PREDICTED as words in a conversational answer; say it the way a person would: "laut USGS" / "per USGS", "computed from the place name", "that is a guess, nothing in the data links them".
- "Why" questions: the feeds hold events, not causes, so explain with general knowledge (plate tectonics, seasons, how markets react, known history), clearly as background ("in general..."), then tie it back to what the data shows. Refusing to explain because the data has no cause field is the wrong answer. If it needs current facts, offer the web search.
- Provenance rules below apply to every factual claim about the data, the graph or the web, and PREDICTED edges are always labelled as hypotheses, but state them briefly instead of as a lecture.

You are the DINGIR analyst. DINGIR is a whitebox world model: everything it holds is either something a source stated, something computed from something a source stated, or something the model guessed. Your entire job is to answer without ever blurring those three together.

## THE PROVENANCE RULE — this outranks every other instruction here
Every fact in your context carries a provenance class. You must carry it through into your answer.

- **OBSERVED** — a source stated this. You may assert it. Name the source when the context gives one.
- **DERIVED** — computed from a stated field by a named rule (e.g. a country parsed out of a free-text place string). Assert it, and say it was computed and by what rule. A derivation can be wrong even when the underlying record is right.
- **PREDICTED** — the model expects a relation for which NO edge exists. This is a hypothesis and nothing else. Never state it as fact, never let it carry an argument, never let it appear in a summary sentence without the word "hypothesis" or "predicted" attached. If a prediction is the only support for a conclusion, the honest answer is that there is no support for that conclusion.
- **WEB** — a page from WEB RESULTS or FETCHED PAGES. It is OBSERVED for what that page says, not for whether it is true: cite the link, and say when only one site carries a claim.

If asked something the context cannot answer, say so plainly and say what would be needed. "The graph does not contain this" is a complete and useful answer. An assembled-sounding answer built from weak links is worse than no answer, because the reader cannot see which part was weak.

## WHAT YOU ARE FOR
The point is early warning that a person can check. A chain like "sustained heat -> accelerated snowmelt -> river rise -> put sandbags out now" is worth stating only if each link is visible and classed. State the chain, then state which links are OBSERVED and which are your inference, and where the chain would break.

## HOW TO ANSWER AN ANALYSIS QUESTION
- Lead with the answer, then the evidence for it, and, when the operator is weighing a conclusion, what would falsify it.
- Distinguish correlation from causation explicitly. Two events in one region is a coincidence until something connects them.
- State confidence, and state what it is based on — the number of supporting OBSERVED edges, not a feeling. If the context reports the model's held-out AUC, treat that as the ceiling on how much any PREDICTED edge is worth, and say so.
- Plain language over jargon. No tactical notation, no brevity codes, no house style that makes a guess sound like a finding.
- Never invent an entity, a number, a date or a source that is not in the context.
- You are an analyst, not a decision-maker: lay out what is known and what follows, and leave the call to the person reading.

## WHAT YOU ARE NOT
You are not a black box producing verdicts. If a reader cannot trace your conclusion back to specific items in the context, you have written the wrong answer.`;

// The briefing prompt was the last place the old persona survived: it asked for
// an "OSIRIS Daily Intelligence Briefing" with a DTG line and roman-numeral
// sections, which is a house style that makes every section sound equally
// settled. Rewritten to ask for the same content with the provenance carried.
const BRIEFING_PROMPT = `Write the current DINGIR situation briefing from the operational data below.

Structure it as follows, and drop any section the data cannot fill rather than padding it:

**WHAT CHANGED**
The few developments that actually matter right now, most consequential first. For each, say plainly what is known and how it is known.

**HAZARD PICTURE**
Seismic and disaster data: clustering, corridor activity, tsunami risk. Say when a pattern is a pattern and when it is the ordinary background rate.

**GEOPOLITICAL PICTURE**
What the event and news feeds support. Escalation and de-escalation both count.

**WHERE THINGS INTERSECT**
Places where more than one thread touches the same region or the same actor. State explicitly whether anything connects them beyond proximity — usually nothing does, and saying so is the useful part.

**WHAT THE GRAPH SUGGESTS BUT CANNOT SHOW**
Predicted relations only. Every line here is a hypothesis with no evidence behind it. Say what would have to be observed to confirm each one.

**WHAT TO WATCH**
Next 24 hours, next 72 hours. What would change the picture.

**CONFIDENCE AND GAPS**
Overall confidence, what it rests on, and the specific things you could not see.

Reference real entities, magnitudes, locations and identifiers from the data. Do not invent any.`;

/* ─────────────────────────────────────────────────────────────
   Context serializer — compact, and provenance-carrying
   ───────────────────────────────────────────────────────────── */

function serializeContext(context: IntelligenceContext): string {
  const sections: string[] = [];

  sections.push(`[TIMESTAMP] ${context.timestamp}`);

  if (context.earthquakes.length > 0) {
    sections.push(`\n[SEISMIC DATA — ${context.earthquakes.length} events]`);
    for (const eq of context.earthquakes.slice(0, 100)) {
      const tsunamiFlag = eq.tsunami ? ' TSUNAMI' : '';
      const alertFlag = eq.alert ? ` [ALERT:${eq.alert.toUpperCase()}]` : '';
      sections.push(
        `  M${eq.magnitude} | ${eq.location} | ${eq.latitude.toFixed(2)},${eq.longitude.toFixed(2)} | Depth:${eq.depth}km | ${eq.timestamp}${tsunamiFlag}${alertFlag}`
      );
    }
  }

  if (context.news.length > 0) {
    sections.push(`\n[OSINT NEWS FEED — ${context.news.length} items]`);
    for (const item of context.news.slice(0, 80)) {
      const coords = item.coords ? ` | GEO:${item.coords[0].toFixed(2)},${item.coords[1].toFixed(2)}` : '';
      sections.push(
        `  RISK:${item.risk_score}/10 | ${item.source} | ${item.title}${coords} | ${item.published}` +
          (item.description && item.description !== item.title ? `\n      ${item.description.replace(/\s+/g, ' ').slice(0, 240)}` : '')
      );
    }
  }

  if (context.threats.length > 0) {
    sections.push(`\n[THREAT EVENTS — ${context.threats.length} active]`);
    for (const threat of context.threats.slice(0, 60)) {
      sections.push(
        `  ${threat.severity} | ${threat.type} | ${threat.title} | ${threat.region} | ${threat.timestamp}`
      );
    }
  }

  if (context.cyberAlerts.length > 0) {
    sections.push(`\n[CYBER ALERTS — ${context.cyberAlerts.length} active]`);
    for (const alert of context.cyberAlerts.slice(0, 50)) {
      sections.push(
        `  ${alert.id} | ${alert.severity} | ${alert.vendor}/${alert.product} | ${alert.name} | Due:${alert.due}`
      );
    }
  }

  const g = context.graph;
  if (g) {
    sections.push(
      `\n[DINGIR GRAPH — ${g.totals.nodes} nodes, ${g.totals.edges} edges]` +
        (g.modelTestAuc !== undefined
          ? `\n  Model held-out test AUC: ${g.modelTestAuc.toFixed(3)}. ` +
            `Every PREDICTED item below is worth no more than this number says.`
          : '')
    );

    if (g.focus) {
      sections.push(`\n[FOCUS] ${g.focus}${g.focusType ? ` (${g.focusType})` : ''}`);
    }

    // Observed and derived edges are listed separately from predictions, and
    // each line repeats its own class. A model that skims will still see the
    // class next to the claim rather than in a heading three lines up.
    const evidence = g.neighbours.filter(e => e.provenance !== 'PREDICTED');
    if (evidence.length > 0) {
      sections.push(`\n[EVIDENCE EDGES — ${evidence.length}] these have sources behind them`);
      for (const e of evidence.slice(0, 40)) {
        sections.push(`  [${e.provenance}] ${e.subject} --${e.relation}--> ${e.object}`);
      }
    }

    if (g.predictions.length > 0) {
      sections.push(
        `\n[PREDICTED EDGES — ${g.predictions.length}] HYPOTHESES ONLY. ` +
          `No evidence exists for any line in this block. Do not state any of ` +
          `them as fact, and do not let one carry a conclusion on its own.`
      );
      // The raw DistMult score is unbounded and is NOT a probability. Shipping
      // it bare invited exactly the misreading it looks like: an analyst wrote
      // "model score 6.744" next to a hypothesis, where 6.744 reads as high
      // confidence and on its own means nothing. It is only ever a ranking key
      // within this block, and it is labelled as such.
      for (const p of g.predictions.slice(0, 20)) {
        const s = p.score !== undefined ? ` (rank score ${p.score.toFixed(2)})` : '';
        sections.push(`  [PREDICTED] ${p.subject} --${p.relation}--> ${p.object}${s}`);
      }
      sections.push(
        `  NOTE: "rank score" orders these lines against each other and nothing ` +
          `else. It is not a probability and not a confidence -- a higher score ` +
          `does not mean a claim is more likely true, only that the model ranked ` +
          `it above the line below it. Do not quote it as a confidence figure.`
      );
    }

    if (g.anomalies.length > 0) {
      sections.push(
        `\n[STRUCTURAL ANOMALIES — ${g.anomalies.length}] nodes whose embedding sits ` +
          `far from their graph neighbours. DERIVED: this is a property of the ` +
          `learned space, not a finding about the world. It says "look here", ` +
          `not "something is wrong here".`
      );
      for (const a of g.anomalies.slice(0, 15)) {
        sections.push(`  [DERIVED] ${a.node} (${a.type}) degree=${a.degree} score=${a.score.toFixed(3)}`);
      }
    }
  }

  return sections.join('\n');
}

import { LLM_MODELS } from './llm-models';

/* ─────────────────────────────────────────────────────────────
   Provider seam

   One function shape: (system, user) -> text. Two implementations today,
   a third (albert.) later. `resolveProvider` decides which, so no caller
   has to.
   ───────────────────────────────────────────────────────────── */

/** One earlier turn of the chat. Sent as real alternating messages: pasted into
 *  the user prompt as "Operator: ... DINGIR: ..." the model read the whole chat
 *  as one document and answered it like a report, not like a reply. */
export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface CompleteOptions {
  maxTokens?: number;
  history?: ChatTurn[];
  /** Ask the provider to search the web first. Ignored where unsupported. */
  webSearch?: boolean;
}

export interface LlmProvider {
  /** Shown in the UI so the operator always knows who answered. */
  label: string;
  model: string;
  /** Only OpenRouter has a web-search plugin today. NIM and Gemini do not. */
  supportsWebSearch?: boolean;
  complete(system: string, user: string, options?: CompleteOptions): Promise<string>;
  /** Same call, but every piece of text is handed to `onToken` as the model writes it. */
  stream?(system: string, user: string, options: CompleteOptions | undefined, onToken: (text: string) => void): Promise<string>;
}

/** Streams when the provider can, otherwise delivers the whole answer as one piece. */
export async function completeStreaming(
  p: LlmProvider, system: string, user: string, options: CompleteOptions | undefined, onToken: (text: string) => void,
): Promise<string> {
  if (p.stream) return p.stream(system, user, options, onToken);
  const text = await p.complete(system, user, options);
  onToken(text);
  return text;
}

const NIM_BASE = process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1';
// PROBED, NOT ASSUMED. /v1/models lists 102 handles but listing is not
// entitlement: nvidia/llama-3.1-nemotron-70b-instruct, mistralai/mistral-large-2
// and mistralai/mistral-7b-instruct-v0.3 are all in the catalogue and all
// return 404 for this account.
//
// meta/llama-3.1-70b-instruct (the previous default, answered in ~0.7s on
// 2026-08-16) was swapped out 2026-08-17 - live feedback was that the
// analyst felt slow to answer ("das fette nemotron da braucht zu lange zum
// nachdenken"). It was never actually a Nemotron handle in this file, but a
// real one exists in the catalogue that reproduces exactly that symptom:
// nvidia/llama-3.1-nemotron-nano-8b-v1 timed out at 15s on a two-token
// "Say OK" probe -- a genuine reasoning model that burns hidden
// chain-of-thought tokens before answering, unlike the plain -instruct
// models here. Re-probed four small candidates rather than guess:
// meta/llama-3.2-3b-instruct timed out (15s, no response), that same
// nemotron-nano-8b timed out, meta/llama-3.1-8b-instruct answered in 579ms,
// nvidia/nemotron-mini-4b-instruct in 484ms. Picked the Llama one to stay
// in the same model family as the previous default, ~9x smaller.
// Override with NVIDIA_MODEL; a wrong handle fails loudly with a 404 naming
// the provider rather than silently degrading.
// PROBED against the configured NVIDIA key on 2026-09-02. The previously
// selected Nemotron handles returned 410 Gone because NVIDIA retired them;
// nvidia/nemotron-3.5-lightning-30b-a3b is currently answering on the same
// free NIM tier. It is a real Nemotron handle, not a Mistral fallback.
// Keep it configurable because trial entitlements can change independently of
// the application, but never silently fall back to a retired model.
const NIM_MODEL = process.env.NVIDIA_MODEL || 'nvidia/nemotron-3.5-lightning-30b-a3b';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
// PROBED 2026-10-10: openai/gpt-oss-*:free no longer exists on OpenRouter (404 "unavailable for
// free"). The paid openai/gpt-oss-120b answered in ~0.9s at ~$0.00004 per 1k tokens, which is the
// closest thing to free that is also fast. Default is now google/gemini-2.5-flash (~0.8s on a short prompt, stronger than -lite at synthesising across feeds;
// no reasoning phase, so no hidden-thinking latency); gpt-oss stays selectable via OPENROUTER_MODEL.
const OPENROUTER_BASE = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash';

/** OpenAI-compatible chat completions. Covers NVIDIA NIM and anything speaking
 *  the same protocol, which is most self-hosted inference today. */
function openAiCompatible(
  apiKey: string,
  base: string,
  model: string,
  label: string,
  extraBody: Record<string, unknown> = { chat_template_kwargs: { enable_thinking: false } },
  webCapable = false
): LlmProvider {
  const post = (stream: boolean, system: string, user: string, options: CompleteOptions) => {
    // PROBED 2026-11-03 on google/gemini-2.5-flash: 3 results, ~2s, ~$0.008 a call,
    // sources come back as inline markdown links.
    const web = webCapable && options.webSearch ? { plugins: [{ id: 'web', max_results: 4 }] } : {};
    return fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          ...(options.history ?? []),
          { role: 'user', content: user },
        ],
        temperature: 0.2,     // an analyst, not a writer
        max_tokens: options.maxTokens ?? 2048,
        stream,
        // Lightning supports the OpenAI-compatible template switch. Without
        // this, its default thinking trace consumes the same generation
        // budget as the visible answer and can truncate a simple response.
        ...extraBody,
        ...web,
      }),
      // Generous: a 70B on a free tier is not fast, and failing at 30s would
      // look like a broken integration rather than a slow one.
      signal: AbortSignal.timeout(options.maxTokens && options.maxTokens < 1000 ? 45_000 : 120_000),
    });
  };
  const fail = async (res: Response) => {
    const detail = await res.text().catch(() => '');
    return new Error(`${label} ${res.status}: ${detail.slice(0, 300)}`);
  };
  return {
    label,
    model,
    supportsWebSearch: webCapable,
    async complete(system, user, options = {}) {
      const res = await post(false, system, user, options);
      if (!res.ok) throw await fail(res);
      const body = await res.json();
      const text = body?.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || !text.trim()) {
        throw new Error(`${label} returned no content`);
      }
      return text;
    },
    async stream(system, user, options = {}, onToken) {
      const res = await post(true, system, user, options);
      if (!res.ok) throw await fail(res);
      if (!res.body) throw new Error(`${label} returned no stream`);
      // Server-sent events: `data: {json}` lines, a blank line between events, `data: [DONE]` at the end.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let full = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const piece = JSON.parse(payload)?.choices?.[0]?.delta?.content;
            if (typeof piece === 'string' && piece) { full += piece; onToken(piece); }
          } catch { /* keep-alive or partial frame */ }
        }
      }
      if (!full.trim()) throw new Error(`${label} returned no content`);
      return full;
    },
  };
}

function gemini(apiKey: string): LlmProvider {
  return {
    label: 'Gemini',
    model: GEMINI_MODEL,
    async complete(system, user, options = {}) {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: [
              ...(options.history ?? []).map(t => ({ role: t.role === 'assistant' ? 'model' : 'user', parts: [{ text: t.content }] })),
              { role: 'user', parts: [{ text: user }] },
            ],
            generationConfig: { temperature: 0.2, maxOutputTokens: options.maxTokens ?? 2048 },
          }),
        signal: AbortSignal.timeout(options.maxTokens && options.maxTokens < 1000 ? 45_000 : 120_000),
        }
      );
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Gemini ${res.status}: ${detail.slice(0, 300)}`);
      }
      const body = await res.json();
      const text = body?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text || '').join('');
      if (!text || !text.trim()) throw new Error('Gemini returned no content');
      return text;
    },
  };
}

/** Round-robin across however many keys of one kind are configured. */
let _keyIndex = 0;
export function rotateApiKey(keys: string[]): string {
  if (keys.length === 0) throw new Error('No API keys available');
  const key = keys[_keyIndex % keys.length];
  _keyIndex = (_keyIndex + 1) % keys.length;
  return key;
}

function envKeys(prefix: string): string[] {
  const out: string[] = [];
  const single = process.env[prefix];
  if (single && single.trim()) out.push(single.trim());
  for (let i = 1; i <= 8; i++) {
    const k = process.env[`${prefix}_${i}`];
    if (k && k.trim()) out.push(k.trim());
  }
  return out;
}

/**
 * Which model answers, and why that one.
 *
 * `userKey` is whatever was pasted into the settings panel. It is routed by
 * shape rather than by a second dropdown the operator would have to keep in
 * sync with the key: an `nvapi-` key is a NIM key, anything else is treated as
 * Gemini. Getting this wrong is loud (401 naming the provider), not silent.
 */
/** Free OpenRouter models, tried after the paid pick fails. The list moves: ids were
 *  read from /models on 2026-11-07, and a retired id just fails over to the next one. */
const OPENROUTER_FREE_FALLBACKS = ['nvidia/nemotron-3.5-lightning:free', 'google/gemma-4-31b-it:free'];

/** Tries each provider in order and keeps the first answer. The chat used to die whenever the
 *  one chosen model failed (empty credit, rate limit, outage). The label switches to the model
 *  that actually answered, marked as a fallback, and the route reads it after the call. */
function withFallback(chain: LlmProvider[]): LlmProvider {
  if (chain.length === 1) return chain[0];
  const self: LlmProvider = {
    label: chain[0].label,
    model: chain[0].model,
    supportsWebSearch: chain[0].supportsWebSearch,
    async complete(system, user, options = {}) {
      let lastErr: unknown;
      for (let i = 0; i < chain.length; i++) {
        const p = chain[i];
        try {
          const text = await p.complete(system, user, p.supportsWebSearch ? options : { ...options, webSearch: false });
          self.label = i === 0 ? p.label : `${p.label} (fallback)`;
          self.model = p.model;
          return text;
        } catch (e) {
          lastErr = e;
          console.warn(`[ai] ${p.label} / ${p.model} failed, trying next:`, e instanceof Error ? e.message.slice(0, 160) : e);
        }
      }
      throw lastErr;
    },
    async stream(system, user, options = {}, onToken) {
      let lastErr: unknown;
      for (let i = 0; i < chain.length; i++) {
        const p = chain[i];
        let emitted = false;
        try {
          const text = await completeStreaming(p, system, user, p.supportsWebSearch ? options : { ...options, webSearch: false }, t => { emitted = true; onToken(t); });
          self.label = i === 0 ? p.label : `${p.label} (fallback)`;
          self.model = p.model;
          return text;
        } catch (e) {
          lastErr = e;
          // Text already on the operator's screen cannot be taken back, so a mid-answer failure ends here.
          if (emitted) throw e;
          console.warn(`[ai] ${p.label} / ${p.model} failed, trying next:`, e instanceof Error ? e.message.slice(0, 160) : e);
        }
      }
      throw lastErr;
    },
  };
  return self;
}

export function resolveProvider(userKey?: string, modelChoice?: string): LlmProvider | null {
  const k = userKey?.trim();
  const choice = LLM_MODELS.find(m => m.id === modelChoice?.trim());
  if (k) {
    return k.startsWith('nvapi-')
      ? openAiCompatible(k, NIM_BASE, NIM_MODEL, 'NVIDIA NIM')
      : gemini(k);
  }
  // The operator's dropdown pick wins over the env default, but only from the allowlist.
  const orKeys = envKeys('OPENROUTER_API_KEY');
  const nimKeys = envKeys('NVIDIA_API_KEY');
  if (choice?.provider === 'nvidia' && nimKeys.length) {
    return openAiCompatible(rotateApiKey(nimKeys), NIM_BASE, NIM_MODEL, 'NVIDIA NIM');
  }
  if (orKeys.length) {
    const picked = choice && choice.provider === 'openrouter' ? choice : undefined;
    const modelId = picked?.id ?? OPENROUTER_MODEL;
    // Measured: gemini-2.5-flash 1.65s with thinking off vs 3.3s at effort=low. gpt-oss cannot be
    // switched off, so it keeps effort=low.
    const reasoning = picked
      ? picked.reasoning
      : modelId.includes('gpt-oss') ? { effort: 'low' } : modelId.startsWith('google/') ? { enabled: false } : undefined;
    const chain: LlmProvider[] = [
      openAiCompatible(rotateApiKey(orKeys), OPENROUTER_BASE, modelId, 'OpenRouter', reasoning ? { reasoning } : {}, true),
    ];
    if (modelId !== OPENROUTER_MODEL) {
      chain.push(openAiCompatible(rotateApiKey(orKeys), OPENROUTER_BASE, OPENROUTER_MODEL, 'OpenRouter', { reasoning: { enabled: false } }, true));
    }
    for (const free of OPENROUTER_FREE_FALLBACKS) {
      chain.push(openAiCompatible(rotateApiKey(orKeys), OPENROUTER_BASE, free, 'OpenRouter', {}, false));
    }
    if (nimKeys.length) chain.push(openAiCompatible(rotateApiKey(nimKeys), NIM_BASE, NIM_MODEL, 'NVIDIA NIM'));
    const gemKeys = envKeys('GEMINI_API_KEY');
    if (gemKeys.length) chain.push(gemini(rotateApiKey(gemKeys)));
    return withFallback(chain);
  }
  const nim = nimKeys;
  if (nim.length) return openAiCompatible(rotateApiKey(nim), NIM_BASE, NIM_MODEL, 'NVIDIA NIM');
  const gem = envKeys('GEMINI_API_KEY');
  if (gem.length) return gemini(rotateApiKey(gem));
  return null;
}

/* ─────────────────────────────────────────────────────────────
   The two things the analyst is asked to do
   ───────────────────────────────────────────────────────────── */

/** A page the operator linked, fetched server-side (see webContext.ts). */
export interface FetchedPage {
  url: string;
  title: string;
  text: string;
}

export interface AnalyzeOptions {
  history?: ChatTurn[];
  webSearch?: boolean;
  pages?: FetchedPage[];
  /** The MEMORY section from chat-memory.ts. */
  memory?: string;
  /** When set, the answer is streamed to this callback while it is written. */
  onToken?: (text: string) => void;
  /** Lookups the model may call mid-answer (see chat-tools.ts). */
  tools?: { help: string; run: (call: Record<string, unknown>) => Promise<{ label: string; result: string }> };
  /** A summary of the part of this conversation that no longer fits word for word. */
  summary?: string;
  /** Called when a tool starts, so the UI can say what is being looked up. */
  onStatus?: (text: string) => void;
}

const MAX_TOOL_ROUNDS = 3;

/** Holds back the first few characters of a streamed answer. A reply that opens with TOOL is a
 *  lookup request, not text for the operator, so it must never reach the screen. */
function toolGate(emit?: (t: string) => void) {
  let buf = '';
  let mode: 'wait' | 'pass' | 'tool' = 'wait';
  return {
    push(t: string) {
      if (mode === 'pass') { emit?.(t); return; }
      buf += t;
      if (mode === 'tool') return;
      const head = buf.trimStart();
      if (head.length < 5) return;
      if (head.startsWith('TOOL')) mode = 'tool';
      else { mode = 'pass'; emit?.(buf); }
    },
    flush() { if (mode === 'wait' && buf) emit?.(buf); },
    /** The reply turned out not to be a usable lookup: show it after all. */
    release() { if (mode === 'tool' && buf) emit?.(buf); },
  };
}

// The data sits in the system message and the operator's words are the last
// thing the model reads. It used to be the other way round: the question came
// after the whole data dump and was followed by "Answer the query against the
// data above. Carry the provenance class of every fact you use", so even "and
// why?" came back as a small report.
export async function analyzeIntelligence(
  provider: LlmProvider,
  context: IntelligenceContext,
  userQuery: string,
  options: AnalyzeOptions = {}
): Promise<string> {
  const webSearch = Boolean(options.webSearch && provider.supportsWebSearch);
  const pages = (options.pages ?? [])
    .map(p => `### ${p.title || p.url}\nURL: ${p.url}\n${p.text}`)
    .join('\n\n');
  const system = `${SYSTEM_PROMPT}

## CURRENT OPERATIONAL DATA
${serializeContext(context)}
${options.memory ? `\n${options.memory}\n` : ''}${pages ? `\n## FETCHED PAGES (WEB, fetched this turn from links the operator sent)\n${pages}\n` : ''}
## WEB SEARCH THIS TURN
${webSearch ? 'ON. The search results attached to this turn are your WEB RESULTS.' : 'OFF.'}
${options.summary ? `\n## EARLIER IN THIS CONVERSATION (summary of the oldest messages)\n${options.summary}\n` : ''}${options.tools ? `\n${options.tools.help}\n` : ''}`;

  let history = [...(options.history ?? [])];
  let query = userQuery;
  for (let round = 0; ; round++) {
    const canCall = Boolean(options.tools) && round < MAX_TOOL_ROUNDS;
    const callOptions = { maxTokens: 2000, history, webSearch };
    const gate = toolGate(canCall ? options.onToken : undefined);
    const text = options.onToken
      ? await completeStreaming(provider, system, query, callOptions, canCall ? gate.push : options.onToken)
      : await provider.complete(system, query, callOptions);
    if (canCall) gate.flush();
    const m = canCall ? text.trimStart().match(/^TOOL\s*:?\s*(\{[\s\S]*\})/) : null;
    let call: Record<string, unknown> | null = null;
    if (m) { try { call = JSON.parse(m[1]); } catch { call = null; } }
    if (canCall && !m) gate.release();
    if (!call || !options.tools) {
      // A malformed TOOL line was held back by the gate; the operator gets an honest message, not silence.
      if (m && !call && options.onToken) options.onToken('I tried to look something up but the request was malformed. Ask me again.');
      return call ? text : (m ? 'I tried to look something up but the request was malformed. Ask me again.' : text);
    }
    const out = await options.tools.run(call);
    options.onStatus?.(out.label);
    history = [...history, { role: 'user', content: query }, { role: 'assistant', content: text.trim() }];
    query = `TOOL RESULT (${String(call.tool)}):\n${out.result.slice(0, 12_000)}\n\nNow answer the operator's question from this result${round + 1 >= MAX_TOOL_ROUNDS ? ' (no more tools, answer now)' : ''}: "${userQuery}"`;
  }
}

export async function generateBriefing(
  provider: LlmProvider,
  context: IntelligenceContext,
  request = 'Generate the full current intelligence briefing.'
): Promise<string> {
  return provider.complete(
    SYSTEM_PROMPT,
    `${BRIEFING_PROMPT}

## CURRENT OPERATIONAL DATA
${serializeContext(context)}

## OPERATOR BRIEFING REQUEST
${request}

Write the briefing now.`
  );
}
