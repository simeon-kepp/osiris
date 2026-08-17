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
const SYSTEM_PROMPT = `You are the DINGIR analyst. DINGIR is a whitebox world model: everything it holds is either something a source stated, something computed from something a source stated, or something the model guessed. Your entire job is to answer without ever blurring those three together.

## THE PROVENANCE RULE — this outranks every other instruction here
Every fact in your context carries a provenance class. You must carry it through into your answer.

- **OBSERVED** — a source stated this. You may assert it. Name the source when the context gives one.
- **DERIVED** — computed from a stated field by a named rule (e.g. a country parsed out of a free-text place string). Assert it, and say it was computed and by what rule. A derivation can be wrong even when the underlying record is right.
- **PREDICTED** — the model expects a relation for which NO edge exists. This is a hypothesis and nothing else. Never state it as fact, never let it carry an argument, never let it appear in a summary sentence without the word "hypothesis" or "predicted" attached. If a prediction is the only support for a conclusion, the honest answer is that there is no support for that conclusion.

If asked something the context cannot answer, say so plainly and say what would be needed. "The graph does not contain this" is a complete and useful answer. An assembled-sounding answer built from weak links is worse than no answer, because the reader cannot see which part was weak.

## WHAT YOU ARE FOR
The point is early warning that a person can check. A chain like "sustained heat -> accelerated snowmelt -> river rise -> put sandbags out now" is worth stating only if each link is visible and classed. State the chain, then state which links are OBSERVED and which are your inference, and where the chain would break.

## HOW TO ANSWER
- Lead with the answer, then the evidence for it, then what would falsify it.
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
    for (const eq of context.earthquakes.slice(0, 20)) {
      const tsunamiFlag = eq.tsunami ? ' TSUNAMI' : '';
      const alertFlag = eq.alert ? ` [ALERT:${eq.alert.toUpperCase()}]` : '';
      sections.push(
        `  M${eq.magnitude} | ${eq.location} | ${eq.latitude.toFixed(2)},${eq.longitude.toFixed(2)} | Depth:${eq.depth}km | ${eq.timestamp}${tsunamiFlag}${alertFlag}`
      );
    }
  }

  if (context.news.length > 0) {
    sections.push(`\n[OSINT NEWS FEED — ${context.news.length} items]`);
    for (const item of context.news.slice(0, 15)) {
      const coords = item.coords ? ` | GEO:${item.coords[0].toFixed(2)},${item.coords[1].toFixed(2)}` : '';
      sections.push(
        `  RISK:${item.risk_score}/10 | ${item.source} | ${item.title}${coords} | ${item.published}`
      );
    }
  }

  if (context.threats.length > 0) {
    sections.push(`\n[THREAT EVENTS — ${context.threats.length} active]`);
    for (const threat of context.threats.slice(0, 15)) {
      sections.push(
        `  ${threat.severity} | ${threat.type} | ${threat.title} | ${threat.region} | ${threat.timestamp}`
      );
    }
  }

  if (context.cyberAlerts.length > 0) {
    sections.push(`\n[CYBER ALERTS — ${context.cyberAlerts.length} active]`);
    for (const alert of context.cyberAlerts.slice(0, 10)) {
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

/* ─────────────────────────────────────────────────────────────
   Provider seam

   One function shape: (system, user) -> text. Two implementations today,
   a third (albert.) later. `resolveProvider` decides which, so no caller
   has to.
   ───────────────────────────────────────────────────────────── */

export interface LlmProvider {
  /** Shown in the UI so the operator always knows who answered. */
  label: string;
  model: string;
  complete(system: string, user: string): Promise<string>;
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
const NIM_MODEL = process.env.NVIDIA_MODEL || 'meta/llama-3.1-8b-instruct';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

/** OpenAI-compatible chat completions. Covers NVIDIA NIM and anything speaking
 *  the same protocol, which is most self-hosted inference today. */
function openAiCompatible(apiKey: string, base: string, model: string, label: string): LlmProvider {
  return {
    label,
    model,
    async complete(system, user) {
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          temperature: 0.2,     // an analyst, not a writer
          max_tokens: 2048,
          stream: false,
        }),
        // Generous: a 70B on a free tier is not fast, and failing at 30s would
        // look like a broken integration rather than a slow one.
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`${label} ${res.status}: ${detail.slice(0, 300)}`);
      }
      const body = await res.json();
      const text = body?.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || !text.trim()) {
        throw new Error(`${label} returned no content`);
      }
      return text;
    },
  };
}

function gemini(apiKey: string): LlmProvider {
  return {
    label: 'Gemini',
    model: GEMINI_MODEL,
    async complete(system, user) {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: 'user', parts: [{ text: user }] }],
            generationConfig: { temperature: 0.2, maxOutputTokens: 2048 },
          }),
          signal: AbortSignal.timeout(120_000),
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
export function resolveProvider(userKey?: string): LlmProvider | null {
  const k = userKey?.trim();
  if (k) {
    return k.startsWith('nvapi-')
      ? openAiCompatible(k, NIM_BASE, NIM_MODEL, 'NVIDIA NIM')
      : gemini(k);
  }
  const nim = envKeys('NVIDIA_API_KEY');
  if (nim.length) return openAiCompatible(rotateApiKey(nim), NIM_BASE, NIM_MODEL, 'NVIDIA NIM');
  const gem = envKeys('GEMINI_API_KEY');
  if (gem.length) return gemini(rotateApiKey(gem));
  return null;
}

/* ─────────────────────────────────────────────────────────────
   The two things the analyst is asked to do
   ───────────────────────────────────────────────────────────── */

export async function analyzeIntelligence(
  provider: LlmProvider,
  context: IntelligenceContext,
  userQuery: string
): Promise<string> {
  return provider.complete(
    SYSTEM_PROMPT,
    `## CURRENT OPERATIONAL DATA
${serializeContext(context)}

## ANALYST QUERY
${userQuery}

Answer the query against the data above. Carry the provenance class of every fact you use.`
  );
}

export async function generateBriefing(
  provider: LlmProvider,
  context: IntelligenceContext
): Promise<string> {
  return provider.complete(
    SYSTEM_PROMPT,
    `${BRIEFING_PROMPT}

## CURRENT OPERATIONAL DATA
${serializeContext(context)}

Write the briefing now.`
  );
}
