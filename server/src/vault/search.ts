import type { Db } from '../db/knex.js';
import { isMysql } from '../db/knex.js';
import { escapeLike } from './VaultService.js';
import { isHidden } from './paths.js';

export interface SearchHit {
  path: string;
  snippet: string;
}

const MIN_FT_TOKEN = 3; // InnoDB innodb_ft_min_token_size (Default 3)

export async function searchVault(db: Db, userId: number, query: string, limit = 50): Promise<SearchHit[]> {
  const terms = query
    .split(/\s+/)
    .map((t) => t.replace(/[+\-<>()~*"@]/g, '').trim())
    .filter(Boolean)
    .slice(0, 10);
  if (terms.length === 0) return [];

  const q = db('files').where({ user_id: userId, is_dir: false }).select('path', 'content');
  if (isMysql(db) && terms.every((t) => t.length >= MIN_FT_TOKEN)) {
    const boolean = terms.map((t) => `+${t}*`).join(' ');
    q.whereRaw('MATCH(path, content) AGAINST (? IN BOOLEAN MODE)', [boolean])
      .orderByRaw('MATCH(path, content) AGAINST (? IN BOOLEAN MODE) DESC', [boolean]);
  } else {
    for (const t of terms) {
      const like = `%${escapeLike(t)}%`;
      q.andWhere((w) => w.whereRaw("content LIKE ? ESCAPE '!'", [like]).orWhereRaw("path LIKE ? ESCAPE '!'", [like]));
    }
    q.orderBy('mtime_ms', 'desc');
  }
  const rows: Array<{ path: string; content: string | null }> = await q.limit(limit * 2);
  return rows
    .filter((r) => !isHidden(r.path))
    .slice(0, limit)
    .map((r) => ({ path: r.path, snippet: makeSnippet(r.content ?? '', terms) }));
}

export function makeSnippet(content: string, terms: string[], radius = 80): string {
  const lower = content.toLowerCase();
  let pos = -1;
  for (const t of terms) {
    pos = lower.indexOf(t.toLowerCase());
    if (pos !== -1) break;
  }
  if (pos === -1) return content.slice(0, radius * 2).replace(/\s+/g, ' ').trim();
  const start = Math.max(0, pos - radius);
  const end = Math.min(content.length, pos + radius);
  return `${start > 0 ? '…' : ''}${content.slice(start, end).replace(/\s+/g, ' ').trim()}${end < content.length ? '…' : ''}`;
}
