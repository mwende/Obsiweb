import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, type Me, type TreeEntry } from '../api';
import { useDialog } from '../components/Dialog';
import { Editor } from '../components/Editor';
import { FileTree, type TreeActions } from '../components/FileTree';
import { Preview } from '../components/Preview';
import { TopBar } from '../components/TopBar';
import { baseOf, dirOf, isImage, isNote, joinPath, LinkResolver, stripMd } from '../links';
import { navigate, noteUrl, useLocation } from '../router';

type Mode = 'edit' | 'split' | 'preview';
type Status = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict';

const STATUS_LABEL: Record<Status, string> = {
  saved: 'Gespeichert',
  dirty: 'Ungespeichert …',
  saving: 'Speichere …',
  error: 'Speichern fehlgeschlagen',
  conflict: 'Konflikt',
};
const AUTOSAVE_MS = 1000;
const REFRESH_MS = 30_000;

function useMediaQuery(q: string) {
  const [m, setM] = useState(() => matchMedia(q).matches);
  useEffect(() => {
    const mq = matchMedia(q);
    const on = () => setM(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [q]);
  return m;
}

function errorText(e: unknown) {
  return e instanceof ApiError ? e.message : 'Unbekannter Fehler';
}

export function Workspace({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const loc = useLocation();
  const notePath = new URLSearchParams(loc.search).get('note');
  const dark = useMediaQuery('(prefers-color-scheme: dark)');
  const narrow = useMediaQuery('(max-width: 800px)');
  const dialog = useDialog();

  const [entries, setEntries] = useState<TreeEntry[]>([]);
  const [text, setText] = useState('');
  const [loaded, setLoaded] = useState<string | null>(null); // Pfad der geladenen Notiz
  const [loadError, setLoadError] = useState('');
  const [status, setStatus] = useState<Status>('saved');
  const [mode, setMode] = useState<Mode>(() => (localStorage.getItem('ow.mode') as Mode) || 'split');
  const [sidebar, setSidebar] = useState(!narrow);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Array<{ path: string; snippet: string }> | null>(null);
  const [toast, setToast] = useState('');

  // Refs für asynchrone Speicherlogik (unabhängig von Render-Zyklen)
  const pathRef = useRef<string | null>(null);
  const contentRef = useRef('');
  const etagRef = useRef<string | undefined>(undefined);
  const dirtyRef = useRef(false);
  const savingRef = useRef<Promise<boolean> | null>(null);
  const timerRef = useRef<number | undefined>(undefined);

  const resolver = useMemo(() => new LinkResolver(entries.filter((e) => !e.isDir).map((e) => e.path)), [entries]);
  const effectiveMode: Mode = narrow && mode === 'split' ? 'edit' : mode;

  const notify = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? '' : t)), 4000);
  }, []);

  const refreshTree = useCallback(async () => {
    try {
      setEntries((await api.tree()).entries);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) location.reload();
    }
  }, []);

  // ------------------------------------------------------------ Speichern

  const resolveConflictRef = useRef<(path: string) => Promise<void>>(async () => {});

  const save = useCallback(async (): Promise<boolean> => {
    window.clearTimeout(timerRef.current);
    if (savingRef.current) await savingRef.current;
    const path = pathRef.current;
    if (!dirtyRef.current || !path) return true;
    const content = contentRef.current;
    setStatus('saving');
    const run = (async () => {
      try {
        const r = await api.save(path, content, etagRef.current);
        if (pathRef.current === path) {
          etagRef.current = r.etag;
          if (contentRef.current === content) {
            dirtyRef.current = false;
            setStatus('saved');
          } else setStatus('dirty');
        }
        return true;
      } catch (e) {
        if (e instanceof ApiError && e.body?.code === 'PRECONDITION') {
          setStatus('conflict');
          void resolveConflictRef.current(path);
        } else {
          setStatus('error');
          notify(errorText(e));
        }
        return false;
      }
    })();
    savingRef.current = run;
    const ok = await run;
    savingRef.current = null;
    if (ok && dirtyRef.current && pathRef.current === path) scheduleSave();
    return ok;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notify]);

  const scheduleSave = useCallback(() => {
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => void save(), AUTOSAVE_MS);
  }, [save]);

  const load = useCallback(
    async (path: string | null) => {
      await save();
      pathRef.current = path;
      dirtyRef.current = false;
      setLoadError('');
      setStatus('saved');
      if (!path || !isNote(path)) {
        setLoaded(path);
        return;
      }
      try {
        const f = await api.read(path);
        if (pathRef.current !== path) return;
        contentRef.current = f.content;
        etagRef.current = f.etag;
        setText(f.content);
        setLoaded(path);
      } catch (e) {
        if (pathRef.current !== path) return;
        setLoaded(null);
        setLoadError(e instanceof ApiError && e.status === 404 ? `„${path}“ existiert nicht (mehr).` : errorText(e));
      }
    },
    [save],
  );

  resolveConflictRef.current = async (path: string) => {
    const deleted = await api.read(path).then(
      () => false,
      (e) => e instanceof ApiError && e.status === 404,
    );
    const choice = await dialog.choose(
      'Konflikt beim Speichern',
      deleted
        ? 'Die Notiz wurde zwischenzeitlich gelöscht (z.B. über Obsidian).'
        : 'Die Notiz wurde zwischenzeitlich an anderer Stelle geändert (z.B. über Obsidian-Sync).',
      [
        { label: deleted ? 'Verwerfen' : 'Server-Version laden', value: 'server' },
        { label: 'Als Kopie speichern', value: 'copy' },
        { label: deleted ? 'Wiederherstellen' : 'Meine Version behalten', value: 'mine' },
      ],
    );
    if (pathRef.current !== path || !choice) return;
    const content = contentRef.current;
    try {
      if (choice === 'mine') {
        const r = await api.save(path, content, undefined, true);
        etagRef.current = r.etag;
        dirtyRef.current = contentRef.current !== content;
        setStatus(dirtyRef.current ? 'dirty' : 'saved');
        return;
      }
      if (choice === 'copy') {
        const d = new Date();
        const pad = (n: number) => String(n).padStart(2, '0');
        const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;
        const copy = `${stripMd(path)} (Konflikt ${stamp}).md`;
        await api.save(copy, content);
        notify(`Kopie gespeichert: ${baseOf(copy)}`);
      }
      dirtyRef.current = false;
      await refreshTree();
      if (deleted) navigate('/', true);
      else await load(path);
    } catch (e) {
      setStatus('error');
      notify(errorText(e));
    }
  };

  // ------------------------------------------------------------ Effekte

  useEffect(() => {
    void refreshTree();
  }, [refreshTree]);

  useEffect(() => {
    void load(notePath);
    if (narrow) setSidebar(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notePath]);

  // Änderungen von außen (Obsidian-Sync) übernehmen, solange lokal nichts ungespeichert ist
  useEffect(() => {
    const refresh = async () => {
      if (document.hidden) return;
      await refreshTree();
      const p = pathRef.current;
      if (!p || !isNote(p) || dirtyRef.current || savingRef.current) return;
      try {
        const f = await api.read(p);
        if (pathRef.current === p && !dirtyRef.current && f.etag !== etagRef.current) {
          etagRef.current = f.etag;
          contentRef.current = f.content;
          setText(f.content);
        }
      } catch {
        /* wird beim nächsten Speichern behandelt */
      }
    };
    window.addEventListener('focus', refresh);
    const iv = window.setInterval(refresh, REFRESH_MS);
    return () => {
      window.removeEventListener('focus', refresh);
      window.clearInterval(iv);
    };
  }, [refreshTree]);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) {
        void save();
        e.preventDefault();
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [save]);

  useEffect(() => {
    if (!query.trim()) {
      setHits(null);
      return;
    }
    const t = window.setTimeout(async () => {
      try {
        setHits((await api.search(query)).hits);
      } catch (e) {
        notify(errorText(e));
      }
    }, 250);
    return () => window.clearTimeout(t);
  }, [query, notify]);

  // ------------------------------------------------------------ Aktionen

  const onChange = useCallback(
    (v: string) => {
      contentRef.current = v;
      setText(v);
      dirtyRef.current = true;
      setStatus('dirty');
      scheduleSave();
    },
    [scheduleSave],
  );

  const onSaveNow = useCallback(() => void save(), [save]);

  const onFiles = useCallback(
    async (files: File[]) => {
      const dir = pathRef.current ? joinPath(dirOf(pathRef.current), me.attachmentsDir) : undefined;
      const parts: string[] = [];
      for (const f of files) {
        try {
          const r = await api.upload(f, dir);
          parts.push(isImage(r.name) ? `![[${r.name}]]` : `[[${r.name}]]`);
        } catch (e) {
          notify(`${f.name}: ${errorText(e)}`);
        }
      }
      void refreshTree();
      return parts.join('\n');
    },
    [me.attachmentsDir, notify, refreshTree],
  );

  const createNote = async (dir: string, suggested = 'Unbenannt') => {
    const name = await dialog.prompt('Neue Notiz', suggested, 'Anlegen');
    if (!name?.trim()) return;
    const path = joinPath(dir, /\.\w+$/.test(name) ? name.trim() : `${name.trim()}.md`);
    try {
      await api.save(path, '');
      await refreshTree();
      navigate(noteUrl(path));
    } catch (e) {
      notify(e instanceof ApiError && e.status === 412 ? 'Eine Datei mit diesem Namen existiert bereits.' : errorText(e));
    }
  };

  const renameTo = async (from: string, to: string) => {
    if (!to || to === from) return;
    await save();
    try {
      const { path } = await api.move(from, to);
      await refreshTree();
      const cur = pathRef.current;
      if (cur && (cur === from || cur.startsWith(`${from}/`))) {
        pathRef.current = path + cur.slice(from.length);
        navigate(noteUrl(pathRef.current), true);
      }
    } catch (e) {
      notify(e instanceof ApiError && e.status === 412 ? 'Ziel existiert bereits.' : errorText(e));
    }
  };

  const actions: TreeActions = {
    open: (p) => navigate(noteUrl(p)),
    newNote: (dir) => void createNote(dir),
    newFolder: async (dir) => {
      const name = await dialog.prompt('Neuer Ordner', '', 'Anlegen');
      if (!name?.trim()) return;
      try {
        await api.mkdir(joinPath(dir, name.trim()));
        await refreshTree();
      } catch (e) {
        notify(errorText(e));
      }
    },
    rename: async (p) => {
      const to = await dialog.prompt('Umbenennen / Verschieben', p, 'Übernehmen');
      if (to) await renameTo(p, joinPath(to));
    },
    remove: async (p, isDir) => {
      const ok = await dialog.confirm(
        isDir ? 'Ordner löschen?' : 'Datei löschen?',
        <>
          <code>{p}</code> wird {isDir ? 'mitsamt Inhalt ' : ''}gelöscht. Beim nächsten Sync wird die Löschung auch in Obsidian übernommen.
        </>,
      );
      if (!ok) return;
      try {
        await api.remove(p);
        const cur = pathRef.current;
        if (cur && (cur === p || cur.startsWith(`${p}/`))) {
          dirtyRef.current = false;
          navigate('/', true);
        }
        await refreshTree();
      } catch (e) {
        notify(errorText(e));
      }
    },
    move: (from, toDir) => {
      if (dirOf(from) === toDir || toDir === from || toDir.startsWith(`${from}/`)) return;
      void renameTo(from, joinPath(toDir, baseOf(from)));
    },
  };

  const openLink = async (target: string, resolved: boolean) => {
    if (resolved) return navigate(noteUrl(target));
    void createNote(dirOf(pathRef.current ?? ''), stripMd(target));
  };

  const uploadInput = useRef<HTMLInputElement>(null);
  const setModePersist = (m: Mode) => {
    setMode(m);
    try {
      localStorage.setItem('ow.mode', m);
    } catch {
      /* ignorieren */
    }
  };

  // ------------------------------------------------------------ Render

  const current = loaded;
  const showEditor = current && isNote(current);

  return (
    <div className={`app${sidebar ? ' with-sidebar' : ''}`}>
      <TopBar
        me={me}
        onLogout={onLogout}
        left={
          <button className="ghost icon" onClick={() => setSidebar((s) => !s)} aria-label="Seitenleiste umschalten">
            ☰
          </button>
        }
      >
        {current && (
          <div className="note-head">
            <span className="crumb muted hide-sm">{dirOf(current) && `${dirOf(current)} /`}</span>
            {showEditor ? (
              <TitleInput key={current} path={current} onRename={(to) => void renameTo(current, to)} />
            ) : (
              <strong>{baseOf(current)}</strong>
            )}
            {showEditor && <span className={`status status-${status}`}>{STATUS_LABEL[status]}</span>}
          </div>
        )}
        {showEditor && (
          <div className="segmented" role="group" aria-label="Ansicht">
            {(narrow ? (['edit', 'preview'] as Mode[]) : (['edit', 'split', 'preview'] as Mode[])).map((m) => (
              <button key={m} className={effectiveMode === m ? 'on' : ''} onClick={() => setModePersist(m)}>
                {m === 'edit' ? 'Bearbeiten' : m === 'split' ? 'Geteilt' : 'Lesen'}
              </button>
            ))}
          </div>
        )}
      </TopBar>

      <aside className="sidebar">
        <div className="sidebar-search">
          <input
            type="search"
            placeholder="Suchen …"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
          />
        </div>
        <div className="sidebar-actions">
          <button className="ghost" onClick={() => void createNote('')} title="Neue Notiz">
            ＋ Notiz
          </button>
          <button className="ghost" onClick={() => actions.newFolder('')} title="Neuer Ordner">
            ＋ Ordner
          </button>
          <button className="ghost" onClick={() => uploadInput.current?.click()} title="Datei hochladen">
            ⇪ Hochladen
          </button>
          <input
            ref={uploadInput}
            type="file"
            multiple
            hidden
            onChange={async (e) => {
              const files = [...(e.target.files ?? [])];
              e.target.value = '';
              if (!files.length) return;
              const text = await onFiles(files);
              if (text) notify(`Hochgeladen: ${files.map((f) => f.name).join(', ')}`);
            }}
          />
        </div>
        {hits ? (
          <ul className="hits">
            {hits.length === 0 && <li className="muted pad">Keine Treffer.</li>}
            {hits.map((h) => (
              <li key={h.path}>
                <button className={`hit${h.path === current ? ' active' : ''}`} onClick={() => navigate(noteUrl(h.path))}>
                  <strong>{stripMd(baseOf(h.path))}</strong>
                  <span className="muted small">{dirOf(h.path)}</span>
                  <span className="snippet">{h.snippet}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <FileTree entries={entries} active={current} actions={actions} />
        )}
      </aside>
      {narrow && sidebar && <div className="scrim" onClick={() => setSidebar(false)} />}

      <main className="main">
        {loadError ? (
          <div className="empty">
            <p>{loadError}</p>
            <button onClick={() => navigate('/')}>Zur Übersicht</button>
          </div>
        ) : !current ? (
          <div className="empty">
            <h2>Willkommen, {me.user.displayName}</h2>
            <p className="muted">Wähle links eine Notiz oder lege eine neue an.</p>
            <button className="primary" onClick={() => void createNote('')}>
              Neue Notiz
            </button>
          </div>
        ) : showEditor ? (
          <div className={`panes mode-${effectiveMode}`}>
            {effectiveMode !== 'preview' && (
              <div className="pane pane-editor">
                <Editor value={text} onChange={onChange} onSave={onSaveNow} onFiles={onFiles} dark={dark} />
              </div>
            )}
            {effectiveMode !== 'edit' && (
              <div className="pane pane-preview">
                <Preview source={text} from={current} resolver={resolver} onOpenNote={openLink} />
              </div>
            )}
          </div>
        ) : (
          <div className="viewer">
            {isImage(current) ? (
              <img src={api.rawUrl(current)} alt={baseOf(current)} />
            ) : (
              <p>
                <a className="button" href={api.rawUrl(current)} target="_blank" rel="noopener">
                  {baseOf(current)} öffnen
                </a>
              </p>
            )}
          </div>
        )}
      </main>
      {toast && <div className="toast">{toast}</div>}
      {dialog.element}
    </div>
  );
}

function TitleInput({ path, onRename }: { path: string; onRename: (to: string) => void }) {
  const initial = stripMd(baseOf(path));
  const [v, setV] = useState(initial);
  const commit = () => {
    const name = v.trim().replace(/[\\/]/g, '-');
    if (!name || name === initial) return setV(initial);
    onRename(joinPath(dirOf(path), `${name}.md`));
  };
  return (
    <input
      className="title-input"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          setV(initial);
          setTimeout(() => (e.target as HTMLInputElement).blur());
        }
      }}
      aria-label="Titel"
      size={Math.max(8, v.length + 1)}
    />
  );
}
