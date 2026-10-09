import { useMemo, useState } from 'react';
import type { TreeEntry } from '../api';
import { baseOf, isImage, isNote, stripMd } from '../links';

export interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children: TreeNode[];
}

export function buildTree(entries: TreeEntry[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', isDir: true, children: [] };
  const dirs = new Map<string, TreeNode>([['', root]]);
  const ensureDir = (p: string): TreeNode => {
    const existing = dirs.get(p);
    if (existing) return existing;
    const parent = ensureDir(p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
    const node: TreeNode = { name: baseOf(p), path: p, isDir: true, children: [] };
    parent.children.push(node);
    dirs.set(p, node);
    return node;
  };
  for (const e of entries) {
    if (e.isDir) ensureDir(e.path);
    else {
      const parent = ensureDir(e.path.includes('/') ? e.path.slice(0, e.path.lastIndexOf('/')) : '');
      parent.children.push({ name: baseOf(e.path), path: e.path, isDir: false, children: [] });
    }
  }
  const coll = new Intl.Collator('de', { numeric: true, sensitivity: 'base' });
  const sort = (n: TreeNode) => {
    n.children.sort((a, b) => Number(b.isDir) - Number(a.isDir) || coll.compare(a.name, b.name));
    n.children.forEach(sort);
  };
  sort(root);
  return root.children;
}

const STORAGE_KEY = 'ow.expanded';
function loadExpanded(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]'));
  } catch {
    return new Set();
  }
}

export interface TreeActions {
  open: (path: string) => void;
  newNote: (dir: string) => void;
  newFolder: (dir: string) => void;
  rename: (path: string) => void;
  remove: (path: string, isDir: boolean) => void;
  move: (from: string, toDir: string) => void;
}

export function FileTree({ entries, active, actions }: { entries: TreeEntry[]; active: string | null; actions: TreeActions }) {
  const tree = useMemo(() => buildTree(entries), [entries]);
  const [expanded, setExpanded] = useState(loadExpanded);
  const [menu, setMenu] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  // Ordner der aktiven Notiz automatisch aufklappen
  const activeDirs = useMemo(() => {
    const s = new Set<string>();
    if (active) {
      const parts = active.split('/');
      for (let i = 1; i < parts.length; i++) s.add(parts.slice(0, i).join('/'));
    }
    return s;
  }, [active]);

  const toggle = (p: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
      } catch {
        /* privates Fenster */
      }
      return next;
    });
  };

  const dropProps = (dir: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes('application/x-ow-path')) return;
      e.preventDefault();
      e.stopPropagation();
      setDropTarget(dir);
    },
    onDragLeave: () => setDropTarget((t) => (t === dir ? null : t)),
    onDrop: (e: React.DragEvent) => {
      const from = e.dataTransfer.getData('application/x-ow-path');
      setDropTarget(null);
      if (!from) return;
      e.preventDefault();
      e.stopPropagation();
      actions.move(from, dir);
    },
  });

  const render = (nodes: TreeNode[], depth: number) =>
    nodes.map((n) => {
      const isOpen = n.isDir && (expanded.has(n.path) || activeDirs.has(n.path));
      const label = isNote(n.name) ? stripMd(n.name) : n.name;
      return (
        <li key={n.path}>
          <div
            className={`tree-row${active === n.path ? ' active' : ''}${dropTarget === n.path ? ' drop' : ''}`}
            style={{ paddingLeft: 8 + depth * 14 }}
            onClick={() => (n.isDir ? toggle(n.path) : actions.open(n.path))}
            draggable
            onDragStart={(e) => e.dataTransfer.setData('application/x-ow-path', n.path)}
            {...(n.isDir ? dropProps(n.path) : {})}
            title={n.path}
          >
            <span className="tree-icon" aria-hidden>
              {n.isDir ? (isOpen ? '▾' : '▸') : isNote(n.name) ? '' : isImage(n.name) ? '🖼' : '📎'}
            </span>
            <span className={`tree-label${!n.isDir && !isNote(n.name) ? ' muted' : ''}`}>{label}</span>
            <button
              className="ghost tree-more"
              aria-label="Aktionen"
              onClick={(e) => {
                e.stopPropagation();
                setMenu(menu === n.path ? null : n.path);
              }}
            >
              ⋯
            </button>
            {menu === n.path && (
              <div className="menu-pop tree-menu" onClick={(e) => (e.stopPropagation(), setMenu(null))} onMouseLeave={() => setMenu(null)}>
                {n.isDir && <button onClick={() => actions.newNote(n.path)}>Neue Notiz hier</button>}
                {n.isDir && <button onClick={() => actions.newFolder(n.path)}>Neuer Ordner hier</button>}
                <button onClick={() => actions.rename(n.path)}>Umbenennen / Verschieben</button>
                <button className="danger-text" onClick={() => actions.remove(n.path, n.isDir)}>
                  Löschen
                </button>
              </div>
            )}
          </div>
          {isOpen && n.children.length > 0 && <ul>{render(n.children, depth + 1)}</ul>}
        </li>
      );
    });

  return (
    <nav className={`tree${dropTarget === '' ? ' drop' : ''}`} {...dropProps('')}>
      {tree.length === 0 ? <p className="muted pad">Noch keine Notizen.</p> : <ul>{render(tree, 0)}</ul>}
    </nav>
  );
}
