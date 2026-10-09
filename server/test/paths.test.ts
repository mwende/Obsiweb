import { describe, expect, it } from 'vitest';
import { isHidden, isWithin, normalizeVaultPath, parentOf, toAbsolute } from '../src/vault/paths.js';

describe('normalizeVaultPath', () => {
  it('entfernt leere und "."-Segmente', () => {
    expect(normalizeVaultPath('/a//b/./c.md/')).toBe('a/b/c.md');
    expect(normalizeVaultPath('')).toBe('');
    expect(normalizeVaultPath('/')).toBe('');
  });
  it('lehnt Traversal, Backslash und NUL ab', () => {
    expect(() => normalizeVaultPath('a/../b')).toThrow();
    expect(() => normalizeVaultPath('..')).toThrow();
    expect(() => normalizeVaultPath('a\\b')).toThrow();
    expect(() => normalizeVaultPath('a\0b')).toThrow();
  });
  it('lässt Unicode-Formen unverändert', () => {
    const nfd = 'März.md';
    expect(normalizeVaultPath(nfd)).toBe(nfd);
  });
});

describe('Hilfsfunktionen', () => {
  it('toAbsolute bleibt im Vault', () => {
    expect(toAbsolute('/v', 'a/b')).toBe('/v/a/b');
    expect(toAbsolute('/v', '')).toBe('/v');
  });
  it('parentOf / isHidden / isWithin', () => {
    expect(parentOf('a/b/c.md')).toBe('a/b');
    expect(parentOf('c.md')).toBe('');
    expect(isHidden('.obsidian/app.json')).toBe(true);
    expect(isHidden('notes/a.md')).toBe(false);
    expect(isWithin('a/b', 'a')).toBe(true);
    expect(isWithin('ab', 'a')).toBe(false);
  });
});
