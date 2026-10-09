/** Auflösung von Obsidian-Links ([[Notiz]], ![[bild.png]]) gegen die Dateiliste des Vaults. */

export const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
export const baseOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);
export const stripMd = (p: string) => p.replace(/\.md$/i, '');
export const isImage = (p: string) => /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(p);
export const isNote = (p: string) => /\.md$/i.test(p);

export function joinPath(...parts: string[]): string {
  const out: string[] = [];
  for (const seg of parts.join('/').split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

export class LinkResolver {
  private exact: Set<string>;
  private byName = new Map<string, string[]>();

  constructor(files: string[]) {
    this.exact = new Set(files);
    for (const f of files) {
      for (const key of new Set([baseOf(f).toLowerCase(), stripMd(baseOf(f)).toLowerCase()])) {
        const list = this.byName.get(key) ?? [];
        list.push(f);
        this.byName.set(key, list);
      }
    }
  }

  /** Liefert den Vault-Pfad zu einem Linkziel oder null. `from` = Pfad der verlinkenden Notiz. */
  resolve(target: string, from = ''): string | null {
    const t = target.split('#')[0].split('^')[0].trim();
    if (!t) return null;
    const candidates = [t, `${t}.md`, joinPath(dirOf(from), t), joinPath(dirOf(from), `${t}.md`)];
    for (const c of candidates) if (this.exact.has(c)) return c;
    if (t.includes('/')) {
      // Teilpfad: "Ordner/Notiz" passt auf ".../Ordner/Notiz.md"
      const suffix = `/${stripMd(t).toLowerCase()}`;
      const match = [...this.exact].filter((f) => `/${stripMd(f).toLowerCase()}`.endsWith(suffix));
      if (match.length) return pickClosest(match, from);
    }
    const byName = this.byName.get(baseOf(t).toLowerCase());
    return byName?.length ? pickClosest(byName, from) : null;
  }
}

function pickClosest(paths: string[], from: string): string {
  const dir = dirOf(from);
  return [...paths].sort((a, b) => {
    const sa = dirOf(a) === dir ? 0 : 1;
    const sb = dirOf(b) === dir ? 0 : 1;
    return sa - sb || a.split('/').length - b.split('/').length || a.localeCompare(b);
  })[0];
}
