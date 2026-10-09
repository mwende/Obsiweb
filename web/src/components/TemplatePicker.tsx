import { useMemo, useState } from 'react';

interface Props {
  templates: Array<{ path: string; name: string }>;
  folder: string | null;
  onPick: (path: string) => void;
  onClose: () => void;
}

/** Schnellauswahl für Vorlagen (Suchen, Pfeiltasten, Enter) */
export function TemplatePicker({ templates, folder, onPick, onClose }: Props) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const filtered = useMemo(() => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    return templates.filter((t) => terms.every((term) => t.name.toLowerCase().includes(term)));
  }, [q, templates]);
  const current = Math.min(sel, Math.max(0, filtered.length - 1));

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="card modal picker" role="dialog" aria-label="Vorlage einfügen">
        <input
          autoFocus
          placeholder={folder ? 'Vorlage suchen …' : 'Kein Vorlagenordner gefunden'}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setSel((s) => Math.min(s + 1, filtered.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setSel((s) => Math.max(s - 1, 0));
            } else if (e.key === 'Enter' && filtered[current]) {
              e.preventDefault();
              onPick(filtered[current].path);
            }
          }}
        />
        <ul className="picker-list">
          {filtered.map((t, i) => (
            <li key={t.path}>
              <button className={i === current ? 'on' : ''} onMouseEnter={() => setSel(i)} onClick={() => onPick(t.path)}>
                {t.name}
              </button>
            </li>
          ))}
          {filtered.length === 0 && (
            <li className="muted pad small">
              {!folder
                ? 'Lege im Vault einen Ordner „Vorlagen“ oder „Templates“ an oder wähle unter Einstellungen einen Ordner.'
                : templates.length === 0
                  ? `Der Ordner „${folder}“ enthält noch keine Vorlagen.`
                  : 'Keine passende Vorlage.'}
            </li>
          )}
        </ul>
        <div className="muted small picker-foot">
          {folder ? <>Ordner: <code>{folder}</code></> : 'Kein Vorlagenordner'} · ↑↓ auswählen · Enter einfügen · Esc schließen
        </div>
      </div>
    </div>
  );
}
