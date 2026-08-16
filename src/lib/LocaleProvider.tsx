'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { readStoredLocale, translate, writeStoredLocale, type Locale, type TranslationKey } from './i18n';

interface LocaleContextValue {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (key: TranslationKey, ...args: string[]) => string;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function LocaleProvider({ children }: { children: ReactNode }) {
  // Starts 'en' on the server and every client's first render, then reads
  // localStorage in an effect. Reading it during the initial render would
  // make the server-rendered markup and the client's first paint disagree
  // whenever a returning visitor has 'de' saved -- a hydration mismatch, not
  // a locale bug.
  const [locale, setLocaleState] = useState<Locale>('en');

  useEffect(() => { setLocaleState(readStoredLocale()); }, []);

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    writeStoredLocale(l);
  }, []);

  const t = useCallback((key: TranslationKey, ...args: string[]) => translate(locale, key, ...args), [locale]);

  return (
    <LocaleContext.Provider value={{ locale, setLocale, t }}>
      {children}
    </LocaleContext.Provider>
  );
}

export function useLocale(): LocaleContextValue {
  const ctx = useContext(LocaleContext);
  if (!ctx) {
    // A component rendered outside the provider is a wiring bug, not a state
    // that should silently fall back to English -- better to fail loudly at
    // the one place it can still be traced to a missing <LocaleProvider>.
    throw new Error('useLocale() called outside <LocaleProvider>');
  }
  return ctx;
}
