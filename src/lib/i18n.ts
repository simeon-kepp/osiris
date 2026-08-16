'use client';

// The dashboard has been English-only since it existed: no locale context, no
// dictionary, nothing to extend. This is the seam. It covers the global chrome
// (header, tool-strip labels and tooltips) and the DINGIR-specific reasoning
// surfaces built this session -- the panels that actually carry the "ethical,
// whitebox world model" pitch, which is what a non-English-reading stakeholder
// most needs in their own language.
//
// SCOPE, STATED RATHER THAN LEFT IMPLICIT. The map/OSINT/ArcGIS/Markets
// surfaces are NOT translated in this pass -- that is dozens of components
// this session did not touch, and translating them without being able to
// visually verify layout at German string lengths would be exactly the kind
// of unverified sprawl the project's own working rules argue against. Missing
// keys fall back to the key itself rather than throwing, so an untranslated
// surface degrades to readable English instead of a runtime error.
//
// No i18n LIBRARY: this dashboard has no dependency on next-intl or similar,
// and a two-locale flat dictionary does not need one. A missing translation
// key is a TypeScript error at the call site (`t('...')` is typed against the
// dictionary), not a silent blank string discovered in production.

export type Locale = 'en' | 'de';

const DICT = {
  en: {
    'header.title': 'DINGIR',
    'header.subtitle': 'OPEN SOURCE INTELLIGENCE',
    'tool.reasoning': 'REASONING',
    'tool.reasoning.title': "Reasoning Panel — DINGIR's trained graph-embedding space",
    'tool.feed': 'FEED',
    'tool.feed.title': 'Reasoning Feed — what DINGIR is currently noticing, with observations and hypotheses kept apart',
    'tool.chat': 'CHAT',
    'tool.chat.title': 'DINGIR — ask the world model, answers carry their provenance',
    'tool.graph': 'GRAPH',
    'tool.graph.title': 'Entity Graph — link analysis between tracked entities',
    'tool.arcgis': 'ARCGIS',
    'tool.arcgis.title': 'ArcGIS — search & import geospatial intel layers',
    'tool.route': 'ROUTE',
    'tool.route.title': 'Directions — turn-by-turn routing',
    'tool.search': 'SEARCH',
    'tool.search.title': 'Search — find locations, cities, coordinates',
    'tool.osint': 'RECON',
    'tool.osint.title': 'OSINT Recon — IP lookup, network sweep, geolocation',
    'tool.markets': 'MARKETS',
    'tool.markets.title': 'Markets — crypto prices, space weather, global indices',
    'tool.alerts': 'ALERTS',
    'tool.alerts.title': 'Live Alerts — earthquakes, conflicts, breaking news',
    'tool.remote': 'REMOTE',
    'tool.remote.title': 'World Remote — control nearby Bluetooth devices (TVs, speakers, AC)',
    'lang.toggle': 'Switch dashboard language',
    // Reasoning panel
    'reasoning.title': 'REASONING PANEL',
    'reasoning.subtitle': 'DINGIR graph-embedding inspector',
    'reasoning.evidence': 'EVIDENCE',
    'reasoning.evidence.title': (n: string) => `What the corpus records about ${n}`,
    // Reasoning feed
    'feed.title': 'REASONING FEED',
    'feed.waiting': 'waiting for the first snapshot... a cold engine trains before it can answer.',
    'feed.empty': 'nothing of this kind right now.',
    'feed.reconnecting': 'reconnecting...',
    'feed.connecting': 'connecting...',
    'feed.hypothesis': 'HYPOTHESIS · no evidence behind this ·',
    // Evidence panel
    'evidence.title': 'EVIDENCE',
    'evidence.reading': 'reading the corpus…',
    'evidence.sources': 'SOURCES',
    'evidence.recorded': 'RECORDED',
    'evidence.notStated': 'not stated',
    'evidence.observed': 'OBSERVED',
    'evidence.derived': 'DERIVED',
    'evidence.observedNote': 'A source states these.',
    'evidence.derivedNote': 'Computed from a stated field. A derivation can be wrong even when the record behind it is right.',
    'evidence.truncated': 'More edges exist than are shown. This node is a hub.',
    'evidence.noEdges': 'No edges recorded for this node. It is in the graph but nothing connects it.',
    'evidence.degree': (n: string) => `degree ${n}`,
    // Analyst
    'analyst.title': 'DINGIR',
    'analyst.ready': 'INTELLIGENCE ANALYST READY',
    'analyst.briefing': 'GET BRIEFING',
    'analyst.placeholder': 'Query the intelligence analyst...',
  },
  de: {
    'header.title': 'DINGIR',
    'header.subtitle': 'OPEN SOURCE INTELLIGENCE',
    'tool.reasoning': 'REASONING',
    'tool.reasoning.title': 'Reasoning-Panel — DINGIRs trainierter Graph-Embedding-Raum',
    'tool.feed': 'FEED',
    'tool.feed.title': 'Reasoning-Feed — was DINGIR gerade bemerkt, Beobachtung und Hypothese getrennt gehalten',
    'tool.chat': 'CHAT',
    'tool.chat.title': 'DINGIR — das Weltmodell befragen, Antworten mit Herkunftsnachweis',
    'tool.graph': 'GRAPH',
    'tool.graph.title': 'Entity Graph — Verknüpfungsanalyse zwischen erfassten Entitäten',
    'tool.arcgis': 'ARCGIS',
    'tool.arcgis.title': 'ArcGIS — geodatenbasierte Intel-Layer suchen & importieren',
    'tool.route': 'ROUTE',
    'tool.route.title': 'Wegbeschreibung — Turn-by-Turn-Navigation',
    'tool.search': 'SUCHE',
    'tool.search.title': 'Suche — Orte, Städte, Koordinaten finden',
    'tool.osint': 'OSINT',
    'tool.osint.title': 'OSINT-Recon — IP-Abfrage, Netzwerk-Sweep, Geolokalisierung',
    'tool.markets': 'MÄRKTE',
    'tool.markets.title': 'Märkte — Kryptopreise, Weltraumwetter, globale Indizes',
    'tool.alerts': 'ALARME',
    'tool.alerts.title': 'Live-Alarme — Erdbeben, Konflikte, aktuelle Meldungen',
    'tool.remote': 'REMOTE',
    'tool.remote.title': 'World Remote — Bluetooth-Geräte in der Nähe steuern (TV, Lautsprecher, Klima)',
    'lang.toggle': 'Dashboard-Sprache wechseln',
    'reasoning.title': 'REASONING-PANEL',
    'reasoning.subtitle': 'DINGIR-Graph-Embedding-Inspektor',
    'reasoning.evidence': 'BELEGE',
    'reasoning.evidence.title': (n: string) => `Was der Korpus über ${n} festhält`,
    'feed.title': 'REASONING-FEED',
    'feed.waiting': 'warte auf den ersten Schnappschuss … eine kalte Engine trainiert erst, bevor sie antworten kann.',
    'feed.empty': 'gerade nichts dieser Art.',
    'feed.reconnecting': 'verbinde erneut...',
    'feed.connecting': 'verbinde...',
    'feed.hypothesis': 'HYPOTHESE · keine Belege dahinter ·',
    'evidence.title': 'BELEGE',
    'evidence.reading': 'lese den Korpus …',
    'evidence.sources': 'QUELLEN',
    'evidence.recorded': 'ERFASST',
    'evidence.notStated': 'nicht angegeben',
    'evidence.observed': 'BEOBACHTET',
    'evidence.derived': 'ABGELEITET',
    'evidence.observedNote': 'Eine Quelle stellt das fest.',
    'evidence.derivedNote': 'Aus einem angegebenen Feld berechnet. Eine Ableitung kann falsch sein, auch wenn der zugrundeliegende Eintrag stimmt.',
    'evidence.truncated': 'Es existieren mehr Kanten als angezeigt. Dieser Knoten ist ein Hub.',
    'evidence.noEdges': 'Für diesen Knoten sind keine Kanten erfasst. Er ist im Graphen, aber nichts verbindet ihn.',
    'evidence.degree': (n: string) => `Grad ${n}`,
    'analyst.title': 'DINGIR',
    'analyst.ready': 'INTELLIGENCE-ANALYST BEREIT',
    'analyst.briefing': 'BRIEFING ANFORDERN',
    'analyst.placeholder': 'Den Intelligence-Analysten befragen...',
  },
} as const satisfies Record<Locale, Record<string, string | ((...a: string[]) => string)>>;

