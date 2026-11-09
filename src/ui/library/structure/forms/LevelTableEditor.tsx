/**
 * A class's 20-row level table (spec §4.5): a real <table> on wide screens (every cell an input
 * labelled "Level 3, Cantrips", column headers set with a key Select), one card per level with a
 * "Level 3 ‹ ›" stepper on phones, plus the column list. Keys are builder.json's (§3.9.1).
 */
import { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useMediaQuery } from '@/ui/play/useMediaQuery';
import { IconButton, Input, Select } from '@/ui/components/ui';
import { useRecordForm } from './context';
import { FieldShell } from './controls';
import { getPath } from './paths';

type Row = Record<string, string | number>;

const KNOWN_KEYS: readonly { key: string; label: string }[] = [
  { key: 'proficiencyBonus', label: 'Proficiency bonus' },
  { key: 'features', label: 'Features' },
  { key: 'cantrips', label: 'Cantrips' },
  { key: 'preparedSpells', label: 'Prepared spells' },
  { key: 'spellsKnown', label: 'Spells known' },
  ...Array.from({ length: 9 }, (_, i) => ({ key: `slot${i + 1}`, label: `Slot ${i + 1}` })),
  { key: 'pactSlots', label: 'Pact slots' },
  { key: 'pactSlotLevel', label: 'Pact slot level' },
];
const KNOWN = new Map(KNOWN_KEYS.map((k) => [k.key, k.label]));

/** "rageDamage" → "Rage damage". */
export function columnLabel(key: string): string {
  return KNOWN.get(key) ?? key.replace(/([a-z])([A-Z0-9])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase()).replace(/ ([A-Z])/g, (_, c: string) => ` ${c.toLowerCase()}`);
}

/** "Wicks" → "wicks", "Rage Damage" → "rageDamage". */
function camelKey(label: string): string {
  const words = label.trim().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(Boolean);
  return words.map((w, i) => (i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())).join('');
}

function cellValue(text: string): string | number {
  const t = text.trim();
  return /^[+]?\d+$/.test(t) ? Number(t.replace('+', '')) : text;
}

/** Column keys in table order: every key any row has, the first row's order first, "level" left out. */
export function tableColumns(rows: readonly Row[]): string[] {
  const keys: string[] = [];
  for (const row of rows) for (const k of Object.keys(row)) if (k !== 'level' && !keys.includes(k)) keys.push(k);
  return keys;
}

function ColumnKey({ column, columns, onRename }: { column: string; columns: readonly string[]; onRename(next: string): void }) {
  const known = KNOWN.has(column);
  const [other, setOther] = useState(known ? '' : columnLabel(column));
  return (
    <div className="flex min-w-[7.5rem] flex-col gap-1">
      <Select
        aria-label={`Column ${columnLabel(column)}: what it holds`}
        value={known ? column : 'other'}
        className="h-8 text-xs"
        onChange={(e) => {
          const v = e.target.value;
          if (v === 'other') onRename(camelKey(other || 'other'));
          else if (!columns.includes(v) || v === column) onRename(v);
        }}
      >
        {KNOWN_KEYS.map((k) => (
          <option key={k.key} value={k.key} disabled={k.key !== column && columns.includes(k.key)}>
            {k.label}
          </option>
        ))}
        <option value="other">Other…</option>
      </Select>
      {!known && (
        <Input
          aria-label={`Name of column ${columnLabel(column)}`}
          value={other}
          className="h-8 text-xs"
          onChange={(e) => setOther(e.target.value)}
          onBlur={() => {
            const key = camelKey(other);
            if (key && key !== column && !columns.includes(key)) onRename(key);
          }}
        />
      )}
    </div>
  );
}

