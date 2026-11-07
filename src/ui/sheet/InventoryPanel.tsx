/**
 * Inventory tab: items (quantity, equip, attune, remove), adding items, and the coin purse.
 * Equipping armor or a shield recomputes AC with the builder's equipment catalog.
 */
import { useEffect, useId, useState, type FormEvent } from 'react';
import { Coins, Minus, Plus, Shield, Sparkles, Trash2 } from 'lucide-react';
import { loadBuilderData } from '@/data';
import { newId } from '@/lib/id';
import { cn } from '@/lib/cn';
import type { Character, Currency, EquipmentOption, InventoryItem, ItemCategory } from '@/types';
import { Badge, Button, Input, Select } from '@/ui/components/ui';
import {
  MAX_ATTUNED,
  addItemChange,
  currencyChange,
  itemAttuneChange,
  itemEquipChange,
  itemQuantityChange,
  removeItemChange,
} from './sheetChanges';
import { SheetSection } from './SheetParts';
import type { SheetChange } from './useSheetActions';

type Edit = (change: (c: Character) => SheetChange) => void;

/** The builder's equipment catalog (for AC), loaded lazily; null until loaded or if unavailable. */
function useEquipmentCatalog(): EquipmentOption[] | null {
  const [catalog, setCatalog] = useState<EquipmentOption[] | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const data = await loadBuilderData();
        if (alive) setCatalog(data.equipment);
      } catch {
        // Without the catalog, equipping still works; AC just isn't recalculated.
      }
    })();
    return () => {
      alive = false;
    };
  }, []);
  return catalog;
}

const CATEGORY_LABELS: Record<ItemCategory, string> = {
  weapon: 'Weapon',
  armor: 'Armor',
  shield: 'Shield',
  gear: 'Gear',
  tool: 'Tool',
  consumable: 'Consumable',
  treasure: 'Treasure',
  'magic-item': 'Magic item',
  other: 'Other',
};

const EQUIPPABLE: ItemCategory[] = ['weapon', 'armor', 'shield', 'magic-item'];

