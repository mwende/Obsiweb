import { useMemo } from 'react';
import type { LinkResolver } from '../links';
import { renderMarkdown } from '../markdown';

export function Preview({
  source,
  from,
  resolver,
  onOpenNote,
}: {
  source: string;
  from: string;
  resolver: LinkResolver;
  onOpenNote: (target: string, resolved: boolean) => void;
}) {
  const html = useMemo(() => renderMarkdown(source, { resolver, from }), [source, from, resolver]);
  return (
    <article
      className="preview markdown"
      onClick={(e) => {
        const a = (e.target as HTMLElement).closest('a.wikilink') as HTMLAnchorElement | null;
        if (!a) return;
        e.preventDefault();
        onOpenNote(a.dataset.note!, !a.classList.contains('unresolved'));
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