export function LevelTableEditor({ path, label }: { path: string; label: string }) {
  const form = useRecordForm();
  const wide = useMediaQuery('(min-width: 640px)', true);
  const raw = getPath(form.data, path);
  const rows = (Array.isArray(raw) ? raw : []) as Row[];
  const columns = tableColumns(rows);
  const [level, setLevel] = useState(1);

  const setCell = (rowIndex: number, key: string, text: string) =>
    form.set(path, rows.map((r, i) => (i === rowIndex ? { ...r, [key]: cellValue(text) } : r)));
  const rename = (from: string, to: string) => {
    if (!to || from === to) return;
    form.set(
      path,
      rows.map((r) => {
        const next: Row = {};
        for (const [k, v] of Object.entries(r)) next[k === from ? to : k] = v;
        return next;
      }),
    );
  };
  const cell = (rowIndex: number, key: string) => {
    const v = rows[rowIndex]?.[key];
    return v === undefined ? '' : String(v);
  };

  if (rows.length === 0) {
    return (
      <FieldShell path={path} label={label} as="legend">
        <p className="text-sm text-muted">No level table was read.</p>
      </FieldShell>
    );
  }

  if (wide) {
    return (
      <FieldShell path={path} label={label} as="legend" hint="Cells with only a number are stored as numbers; “—” and text stay as written.">
        <div className="max-h-[28rem] overflow-auto rounded-xl border border-border scroll-thin">
          <table className="w-max min-w-full border-collapse text-sm">
            <thead className="sticky top-0 z-10 bg-surface-2">
              <tr>
                <th scope="col" className="px-2 py-1.5 text-left text-xs font-medium text-muted">
                  Level
                </th>
                {columns.map((c) => (
                  <th key={c} scope="col" className="px-1.5 py-1.5 text-left align-top font-normal">
                    <span className="sr-only">{columnLabel(c)}</span>
                    <ColumnKey column={c} columns={columns} onRename={(to) => rename(c, to)} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i} className="border-t border-border">
                  <th scope="row" className="px-2 py-1 text-left text-xs font-medium tabular-nums">
                    {String(row.level ?? i + 1)}
                  </th>
                  {columns.map((c) => (
                    <td key={c} className="px-1.5 py-1">
                      <Input
                        aria-label={`Level ${row.level ?? i + 1}, ${columnLabel(c)}`}
                        value={cell(i, c)}
                        className={c === 'features' ? 'h-8 min-w-[12rem] text-xs' : 'h-8 w-16 text-xs tabular-nums'}
                        onFocus={() => form.onFocusField(path)}
                        onChange={(e) => setCell(i, c, e.target.value)}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </FieldShell>
    );
  }

  const index = Math.min(Math.max(level, 1), rows.length) - 1;
  return (
    <FieldShell path={path} label={label} as="legend">
      <div className="rounded-xl border border-border bg-surface p-3">
        <div className="mb-3 flex items-center gap-2">
          <Select aria-label="Level" value={String(index + 1)} onChange={(e) => setLevel(Number(e.target.value))} className="w-32">
            {rows.map((r, i) => (
              <option key={i} value={i + 1}>
                Level {String(r.level ?? i + 1)}
              </option>
            ))}
          </Select>
          <IconButton label="Previous level" disabled={index === 0} onClick={() => setLevel(index)}>
            <ChevronLeft className="size-4" aria-hidden />
          </IconButton>
          <IconButton label="Next level" disabled={index >= rows.length - 1} onClick={() => setLevel(index + 2)}>
            <ChevronRight className="size-4" aria-hidden />
          </IconButton>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {columns.map((c) => (
            <label key={c} className={c === 'features' ? 'col-span-2 flex flex-col gap-1 text-xs' : 'flex flex-col gap-1 text-xs'}>
              <span className="font-medium text-muted">{columnLabel(c)}</span>
              <Input
                aria-label={`Level ${rows[index].level ?? index + 1}, ${columnLabel(c)}`}
                value={cell(index, c)}
                inputMode={c === 'features' ? 'text' : 'numeric'}
                onFocus={() => form.onFocusField(path)}
                onChange={(e) => setCell(index, c, e.target.value)}
              />
            </label>
          ))}
        </div>
      </div>
      <details className="mt-2 rounded-xl border border-border bg-surface px-3 py-2 text-sm">
        <summary className="cursor-pointer font-medium">Columns</summary>
        <ul className="mt-2 flex flex-col gap-2">
          {columns.map((c) => (
            <li key={c} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-xs text-muted">{columnLabel(c)}</span>
              <ColumnKey column={c} columns={columns} onRename={(to) => rename(c, to)} />
            </li>
          ))}
        </ul>
      </details>
    </FieldShell>
  );
}