export type TranslationKey = keyof typeof DICT.en;

/** Every key both locales are expected to resolve. Exported only so the test
 *  suite can iterate the real dictionary instead of a hand-copied list that
 *  would drift the moment a key is added here and not there. */
export const ALL_TRANSLATION_KEYS = Object.keys(DICT.en) as TranslationKey[];

const STORAGE_KEY = 'dingir-locale';

export function readStoredLocale(): Locale {
  if (typeof window === 'undefined') return 'en';
  const v = window.localStorage.getItem(STORAGE_KEY);
  return v === 'de' ? 'de' : 'en';
}

export function writeStoredLocale(locale: Locale) {
  try { window.localStorage.setItem(STORAGE_KEY, locale); } catch { /* private mode */ }
}

/** Look up a key in the given locale, falling back to the key itself so an
 *  unmapped string degrades to readable English rather than throwing or
 *  rendering blank.
 *
 *  `locale` is typed as `Locale` and every call site is expected to only ever
 *  pass 'en' or 'de', but the type is not a runtime guarantee -- and the
 *  fallback promised above did not actually hold for a locale VALUE outside
 *  {en, de}: `DICT[locale]` was `undefined` for any other string, and
 *  `undefined[key]` throws before the `?? DICT.en[key]` fallback ever runs.
 *  `readStoredLocale()` already guards its own return value, but that guard
 *  lived in exactly one caller, not in this function, so nothing stopped a
 *  future caller from constructing a Locale a different way (a URL param, an
 *  old stored value written before that guard existed) and hitting this. The
 *  dictionary lookup is now defensive on its own, which is where a function
 *  whose whole purpose is "never throw, always return text" has to be. */
export function translate(locale: Locale, key: TranslationKey, ...args: string[]): string {
  const dict = DICT[locale] ?? DICT.en;
  const entry = dict[key] ?? DICT.en[key];
  if (typeof entry === 'function') return (entry as (...a: string[]) => string)(...args);
  return entry ?? key;
}
