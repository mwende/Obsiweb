import MarkdownIt from 'markdown-it';
import { api } from './api';
import { baseOf, dirOf, isImage, joinPath, type LinkResolver } from './links';

export interface RenderEnv {
  resolver: LinkResolver;
  from: string;
}

type WikiMeta = { target: string; alias?: string };

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
type InlineRule = Parameters<typeof md.inline.ruler.before>[2];
type StateInline = Parameters<InlineRule>[0];

/** [[Ziel|Alias]] und ![[Ziel|Größe]] */
md.inline.ruler.before('link', 'wikilink', (state: StateInline, silent: boolean) => {
  const src = state.src;
  let pos = state.pos;
  const embed = src.charCodeAt(pos) === 0x21; /* ! */
  if (embed) pos++;
  if (!src.startsWith('[[', pos)) return false;
  const end = src.indexOf(']]', pos + 2);
  if (end === -1) return false;
  const inner = src.slice(pos + 2, end);
  if (!inner || inner.includes('\n')) return false;
  if (!silent) {
    const [target, alias] = splitOnce(inner, '|');
    const token = state.push(embed ? 'wikiembed' : 'wikilink', '', 0);
    token.meta = { target: target.trim(), alias: alias?.trim() };
  }
  state.pos = end + 2;
  return true;
});

md.renderer.rules.wikilink = (tokens, idx, _o, e) => {
  const env = e as unknown as RenderEnv;
  const { target, alias } = tokens[idx].meta as WikiMeta;
  const resolved = env.resolver.resolve(target, env.from);
  const label = md.utils.escapeHtml(alias || target.replace(/#\^?/, ' › '));
  const cls = resolved ? 'wikilink' : 'wikilink unresolved';
  return `<a href="#" class="${cls}" data-note="${md.utils.escapeHtml(resolved ?? target)}">${label}</a>`;
};

md.renderer.rules.wikiembed = (tokens, idx, _o, e) => {
  const env = e as unknown as RenderEnv;
  const { target, alias } = tokens[idx].meta as WikiMeta;
  const resolved = env.resolver.resolve(target, env.from);
  if (resolved && isImage(resolved)) {
    const size = alias && /^\d+(x\d+)?$/.test(alias) ? alias.split('x') : null;
    const dims = size ? ` width="${size[0]}"${size[1] ? ` height="${size[1]}"` : ''}` : '';
    return `<img src="${api.rawUrl(resolved)}" alt="${md.utils.escapeHtml(alias && !size ? alias : baseOf(resolved))}"${dims} loading="lazy">`;
  }
  if (resolved && /\.pdf$/i.test(resolved)) {
    return `<a href="${api.rawUrl(resolved)}" target="_blank" rel="noopener">📄 ${md.utils.escapeHtml(baseOf(resolved))}</a>`;
  }
  const cls = resolved ? 'wikilink embed' : 'wikilink unresolved';
  return `<a href="#" class="${cls}" data-note="${md.utils.escapeHtml(resolved ?? target)}">↪ ${md.utils.escapeHtml(alias || target)}</a>`;
};

// Aufgabenlisten "- [ ]" / "- [x]" als Checkboxen darstellen
md.core.ruler.after('inline', 'tasklist', (state) => {
  const tokens = state.tokens;
  for (let i = 2; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== 'inline' || tokens[i - 1].type !== 'paragraph_open' || tokens[i - 2].type !== 'list_item_open') continue;
    const first = t.children?.[0];
    const m = first?.type === 'text' ? /^\[([ xX])\]\s+/.exec(first.content) : null;
    if (!first || !m) continue;
    first.content = first.content.slice(m[0].length);
    const box = new state.Token('html_inline', '', 0);
    box.content = `<input type="checkbox" class="task" disabled${m[1] === ' ' ? '' : ' checked'}> `;
    t.children!.unshift(box);
    tokens[i - 2].attrJoin('class', 'task-item');
  }
});

// Relative Bildpfade ![](bild.png) auf den Vault abbilden
const defaultImage = md.renderer.rules.image!;
md.renderer.rules.image = (tokens, idx, options, e, self) => {
  const env = e as unknown as RenderEnv;
  const token = tokens[idx];
  const src = String(token.attrGet('src') ?? '');
  if (src && !/^[a-z][a-z0-9+.-]*:/i.test(src) && !src.startsWith('/')) {
    const decoded = safeDecode(src);
    const rel = joinPath(dirOf(env.from), decoded);
    const resolved = env.resolver.resolve(rel) ?? env.resolver.resolve(decoded, env.from);
    if (resolved) token.attrSet('src', api.rawUrl(resolved));
  }
  token.attrSet('loading', 'lazy');
  return defaultImage(tokens, idx, options, e, self);
};

// Externe Links in neuem Tab
const defaultLinkOpen = md.renderer.rules.link_open ?? ((t, i, o, _e, s) => s.renderToken(t, i, o));
md.renderer.rules.link_open = (tokens, idx, options, e, self) => {
  const href = String(tokens[idx].attrGet('href') ?? '');
  if (/^https?:/i.test(href)) {
    tokens[idx].attrSet('target', '_blank');
    tokens[idx].attrSet('rel', 'noopener noreferrer');
  }
  return defaultLinkOpen(tokens, idx, options, e, self);
};

export function renderMarkdown(source: string, env: RenderEnv): string {
  return md.render(stripFrontmatter(source), env as unknown as Record<string, unknown>);
}

function stripFrontmatter(s: string): string {
  if (!s.startsWith('---\n')) return s;
  const end = s.indexOf('\n---', 4);
  return end === -1 ? s : s.slice(s.indexOf('\n', end + 1) + 1);
}

function splitOnce(s: string, sep: string): [string, string | undefined] {
  const i = s.indexOf(sep);
  return i === -1 ? [s, undefined] : [s.slice(0, i), s.slice(i + 1)];
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
