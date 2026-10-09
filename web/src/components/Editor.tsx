import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { EditorView, keymap } from '@codemirror/view';
import CodeMirror from '@uiw/react-codemirror';
import { useEffect, useMemo } from 'react';

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSave: () => void;
  /** Lädt Dateien hoch und liefert den einzufügenden Markdown-Text */
  onFiles: (files: File[]) => Promise<string>;
  /** Öffnet die Vorlagenauswahl (Cmd/Strg+Alt+T) */
  onTemplate: () => void;
  /** Liefert die EditorView, z.B. zum Einfügen an der Cursorposition */
  onView: (view: EditorView | null) => void;
  dark: boolean;
}

export function Editor({ value, onChange, onSave, onFiles, onTemplate, onView, dark }: Props) {
  const extensions = useMemo(
    () => [
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      EditorView.lineWrapping,
      keymap.of([
        { key: 'Mod-s', preventDefault: true, run: () => (onSave(), true) },
        { key: 'Mod-Alt-t', preventDefault: true, run: () => (onTemplate(), true) },
      ]),
      EditorView.domEventHandlers({
        paste(e, view) {
          const files = [...(e.clipboardData?.files ?? [])];
          if (!files.length) return false;
          e.preventDefault();
          void onFiles(files).then((text) => view.dispatch(view.state.replaceSelection(text)));
          return true;
        },
        drop(e, view) {
          const files = [...(e.dataTransfer?.files ?? [])];
          if (!files.length) return false;
          e.preventDefault();
          const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? view.state.selection.main.head;
          void onFiles(files).then((text) => view.dispatch({ changes: { from: pos, insert: text } }));
          return true;
        },
      }),
    ],
    [onSave, onFiles, onTemplate],
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
