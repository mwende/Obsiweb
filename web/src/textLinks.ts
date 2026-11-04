/**
 * Erkennung von Links im Fließtext – gemeinsam genutzt von Editor (Cmd/Strg+Klick) und Vorschau.
 * Erkannt werden http(s)-URLs, "www."-Adressen, E-Mail-Adressen und [[Wikilinks]]. Bloße Namen wie "Notiz.md" oder
 * "notes.wende.it" bleiben Text, weil sie von Dateinamen nicht zu unterscheiden sind.
 */

/** http(s)://… oder www.…; Satzzeichen am Ende ("…, siehe https://x.de.") gehören nicht zur URL */
export const URL_RE = /(?:\bhttps?:\/\/|\bwww\.)[^\s<>()[\]{}"'`]*[^\s<>()[\]{}"'`.,;:!?*_~]/gi;

/** E-Mail-Adressen (→ mailto:). Die Längengrenzen halten die Laufzeit bei sehr langen Zeilen linear. */
export const EMAIL_RE = /\b[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63}){0,8}\.[a-z]{2,}\b/gi;

/** Alles, was im Editor als Link hervorgehoben wird */
export const LINK_HIGHLIGHT_RE = new RegExp(`${URL_RE.source}|${EMAIL_RE.source}`, 'gi');

/** [[Ziel]], [[Ziel|Alias]], [[Ziel#Abschnitt]], auch als Einbettung ![[…]] */
export const WIKILINK_RE = /!?\[\[([^\]\n]{1,500}?)\]\]/g;

export type TextLink = { kind: 'url'; href: string; from: number; to: number } | { kind: 'wiki'; target: string; from: number; to: number };

/** "www.x.de" → "https://www.x.de"; andere URLs unverändert */
export function normalizeUrl(url: string): string {
  return /^www\./i.test(url) ? `https://${url}` : url;
}

/** Sucht den Link, in dem die Position `offset` (0-basiert innerhalb von `text`) liegt. */
export function findLinkAt(text: string, offset: number): TextLink | null {
  for (const m of text.matchAll(WIKILINK_RE)) {
    const from = m.index!;
    const to = from + m[0].length;
    if (offset >= from && offset <= to) {
      const target = m[1].split('|')[0].trim();
      return target ? { kind: 'wiki', target, from, to } : null;
    }
  }
  for (const m of text.matchAll(URL_RE)) {
    const from = m.index!;
    const to = from + m[0].length;
    if (offset >= from && offset <= to) return { kind: 'url', href: normalizeUrl(m[0]), from, to };
  }
  for (const m of text.matchAll(EMAIL_RE)) {
    const from = m.index!;
    const to = from + m[0].length;
    if (offset >= from && offset <= to) return { kind: 'url', href: `mailto:${m[0]}`, from, to };
  }
  return null;
}

/** Nur Web- und Mail-Adressen öffnen – keine javascript:-, data:- o.ä. URLs */
export function isSafeWebUrl(href: string): boolean {
  try {
    const u = new URL(href);
    return u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'mailto:';
  } catch {
    return false;
  }
}

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const MOD_KEY_LABEL = isMac ? 'Cmd' : 'Strg';
