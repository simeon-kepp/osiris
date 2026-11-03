import { describe, it, expect } from 'vitest';
import { extractUrls, htmlToText, isPrivateAddress, wantsWebSearch, fetchPage } from './webContext';

describe('isPrivateAddress', () => {
  it.each(['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.10', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', 'not-an-ip'])(
    'refuses %s', ip => expect(isPrivateAddress(ip)).toBe(true),
  );
  it.each(['1.1.1.1', '172.32.0.1', '8.8.8.8', '2606:4700:4700::1111'])(
    'allows %s', ip => expect(isPrivateAddress(ip)).toBe(false),
  );
});

describe('fetchPage', () => {
  // The Colony runs the engine on :8080 next to this process.
  it('will not read our own services', async () => {
    await expect(fetchPage('http://127.0.0.1:8080/health')).rejects.toThrow('internal address');
    await expect(fetchPage('http://localhost:4000/')).rejects.toThrow('internal address');
  });
  it('only fetches http(s)', async () => {
    await expect(fetchPage('file:///etc/passwd')).rejects.toThrow('only http(s)');
  });
});

describe('extractUrls', () => {
  it('finds links, drops trailing punctuation, dedupes, caps at three', () => {
    expect(extractUrls('schau https://a.example/x, und https://a.example/x. dann (https://b.example) https://c.example https://d.example'))
      .toEqual(['https://a.example/x', 'https://b.example', 'https://c.example']);
  });
});

describe('htmlToText', () => {
  it('keeps the words, drops scripts and tags', () => {
    const { title, text } = htmlToText('<html><head><title> Hallo  Welt </title></head><body><script>evil()</script><p>Erste&nbsp;Zeile</p><p>Zweite &amp; letzte</p></body></html>');
    expect(title).toBe('Hallo Welt');
    expect(text).toBe('Erste Zeile\nZweite & letzte');
  });
});

describe('wantsWebSearch', () => {
  it.each(['google mal die Zinsen', 'such im Netz nach Rheinpegel', 'recherchier das', 'look up the ECB rate', 'search the web for it'])(
    'searches for "%s"', q => expect(wantsWebSearch(q)).toBe(true),
  );
  it.each(['ist die Engine online?', 'wie viele Beben in Japan?', 'hi', 'und warum?'])(
    'does not search for "%s"', q => expect(wantsWebSearch(q)).toBe(false),
  );
});
