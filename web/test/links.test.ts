import { describe, expect, it } from 'vitest';
import { LinkResolver } from '../src/links';
import { renderMarkdown } from '../src/markdown';
import { findLinkAt, isSafeWebUrl, normalizeUrl } from '../src/textLinks';

const render = (s: string) => renderMarkdown(s, { resolver: new LinkResolver([]), from: '' });

describe('findLinkAt (Editor, Cmd/Strg+Klick)', () => {
  const line = 'Doku: https://example.com/a?b=1, Portal www.wende.it. Notiz [[Projekt Alpha|Alpha]] und Notiz.md';
  it('findet URLs ohne Satzzeichen am Ende', () => {
    expect(findLinkAt(line, line.indexOf('example'))).toMatchObject({ kind: 'url', href: 'https://example.com/a?b=1' });
    expect(findLinkAt(line, line.indexOf('wende'))).toMatchObject({ kind: 'url', href: 'https://www.wende.it' });
  });
  it('findet Wikilinks inkl. Alias', () => {
    expect(findLinkAt(line, line.indexOf('Alpha]]'))).toMatchObject({ kind: 'wiki', target: 'Projekt Alpha' });
  });
  it('liefert nichts für Text und Dateinamen', () => {
    expect(findLinkAt(line, 2)).toBeNull();
    expect(findLinkAt(line, line.indexOf('Notiz.md') + 2)).toBeNull();
  });
  it('erkennt URLs in Markdown-Links und Klammern', () => {
    const md = 'Siehe [Doku](https://docs.de/x) (oder https://alt.de)';
    expect(findLinkAt(md, md.indexOf('docs'))).toMatchObject({ href: 'https://docs.de/x' });
    expect(findLinkAt(md, md.indexOf('alt.de'))).toMatchObject({ href: 'https://alt.de' });
  });
  it('erkennt E-Mail-Adressen als mailto', () => {
    const t = 'Kontakt: info@wende.it, bitte';
    expect(findLinkAt(t, t.indexOf('wende'))).toMatchObject({ kind: 'url', href: 'mailto:info@wende.it' });
    expect(findLinkAt('Version 1.2.3', 9)).toBeNull();
  });
  it('öffnet nur http(s) und mailto', () => {
    expect(isSafeWebUrl('mailto:a@b.de')).toBe(true);
    expect(isSafeWebUrl('https://x.de')).toBe(true);
    expect(isSafeWebUrl('javascript:alert(1)')).toBe(false);
    expect(normalizeUrl('www.x.de')).toBe('https://www.x.de');
  });
});

describe('Vorschau', () => {
  it('verlinkt http(s), www und E-Mail – in neuem Tab', () => {
    const html = render('A https://example.com B www.wende.it C info@wende.it');
    expect(html).toContain('<a href="https://example.com" target="_blank" rel="noopener noreferrer">https://example.com</a>');
    expect(html).toContain('<a href="https://www.wende.it" target="_blank" rel="noopener noreferrer">www.wende.it</a>');
    expect(html).toContain('<a href="mailto:info@wende.it">info@wende.it</a>');
  });
  it('lässt Dateinamen und bloße Hostnamen als Text', () => {
    const html = render('Siehe Notiz.md und notes.wende.it und config.js');
    expect(html).not.toContain('<a ');
  });
  it('keine Links in Code', () => {
    expect(render('`https://x.de`')).not.toContain('<a ');
  });
});

describe('Laufzeit bei sehr langen Zeilen', () => {
  it('bleibt linear', () => {
    const t0 = performance.now();
    findLinkAt('a.'.repeat(200_000), 5);
    findLinkAt('[['.repeat(200_000), 5);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});
