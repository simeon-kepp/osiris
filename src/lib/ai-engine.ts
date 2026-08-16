/**
 * ═══════════════════════════════════════════════════════════════
 *  OSIRIS — AI Intelligence Engine
 *  Gemini 2.0 Flash integration for real-time intelligence analysis
 *  Designed to correlate multi-domain feeds into actionable briefings
 * ═══════════════════════════════════════════════════════════════
 */

import { GoogleGenerativeAI, type GenerativeModel } from '@google/generative-ai';

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
   System Prompt — Palantir-grade analyst persona
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

const BRIEFING_PROMPT = `Generate a comprehensive OSIRIS Daily Intelligence Briefing based on the current operational data. Structure it as follows:

## OSIRIS INTELLIGENCE BRIEFING
**Classification:** OPEN SOURCE INTELLIGENCE (OSINT)
**DTG:** [Current timestamp]

### I. EXECUTIVE SUMMARY
2-3 sentence overview of the current global threat landscape based on available data.

### II. PRIORITY INTELLIGENCE REQUIREMENTS (PIRs)
Identify the top 3-5 most significant developments from the data feeds, ranked by assessed impact.

### III. SEISMIC & NATURAL HAZARD ASSESSMENT
Analyze earthquake data for patterns — clustering, tectonic corridor activity, tsunami risk.

### IV. GEOPOLITICAL & CONFLICT INTELLIGENCE
Synthesize news feeds for conflict escalation patterns, diplomatic shifts, or emerging crises.

### V. CYBER THREAT LANDSCAPE
Assess active CVEs and cyber alerts for coordinated campaign indicators or critical infrastructure risk.

### VI. COMPOUND RISK SCENARIOS
Identify where multiple threat vectors intersect (e.g., earthquake near a conflict zone, cyber attack during political instability).

### VII. FORECAST & WATCHLIST
- **Next 24 Hours**: Most likely developments
- **Next 72 Hours**: Emerging situations to monitor
- **Strategic Horizon**: Longer-term trend assessment

### VIII. ASSESSMENT CONFIDENCE
State overall confidence level and key analytical gaps.

Analyze the provided data thoroughly. Be specific — reference actual events, magnitudes, locations, and CVE IDs from the context.`;

/* ─────────────────────────────────────────────────────────────
   Client Factory
   ───────────────────────────────────────────────────────────── */

export function createGeminiClient(apiKey: string): GoogleGenerativeAI {
  return new GoogleGenerativeAI(apiKey);
}

/* ─────────────────────────────────────────────────────────────
   API Key Rotation — Round-robin through available keys
   ───────────────────────────────────────────────────────────── */

let _keyIndex = 0;

export function rotateApiKey(keys: string[]): string {
  if (keys.length === 0) {
    throw new Error('No API keys available');
  }
  const key = keys[_keyIndex % keys.length];
  _keyIndex = (_keyIndex + 1) % keys.length;
  return key;
}

/* ─────────────────────────────────────────────────────────────
   Context Serializer — Compact representation for token efficiency
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
      for (const p of g.predictions.slice(0, 20)) {
        const s = p.score !== undefined ? ` (model score ${p.score.toFixed(3)})` : '';
        sections.push(`  [PREDICTED] ${p.subject} --${p.relation}--> ${p.object}${s}`);
      }
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
   Intelligence Analysis
   ───────────────────────────────────────────────────────────── */

export async function analyzeIntelligence(
  client: GoogleGenerativeAI,
  context: IntelligenceContext,
  userQuery: string
): Promise<string> {
  const model: GenerativeModel = client.getGenerativeModel({
    model: 'gemini-2.0-flash',
    systemInstruction: SYSTEM_PROMPT,
  });

  const contextData = serializeContext(context);

  const prompt = `## CURRENT OPERATIONAL DATA
${contextData}

## ANALYST QUERY
${userQuery}

Provide your intelligence assessment based on the operational data above and the analyst's query.`;

  const result = await model.generateContent(prompt);
  const response = result.response;
  return response.text();
}

/* ─────────────────────────────────────────────────────────────
   Daily Briefing Generation
   ───────────────────────────────────────────────────────────── */

export async function generateBriefing(
  client: GoogleGenerativeAI,
  context: IntelligenceContext
): Promise<string> {
  const model: GenerativeModel = client.getGenerativeModel({
    model: 'gemini-2.0-flash',
    systemInstruction: SYSTEM_PROMPT,
  });

  const contextData = serializeContext(context);

  const prompt = `${BRIEFING_PROMPT}

## CURRENT OPERATIONAL DATA
${contextData}

Generate the briefing now.`;

  const result = await model.generateContent(prompt);
  const response = result.response;
  return response.text();
}
