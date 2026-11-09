/**
 * Equipment packages ("Choose A or B"): a label, items with quantities and gold (spec §4.5). Each item
 * says whether the builder's gear list has it: ✓ "in the gear list" (the builder gives the real item)
 * or ⚠ "not in the gear list: added as plain gear".
 */
import { CircleCheck, Plus, Trash2, TriangleAlert } from 'lucide-react';
import { findEquipment } from '@/data';
import type { EquipmentPackage } from '@/types';
import { Button, IconButton, Input } from '@/ui/components/ui';
import { fieldId, useRecordForm } from './context';
import { FieldShell, issueAt } from './controls';
import { getPath } from './paths';

const nextLabel = (n: number) => `Option ${String.fromCharCode(65 + Math.min(n, 25))}`;

function ItemMatch({ name }: { name: string }) {
  const { builder, sourceId } = useRecordForm();
  if (!name.trim()) return null;
  const match = builder ? findEquipment(name, builder.equipment, sourceId) : null;
  return match ? (
    <span className="inline-flex items-center gap-1 text-xs text-success">
      <CircleCheck className="size-3.5" aria-hidden />
      In the gear list{match.option.name !== name ? ` (${match.option.name})` : ''}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-xs text-gold">
      <TriangleAlert className="size-3.5" aria-hidden />
      Not in the gear list: added as plain gear
    </span>
  );
}

export function PackageEditor({ path, label }: { path: string; label: string }) {
  const form = useRecordForm();
  const raw = getPath(form.data, path);
  const packages = (Array.isArray(raw) ? raw : []) as EquipmentPackage[];
  const write = (next: EquipmentPackage[]) => form.set(path, next);
  const update = (i: number, patch: Partial<EquipmentPackage>) => write(packages.map((p, j) => (j === i ? { ...p, ...patch } : p)));

  return (
    <FieldShell path={path} label={label} as="legend">
      {packages.length === 0 && <p className="text-sm text-muted">No equipment choices.</p>}
      <ol className="flex flex-col gap-3">
        {packages.map((pkg, i) => {
          const base = `${path}.${i}`;
          return (
            <li key={i} className="rounded-xl border border-border bg-surface p-3">
              <div className="mb-2 flex items-end gap-2">
                <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs font-medium">
                  Choice
                  <Input
                    id={fieldId(`${base}.label`)}
                    data-field-path={`${base}.label`}
                    value={pkg.label}
                    onFocus={() => form.onFocusField(path)}
                    onChange={(e) => update(i, { label: e.target.value })}
                  />
                </label>
                <label className="flex w-24 flex-col gap-1 text-xs font-medium">
                  Gold (GP)
                  <Input
                    inputMode="numeric"
                    data-field-path={`${base}.gp`}
                    value={String(pkg.gp)}
                    onFocus={() => form.onFocusField(path)}
                    onChange={(e) => update(i, { gp: Number(e.target.value) || 0 })}
                  />
                </label>
                <IconButton label={`Remove ${pkg.label || 'this choice'}`} size="sm" onClick={() => write(packages.filter((_, j) => j !== i))}>
                  <Trash2 className="size-4" aria-hidden />
                </IconButton>
              </div>
              <ul className="flex flex-col gap-2">
                {pkg.items.map((item, k) => (
                  <li key={k} className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <Input
                        aria-label={`${pkg.label}: item ${k + 1}`}
                        data-field-path={`${base}.items.${k}.name`}
                        value={item.name}
                        className="min-w-0 flex-1"
                        onFocus={() => form.onFocusField(path)}
                        onChange={(e) =>
                          update(i, { items: pkg.items.map((it, n) => (n === k ? { ...it, name: e.target.value } : it)) })
                        }
                      />
                      <Input
                        aria-label={`${pkg.label}: how many ${item.name || `of item ${k + 1}`}`}
                        inputMode="numeric"
                        value={String(item.quantity)}
                        className="w-16 tabular-nums"
                        onChange={(e) =>
                          update(i, {
                            items: pkg.items.map((it, n) => (n === k ? { ...it, quantity: Math.max(1, Number(e.target.value) || 1) } : it)),
                          })
                        }
                      />
                      <IconButton
                        label={`Remove ${item.name || `item ${k + 1}`}`}
                        size="sm"
                        onClick={() => update(i, { items: pkg.items.filter((_, n) => n !== k) })}
                      >
                        <Trash2 className="size-4" aria-hidden />
                      </IconButton>
                    </div>
                    <ItemMatch name={item.name} />
                    {issueAt(form.issues, `${base}.items.${k}`) && (
                      <p className="text-xs text-danger">{issueAt(form.issues, `${base}.items.${k}`)}</p>
                    )}
                  </li>
                ))}
              </ul>
              <Button
                size="sm"
                variant="ghost"
                className="mt-2"
                icon={<Plus className="size-4" aria-hidden />}
                onClick={() => update(i, { items: [...pkg.items, { name: '', quantity: 1 }] })}
              >
                Add an item
              </Button>
            </li>
          );
        })}
      </ol>
      <div>
        <Button
          size="sm"
          icon={<Plus className="size-4" aria-hidden />}
          onClick={() => write([...packages, { label: nextLabel(packages.length), items: [], gp: 0 }])}
        >
          Add a choice
        </Button>
      </div>
    </FieldShell>
  );
}
