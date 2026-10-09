import { describe, expect, it } from 'vitest';
import type { TreeEntry } from '../src/api';
import { applyTemplate, formatDate, listTemplates, vaultRootOf } from '../src/templates';

const d = new Date(2026, 9, 9, 7, 5, 3); // Fr, 9. Oktober 2026, 07:05:03

describe('formatDate', () => {
  it('unterstützt die gängigen moment-Tokens', () => {
    expect(formatDate(d, 'YYYY-MM-DD')).toBe('2026-10-09');
    expect(formatDate(d, 'DD.MM.YY HH:mm:ss')).toBe('09.10.26 07:05:03');
    expect(formatDate(d, 'dddd, D. MMMM YYYY')).toBe('Freitag, 9. Oktober 2026');
    expect(formatDate(d, '[KW] ww')).toBe('KW 41');
  });
});

describe('applyTemplate', () => {
  it('ersetzt title, date, time und Formate', () => {
    const tpl = '# {{title}}\nErstellt: {{date}} {{time}}\n{{date:DD.MM.YYYY}} / {{ TIME:HH }}\n```powershell\n$x = "{{title}}"\n```';
    expect(applyTemplate(tpl, { title: 'Server-Check', now: d, dateFormat: 'YYYY-MM-DD', timeFormat: 'HH:mm' })).toBe(
      '# Server-Check\nErstellt: 2026-10-09 07:05\n09.10.2026 / 07\n```powershell\n$x = "Server-Check"\n```',
    );
  });
  it('lässt unbekannte Platzhalter stehen', () => {
    expect(applyTemplate('{{foo}} {{date:YYYY}}', { title: 't', now: d, dateFormat: '', timeFormat: '' })).toBe('{{foo}} 2026');
  });
});

describe('Vorlagenliste', () => {
  it('listet .md-Dateien im Ordner rekursiv, sortiert', () => {
    const e = (path: string, isDir = false): TreeEntry => ({ path, isDir, size: 0, mtimeMs: 0 });
    const entries = [e('V/Vorlagen', true), e('V/Vorlagen/PS/Skript 10.md'), e('V/Vorlagen/PS/Skript 2.md'), e('V/Vorlagen/bild.png'), e('V/Andere.md')];
    expect(listTemplates(entries, 'V/Vorlagen').map((t) => t.name)).toEqual(['PS/Skript 2', 'PS/Skript 10']);
    expect(vaultRootOf('Notizen/Kunden/x.md')).toBe('Notizen');
    expect(vaultRootOf('x.md')).toBe('');
  });
});