function ItemRow({ item, editable, onEdit, catalog }: { item: InventoryItem; editable: boolean; onEdit: Edit; catalog: EquipmentOption[] | null }) {
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!confirming) return;
    const id = window.setTimeout(() => setConfirming(false), 3000);
    return () => window.clearTimeout(id);
  }, [confirming]);
  const equippable = EQUIPPABLE.includes(item.category ?? 'gear') || item.equipped;
  const attunable = item.magic || item.category === 'magic-item' || item.attuned;
  const weight = item.weight ? `${+(item.weight * item.quantity).toFixed(2)} lb.` : null;
  return (
    <li className="flex flex-col gap-1 py-2">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className={cn('truncate text-sm font-medium', item.magic && 'text-arcane')}>{item.name}</span>
            {item.equipped && <Badge tone="accent">Equipped</Badge>}
            {item.attuned && <Badge tone="arcane">Attuned</Badge>}
          </div>
          <span className="text-xs text-faint">{[item.category ? CATEGORY_LABELS[item.category] : null, weight].filter(Boolean).join(' · ')}</span>
        </div>
        {editable ? (
          <div className="flex shrink-0 items-center rounded-lg border border-border" role="group" aria-label={`${item.name} quantity`}>
            {/* At 1 the last one goes through Remove and its confirmation, so its details aren't lost by a stray tap. */}
            <button
              type="button"
              aria-label={`One fewer ${item.name}`}
              disabled={item.quantity <= 1}
              title={item.quantity <= 1 ? 'Use Remove to take the last one off your sheet' : undefined}
              onClick={() => onEdit((c) => itemQuantityChange(c, item.id, item.quantity - 1))}
              className="grid size-7 place-items-center text-muted hover:text-text disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-muted"
            >
              <Minus className="size-3.5" aria-hidden />
            </button>
            <span className="w-7 text-center text-sm tabular-nums" aria-live="polite">
              {item.quantity}
            </span>
            <button
              type="button"
              aria-label={`One more ${item.name}`}
              onClick={() => onEdit((c) => itemQuantityChange(c, item.id, item.quantity + 1))}
              className="grid size-7 place-items-center text-muted hover:text-text"
            >
              <Plus className="size-3.5" aria-hidden />
            </button>
          </div>
        ) : (
          <span className="text-sm text-muted tabular-nums">×{item.quantity}</span>
        )}
        {editable && equippable && (
          <button
            type="button"
            aria-pressed={Boolean(item.equipped)}
            aria-label={item.equipped ? `Unequip ${item.name}` : `Equip ${item.name}`}
            title={item.equipped ? 'Unequip' : 'Equip'}
            onClick={() => onEdit((c) => itemEquipChange(c, item.id, !item.equipped, catalog))}
            className={cn('grid size-8 shrink-0 place-items-center rounded-lg', item.equipped ? 'bg-accent-soft text-accent' : 'text-faint hover:bg-surface-2 hover:text-text')}
          >
            <Shield className="size-4" aria-hidden />
          </button>
        )}
        {editable && attunable && (
          <button
            type="button"
            aria-pressed={Boolean(item.attuned)}
            aria-label={item.attuned ? `End attunement to ${item.name}` : `Attune to ${item.name}`}
            title={item.attuned ? 'End attunement' : 'Attune'}
            onClick={() => onEdit((c) => itemAttuneChange(c, item.id, !item.attuned))}
            className={cn('grid size-8 shrink-0 place-items-center rounded-lg', item.attuned ? 'bg-arcane-soft text-arcane' : 'text-faint hover:bg-surface-2 hover:text-text')}
          >
            <Sparkles className="size-4" aria-hidden />
          </button>
        )}
        {editable && (
          <button
            type="button"
            aria-label={confirming ? `Confirm removing ${item.name}` : `Remove ${item.name}`}
            title={confirming ? 'Click again to remove' : 'Remove'}
            onClick={() => (confirming ? onEdit((c) => removeItemChange(c, item.id)) : setConfirming(true))}
            className={cn(
              'grid h-8 shrink-0 place-items-center rounded-lg px-2 text-xs font-medium',
              confirming ? 'bg-danger text-white' : 'text-faint hover:bg-danger-soft hover:text-danger',
            )}
          >
            {confirming ? 'Remove?' : <Trash2 className="size-4" aria-hidden />}
          </button>
        )}
      </div>
      {item.description && (
        <details className="text-xs text-muted">
          <summary className="cursor-pointer text-faint hover:text-text">Details</summary>
          <p className="mt-1 whitespace-pre-line">{item.description}</p>
        </details>
      )}
    </li>
  );
}

function AddItemForm({ onEdit }: { onEdit: Edit }) {
  const [name, setName] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [category, setCategory] = useState<ItemCategory>('gear');
  const nameId = useId();
  const qtyId = useId();
  const catId = useId();
  const qty = Number(quantity);
  const valid = name.trim() !== '' && Number.isInteger(qty) && qty >= 1;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    const item: InventoryItem = { id: newId(), name: name.trim(), quantity: qty, category, ...(category === 'magic-item' ? { magic: true } : {}) };
    onEdit((c) => addItemChange(c, item));
    setName('');
    setQuantity('1');
  };
  return (
    <form onSubmit={submit} className="grid grid-cols-[1fr_4rem] gap-2 @md:grid-cols-[1fr_4rem_8rem_auto]">
      <div>
        <label htmlFor={nameId} className="sr-only">
          Item name
        </label>
        <Input id={nameId} value={name} onChange={(e) => setName(e.target.value)} placeholder="Add an item…" className="h-9" />
      </div>
      <div>
        <label htmlFor={qtyId} className="sr-only">
          Quantity
        </label>
        <Input id={qtyId} type="number" inputMode="numeric" min={1} value={quantity} onChange={(e) => setQuantity(e.target.value)} className="h-9 tabular-nums" />
      </div>
      <div>
        <label htmlFor={catId} className="sr-only">
          Category
        </label>
        <Select id={catId} value={category} onChange={(e) => setCategory(e.target.value as ItemCategory)} className="h-9">
          {(Object.keys(CATEGORY_LABELS) as ItemCategory[]).map((k) => (
            <option key={k} value={k}>
              {CATEGORY_LABELS[k]}
            </option>
          ))}
        </Select>
      </div>
      <Button type="submit" size="sm" disabled={!valid} icon={<Plus className="size-4" aria-hidden />} className="h-9">
        Add
      </Button>
    </form>
  );
}

