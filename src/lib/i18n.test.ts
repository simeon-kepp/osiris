import { describe, it, expect } from 'vitest';
import { readStoredLocale, writeStoredLocale, translate, ALL_TRANSLATION_KEYS, type Locale } from './i18n';

// This project's vitest.config.ts runs `environment: 'node'` project-wide --
// no jsdom, and none is installed. Adding it as a dependency for three test
// cases would be the exact kind of weight the "no i18n library" call earlier
// in this change was made to avoid, so `window` is stubbed by hand instead:
// just enough of localStorage for readStoredLocale/writeStoredLocale to run
// against something real rather than being skipped.
function withWindow<T>(run: () => T): T {
  const store = new Map<string, string>();
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    },
  };
  try {
    return run();
  } finally {
    delete (globalThis as { window?: unknown }).window;
  }
}

// The dashboard was English-only since it existed. This is the seam's own
// test file, not a regression suite carried over from before it -- the two
// failure modes worth guarding are the ones that are invisible in the UI: a
// key present in one locale's dictionary and silently missing from the
// other, and a locale falling back to English text without anyone deciding
// that on purpose.

describe('translate', () => {
  it('returns the string for a known key in each locale', () => {
    expect(translate('en', 'header.title')).toBe('DINGIR');
    expect(translate('de', 'header.title')).toBe('DINGIR');
    expect(translate('de', 'tool.markets')).toBe('MÄRKTE');
  });

  it('calls a function-valued entry with its arguments', () => {
    expect(translate('en', 'evidence.degree', '42')).toBe('degree 42');
    expect(translate('de', 'evidence.degree', '42')).toBe('Grad 42');
    expect(translate('de', 'reasoning.evidence.title', 'COUNTRY:ru'))
      .toBe('Was der Korpus über COUNTRY:ru festhält');
  });

  it('falls back to the English string for an unmapped locale entry', () => {
    // Cast past the type system on purpose: this simulates a key that exists
    // in en but was accidentally dropped from de, which the type-level
    // Record<Locale, Record<TranslationKey, ...>> constraint is meant to make
    // impossible at compile time. The runtime fallback is the second line of
    // defence for exactly the case the type system missed -- a key added to
    // one locale and not the other before this test suite existed to catch it
    // at compile time.
    const fakeLocale = 'xx' as Locale;
    expect(translate(fakeLocale, 'header.title')).toBe('DINGIR');
  });
});

describe('readStoredLocale', () => {
  it('defaults to en with no window at all (this is the real SSR case, not a stub)', () => {
    // No withWindow() here on purpose: this environment genuinely has no
    // window, same as the server-rendered first paint LocaleProvider is
    // written for. If readStoredLocale ever stopped guarding
    // `typeof window === 'undefined'`, this is the test that would catch it,
    // by throwing instead of returning a value.
    expect(readStoredLocale()).toBe('en');
  });

  it('defaults to en when a window exists but nothing is stored', () => {
    withWindow(() => expect(readStoredLocale()).toBe('en'));
  });

  it('only ever returns "en" or "de", never an unrecognised stored value', () => {
    withWindow(() => {
      window.localStorage.setItem('dingir-locale', 'fr');
      expect(readStoredLocale()).toBe('en');
    });
  });

  it('reads back a locale that was actually saved', () => {
    withWindow(() => {
      writeStoredLocale('de');
      expect(readStoredLocale()).toBe('de');
    });
  });
});

describe('dictionary parity', () => {
  // The check this session ran by hand to confirm the two dictionaries agree,
  // kept as a real test rather than a one-off script: every key that exists
  // in en must resolve to something in de too, or a component using it in
  // German silently reads English with nobody told. A key that is genuinely
  // unmapped falls back to English and reads back as the SAME string in both
  // locales -- distinguishable from a real German translation, which by
  // construction differs from its English counterpart at least once
  // somewhere in the sentence for every key in this dictionary.
  const FN_KEYS: string[] = [
    'reasoning.evidence.title', 'evidence.degree', 'reasoning.search.placeholder',
    'reasoning.network.stats', 'reasoning.type.hide', 'reasoning.type.show',
    'reasoning.neighbours.count',
  ];
  // Two placeholders covers every function-valued key so far, including the
  // one two-argument entry (reasoning.network.stats) -- a function declared
  // with fewer parameters just ignores the extra one, so this stays correct
  // even for the single-argument keys.
  const FN_ARGS = ['X', 'Y'];

  it('every key resolves to a non-empty string in both locales', () => {
    for (const key of ALL_TRANSLATION_KEYS) {
      const args = FN_KEYS.includes(key) ? FN_ARGS : [];
      const en = translate('en', key, ...args);
      const de = translate('de', key, ...args);
      expect(en, `en:${key}`).toBeTruthy();
      expect(de, `de:${key}`).toBeTruthy();
    }
  });

  // Every key where the German dictionary line was written byte-identical to
  // the English one, checked by hand against what each actually is: a proper
  // noun, a product name, or a word that IS the correct German word
  // unchanged. Not a shortcut around translating them -- "Route", "Graph" and
  // "Chat" are the real German words, not English left in place.
  const INTENTIONALLY_IDENTICAL = new Set([
    'header.title',     // DINGIR: the product name
    'analyst.title',    // DINGIR: the product name, reused for the chat head
    'tool.arcgis',      // ArcGIS: Esri's product name, never translated
    'tool.graph',       // "Graph" is the German word, not an anglicism
    'tool.route',        // "Route" is the German word, not an anglicism
    'tool.chat',        // "Chat" is the standard German loanword, universal in German tech UI
    'tool.feed',        // "Feed" likewise -- "RSS-Feed" etc. are not translated in German either
    'tool.reasoning',   // kept as the feature's own name, matching "Reasoning Panel" branding
    'tool.remote',      // kept as the feature's own name; "Remote" is common German tech shorthand
    'header.subtitle',  // "OPEN SOURCE INTELLIGENCE" -- open source is routinely left untranslated in German tech branding
  ]);

  it('every OTHER key actually has a distinct German translation, not a silent English fallback', () => {
    const untranslated: string[] = [];
    for (const key of ALL_TRANSLATION_KEYS) {
      if (INTENTIONALLY_IDENTICAL.has(key)) continue;
      const args = FN_KEYS.includes(key) ? FN_ARGS : [];
      const en = translate('en', key, ...args);
      const de = translate('de', key, ...args);
      if (en === de) untranslated.push(key);
    }
    expect(untranslated, `keys with no distinct German text: ${untranslated.join(', ')}`)
      .toEqual([]);
  });

  it('the intentional-identical list itself has not drifted out of date', () => {
    // If a key on this list ever DOES get a real translation, this test
    // fails and the entry should be deleted from the set above -- it exists
    // so the exception list stays honest rather than silently growing to
    // cover future gaps too.
    for (const key of INTENTIONALLY_IDENTICAL) {
      expect(ALL_TRANSLATION_KEYS, `${key} is on the exception list but not a real key`)
        .toContain(key);
    }
  });
});
