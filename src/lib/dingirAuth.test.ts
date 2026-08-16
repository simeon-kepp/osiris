import { describe, it, expect } from 'vitest';
import {
  parseAllowlist,
  isAllowed,
  sign,
  verify,
  encodeSession,
  decodeSession,
} from './dingirAuth';

const SECRET = 'test-secret-not-a-real-one';

describe('parseAllowlist', () => {
  it('returns an empty list for undefined or empty input', () => {
    expect(parseAllowlist(undefined)).toEqual([]);
    expect(parseAllowlist('')).toEqual([]);
    expect(parseAllowlist('   ')).toEqual([]);
  });

  it('splits on commas and trims surrounding whitespace', () => {
    expect(parseAllowlist('simeon-kepp, laura ,zabih-sudo')).toEqual([
      'simeon-kepp',
      'laura',
      'zabih-sudo',
    ]);
  });

  it('lowercases logins so the comparison is case-insensitive', () => {
    expect(parseAllowlist('Simeon-Kepp')).toEqual(['simeon-kepp']);
  });

  it('drops empty entries from trailing or doubled commas', () => {
    expect(parseAllowlist('a,,b,')).toEqual(['a', 'b']);
  });
});

describe('isAllowed', () => {
  const list = parseAllowlist('simeon-kepp,zabih-sudo');

  it('denies when the allowlist is empty, even for a real login', () => {
    // Deny-by-default: an unconfigured deploy must not grant access.
    expect(isAllowed('simeon-kepp', [])).toBe(false);
  });

  it('denies an undefined or empty login', () => {
    expect(isAllowed(undefined, list)).toBe(false);
    expect(isAllowed('', list)).toBe(false);
  });

  it('allows a login on the list regardless of case', () => {
    expect(isAllowed('simeon-kepp', list)).toBe(true);
    expect(isAllowed('Simeon-Kepp', list)).toBe(true);
  });

  it('denies a login that is not on the list', () => {
    expect(isAllowed('some-stranger', list)).toBe(false);
  });

  it('does not treat a prefix or substring as a match', () => {
    expect(isAllowed('simeon', list)).toBe(false);
    expect(isAllowed('simeon-kepp-evil', list)).toBe(false);
  });
});

describe('sign / verify', () => {
  it('round-trips a value', () => {
    expect(verify(sign('hello', SECRET), SECRET)).toBe('hello');
  });

  it('rejects a value signed with a different secret', () => {
    expect(verify(sign('hello', SECRET), 'other-secret')).toBeNull();
  });

  it('rejects a tampered payload', () => {
    const signed = sign('hello', SECRET);
    const [, sig] = signed.split('.');
    expect(verify(`goodbye.${sig}`, SECRET)).toBeNull();
  });

  it('rejects malformed input', () => {
    expect(verify('', SECRET)).toBeNull();
    expect(verify('nodot', SECRET)).toBeNull();
    expect(verify('a.b.c', SECRET)).toBeNull();
  });

  it('handles values containing a dot', () => {
    expect(verify(sign('a.b.c', SECRET), SECRET)).toBe('a.b.c');
  });
});

describe('encodeSession / decodeSession', () => {
  const now = 1_760_000_000_000;

  it('round-trips a login', () => {
    const token = encodeSession('simeon-kepp', SECRET, now + 60_000);
    expect(decodeSession(token, SECRET, now)).toBe('simeon-kepp');
  });

  it('returns null once the session has expired', () => {
    const token = encodeSession('simeon-kepp', SECRET, now - 1);
    expect(decodeSession(token, SECRET, now)).toBeNull();
  });

  it('returns null for a session signed with a different secret', () => {
    const token = encodeSession('simeon-kepp', SECRET, now + 60_000);
    expect(decodeSession(token, 'other-secret', now)).toBeNull();
  });

  it('returns null for garbage input', () => {
    expect(decodeSession('', SECRET, now)).toBeNull();
    expect(decodeSession('not-a-token', SECRET, now)).toBeNull();
    expect(decodeSession(sign('{oops', SECRET), SECRET, now)).toBeNull();
  });

  it('returns null when the payload has no login', () => {
    expect(decodeSession(sign(JSON.stringify({ exp: now + 1 }), SECRET), SECRET, now)).toBeNull();
  });
});