const COINS: { key: keyof Currency; label: string; className: string }[] = [
  { key: 'pp', label: 'Platinum', className: 'text-text' },
  { key: 'gp', label: 'Gold', className: 'text-gold' },
  { key: 'ep', label: 'Electrum', className: 'text-muted' },
  { key: 'sp', label: 'Silver', className: 'text-muted' },
  { key: 'cp', label: 'Copper', className: 'text-accent' },
];

function CoinPurse({ character: c, editable, onEdit }: { character: Character; editable: boolean; onEdit: Edit }) {
  const [draft, setDraft] = useState<Record<keyof Currency, string>>(() => toDraft(c.currency));
  const baseId = useId();
  useEffect(() => setDraft(toDraft(c.currency)), [c.currency]);
  const commit = () => {
    const next = { ...c.currency };
    for (const { key } of COINS) {
      const n = Number(draft[key]);
      next[key] = Number.isInteger(n) && n >= 0 ? n : c.currency[key];
    }
    setDraft(toDraft(next));
    if (COINS.some(({ key }) => next[key] !== c.currency[key])) onEdit((cur) => currencyChange(cur, next));
  };
  return (
    <div className="grid grid-cols-5 gap-1.5">
      {COINS.map(({ key, label, className }) => (
        <div key={key} className="flex flex-col items-center gap-1 rounded-xl border border-border bg-surface-2 px-1 py-1.5">
          <label htmlFor={`${baseId}-${key}`} className={cn('text-[10px] font-semibold tracking-wider uppercase', className)} title={label}>
            {key}
          </label>
          {editable ? (
            <input
              id={`${baseId}-${key}`}
              type="number"
              inputMode="numeric"
              min={0}
              value={draft[key]}
              onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commit();
              }}
              aria-label={`${label} pieces`}
              className="w-full rounded-md bg-transparent text-center text-base font-semibold tabular-nums focus:bg-surface focus:outline-none"
            />
          ) : (
            <span className="text-base font-semibold tabular-nums">{c.currency[key]}</span>
          )}
        </div>
      ))}
    </div>
  );
}

function toDraft(currency: Currency): Record<keyof Currency, string> {
  return { pp: String(currency.pp), gp: String(currency.gp), ep: String(currency.ep), sp: String(currency.sp), cp: String(currency.cp) };
}

export function InventoryPanel({ character: c, editable, onEdit }: { character: Character; editable: boolean; onEdit: Edit }) {
  const catalog = useEquipmentCatalog();
  const weight = c.inventory.reduce((sum, i) => sum + (i.weight ?? 0) * i.quantity, 0);
  const attuned = c.inventory.filter((i) => i.attuned).length;
  return (
    <div className="flex flex-col gap-4">
      <SheetSection title="Coins" action={<Coins className="size-4 text-gold" aria-hidden />}>
        <CoinPurse character={c} editable={editable} onEdit={onEdit} />
      </SheetSection>
      <SheetSection
        title="Equipment"
        action={
          <span className="text-xs text-faint tabular-nums">
            {+weight.toFixed(1)} lb. · attuned {attuned}/{MAX_ATTUNED}
          </span>
        }
      >
        {c.inventory.length === 0 ? (
          <p className="text-sm text-muted">Your pack is empty.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border/60">
            {c.inventory.map((item) => (
              <ItemRow key={item.id} item={item} editable={editable} onEdit={onEdit} catalog={catalog} />
            ))}
          </ul>
        )}
        {editable && <AddItemForm onEdit={onEdit} />}
      </SheetSection>
    </div>
  );
}
