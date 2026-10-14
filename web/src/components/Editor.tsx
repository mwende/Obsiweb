import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { Decoration, EditorView, keymap, MatchDecorator, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import CodeMirror from '@uiw/react-codemirror';
import { useEffect, useMemo, useRef } from 'react';
import { findLinkAt, isSafeWebUrl, LINK_HIGHLIGHT_RE, MOD_KEY_LABEL } from '../textLinks';

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSave: () => void;
  /** Lädt Dateien hoch und liefert den einzufügenden Markdown-Text */
  onFiles: (files: File[]) => Promise<string>;
  /** Öffnet die Vorlagenauswahl (Cmd/Strg+Alt+T) */
  onTemplate: () => void;
  /** Cmd/Strg+Klick auf [[Wikilink]] */
  onWikilink: (target: string) => void;
  /** Liefert die EditorView, z.B. zum Einfügen an der Cursorposition */
  onView: (view: EditorView | null) => void;
  dark: boolean;
}

/** URLs im Editor unterstreichen; Cmd/Strg+Klick öffnet sie */
const urlMark = Decoration.mark({ class: 'cm-url', attributes: { title: `${MOD_KEY_LABEL} + Klick öffnet den Link` } });
const urlMatcher = new MatchDecorator({ regexp: new RegExp(LINK_HIGHLIGHT_RE.source, 'gi'), decoration: () => urlMark });
const urlHighlighter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = urlMatcher.createDeco(view);
    }
    update(u: ViewUpdate) {
      this.decorations = urlMatcher.updateDeco(u, this.decorations);
    }
  },
  { decorations: (v) => v.decorations },
);

const isMod = (e: MouseEvent | KeyboardEvent) => e.metaKey || e.ctrlKey;

export function Editor({ value, onChange, onSave, onFiles, onTemplate, onWikilink, onView, dark }: Props) {
  // Aktuelle Callbacks in Refs, damit die Editor-Konfiguration stabil bleibt
  const cb = useRef({ onSave, onFiles, onTemplate, onWikilink });
  cb.current = { onSave, onFiles, onTemplate, onWikilink };

  const extensions = useMemo(
    () => [
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      EditorView.lineWrapping,
      urlHighlighter,
      keymap.of([
        { key: 'Mod-s', preventDefault: true, run: () => (cb.current.onSave(), true) },
        { key: 'Mod-Alt-t', preventDefault: true, run: () => (cb.current.onTemplate(), true) },
      ]),
      EditorView.domEventHandlers({
        mousedown(e, view) {
          if (e.button !== 0 || !isMod(e)) return false;
          const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
          if (pos === null) return false;
          const line = view.state.doc.lineAt(pos);
          const link = findLinkAt(line.text, pos - line.from);
          if (!link) return false;
          e.preventDefault();
          if (link.kind === 'url') {
            if (!isSafeWebUrl(link.href)) return true;
            if (link.href.startsWith('mailto:')) window.location.href = link.href;
            else window.open(link.href, '_blank', 'noopener,noreferrer');
          } else {
            cb.current.onWikilink(link.target);
          }
          return true;
        },
        // Mauszeiger als Hand anzeigen, solange Cmd/Strg gedrückt ist
        keydown(e, view) {
          if (e.key === 'Meta' || e.key === 'Control') view.dom.classList.add('cm-mod-held');
          return false;
        },
        keyup(e, view) {
          if (e.key === 'Meta' || e.key === 'Control') view.dom.classList.remove('cm-mod-held');
          return false;
        },
        blur(_e, view) {
          view.dom.classList.remove('cm-mod-held');
          return false;
        },
        paste(e, view) {
          const files = [...(e.clipboardData?.files ?? [])];
          if (!files.length) return false;
          e.preventDefault();
          void cb.current.onFiles(files).then((text) => view.dispatch(view.state.replaceSelection(text)));
          return true;
        },
        drop(e, view) {
          const files = [...(e.dataTransfer?.files ?? [])];
          if (!files.length) return false;
          e.preventDefault();
          const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? view.state.selection.main.head;
          void cb.current.onFiles(files).then((text) => view.dispatch({ changes: { from: pos, insert: text } }));
          return true;
        },
      }),
    ],
    [],
  );

  useEffect(() => () => onView(null), [onView]);

  return (
    <CodeMirror
      className="editor"
      value={value}
      onChange={onChange}
      extensions={extensions}
      theme={dark ? 'dark' : 'light'}
      basicSetup={{ foldGutter: false, lineNumbers: false, highlightActiveLine: false, highlightActiveLineGutter: false }}
      height="100%"
      onCreateEditor={(view) => onView(view)}
    />
  );
}
