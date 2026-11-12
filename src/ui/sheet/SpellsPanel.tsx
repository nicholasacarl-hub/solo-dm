/**
 * Spells tab: spellcasting numbers, slot pips per level (toggleable), and the spell list with
 * prepared toggles. Spell names open the rules entry in a dialog.
 */
import { useEffect, useState } from 'react';
import { Brain, BookOpen } from 'lucide-react';
import { formatModifier, ordinal, spellAttackBonus, spellSaveDC } from '@/engine';
import { getRulesIndex } from '@/data';
import { cn } from '@/lib/cn';
import { useGame } from '@/state/gameStore';
import { ABILITY_NAMES, type Character, type CompendiumEntry, type KnownSpell, type SpellSlotLevel } from '@/types';
import { Markdown } from '@/ui/components/Markdown';
import { Badge, Dialog, EmptyState, Spinner } from '@/ui/components/ui';
import { BookBadge } from '@/ui/builder/BookBadges';
import { FromBookLine } from './FromBook';
import { concentrationChange, preparedChange, slotChange } from './sheetChanges';
import { Pips, SheetSection, StatTile } from './SheetParts';
import type { SheetChange } from './useSheetActions';

const SLOT_LEVELS: SpellSlotLevel[] = [1, 2, 3, 4, 5, 6, 7, 8, 9];

type EntryState = { status: 'loading' } | { status: 'ready'; entry: CompendiumEntry | null } | { status: 'error'; message: string };

/**
 * Look a spell up in the rules index (by id, then by name) and show its text, under the spell's own notes (the DM's
 * when it granted the spell, the builder's for a feat's or species' spell). Nothing is copied onto the sheet: a spell
 * from a book that isn't on this device, or is switched off, says so.
 */
export function RulesEntryDialog({
  spell,
  onClose,
}: {
  spell: (Pick<KnownSpell, 'id' | 'name'> & Partial<Pick<KnownSpell, 'ref' | 'notes'>>) | null;
  onClose: () => void;
}) {
  const campaignId = useGame((s) => s.campaignId);
  const [state, setState] = useState<EntryState>({ status: 'loading' });
  useEffect(() => {
    if (!spell) return;
    let alive = true;
    setState({ status: 'loading' });
    (async () => {
      try {
        const index = await getRulesIndex();
        const entry = index.get(spell.id) ?? index.findByName(spell.name, { kind: 'spell', campaignId }) ?? null;
        if (alive) setState({ status: 'ready', entry });
      } catch (err) {
        if (alive) setState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    })();
    return () => {
      alive = false;
    };
  }, [spell, campaignId]);
  return (
    <Dialog
      open={spell !== null}
      onClose={onClose}
      title={spell?.name ?? ''}
      description={state.status === 'ready' && state.entry ? [state.entry.summary, state.entry.sourceName].filter(Boolean).join(' · ') : undefined}
      size="lg"
    >
      {spell?.notes?.trim() && (
        <p className="mb-3 text-sm">
          <span className="font-medium">Notes: </span>
          {spell.notes.trim()}
        </p>
      )}
      {state.status === 'loading' && (
        <div className="flex justify-center py-6">
          <Spinner label="Looking up the rules" />
        </div>
      )}
      {state.status === 'error' && <p className="text-sm text-danger">The rules aren't available right now ({state.message}).</p>}
      {state.status === 'ready' &&
        (state.entry ? (
          <Markdown>{state.entry.text}</Markdown>
        ) : spell?.ref ? (
          <FromBookLine bookRef={spell.ref} className="text-sm text-muted" />
        ) : (
          <p className="text-sm text-muted">No rules text found for {spell?.name}. Ask the DM, or add it from your Library.</p>
        ))}
    </Dialog>
  );
}

function SlotRow({ label, total, used, onToggle }: { label: string; total: number; used: number; onToggle?: (fill: boolean) => void }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-20 shrink-0 text-xs text-muted">{label}</span>
      <Pips total={total} filled={total - used} tone="arcane" label={`${label} slots`} onToggle={onToggle} />
      <span className="ml-auto text-xs text-faint tabular-nums">
        {total - used}/{total}
      </span>
    </div>
  );
}

function groupByLevel(spells: KnownSpell[]): [number, KnownSpell[]][] {
  const groups = new Map<number, KnownSpell[]>();
  for (const s of [...spells].sort((a, b) => a.level - b.level || a.name.localeCompare(b.name))) {
    groups.set(s.level, [...(groups.get(s.level) ?? []), s]);
  }
  return [...groups.entries()];
}

function SpellRow({
  c,
  spell,
  editable,
  onEdit,
  onOpen,
}: {
  c: Character;
  spell: KnownSpell;
  editable: boolean;
  onEdit: (change: (c: Character) => SheetChange) => void;
  onOpen: (spell: KnownSpell) => void;
}) {
  const concentrating = c.spellcasting?.concentratingOn === spell.name;
  const canToggle = editable && spell.level > 0 && !spell.alwaysPrepared;
  return (
    <li className={cn('py-1', spell.level > 0 && !spell.prepared && !spell.alwaysPrepared && 'opacity-70')}>
      <div className="flex items-center gap-2">
        {spell.level > 0 &&
          (canToggle ? (
            <input
              type="checkbox"
              checked={spell.prepared}
              onChange={(e) => onEdit((cur) => preparedChange(cur, spell.id, e.target.checked))}
              aria-label={`Prepared: ${spell.name}`}
              className="size-4 shrink-0 accent-[var(--arcane)]"
            />
          ) : (
            <span
              aria-label={spell.alwaysPrepared ? 'Always prepared' : spell.prepared ? 'Prepared' : 'Not prepared'}
              title={spell.alwaysPrepared ? 'Always prepared' : spell.prepared ? 'Prepared' : 'Not prepared'}
              className={cn('size-2.5 shrink-0 rounded-full', spell.prepared || spell.alwaysPrepared ? 'bg-arcane' : 'border border-border')}
            />
          ))}
        <button type="button" onClick={() => onOpen(spell)} className="min-w-0 truncate text-left text-sm font-medium hover:text-arcane hover:underline">
          {spell.name}
        </button>
        {spell.concentration && <Badge tone="arcane" className="px-1.5">C</Badge>}
        {spell.ritual && <Badge className="px-1.5">R</Badge>}
        {spell.alwaysPrepared && <Badge tone="arcane">Always</Badge>}
        {spell.ref && <BookBadge title={spell.ref.sourceTitle} />}
        <span className="ml-auto truncate text-xs text-faint">{spell.source}</span>
        {editable && spell.concentration && (
          <button
            type="button"
            aria-pressed={concentrating}
            aria-label={concentrating ? `Stop concentrating on ${spell.name}` : `Concentrate on ${spell.name}`}
            title={concentrating ? 'Stop concentrating' : 'Concentrate on this spell'}
            onClick={() => onEdit((cur) => concentrationChange(cur, concentrating ? null : spell.name))}
            className={cn(
              'grid size-7 shrink-0 place-items-center rounded-lg transition-colors',
              concentrating ? 'bg-arcane-soft text-arcane' : 'text-faint hover:bg-surface-3 hover:text-arcane',
            )}
          >
            <Brain className="size-3.5" aria-hidden />
          </button>
        )}
      </div>
      {/* The spell's notes (what the DM wrote when it granted it, or the builder's), shown here as they are to the DM. */}
      {spell.notes?.trim() && <p className="ml-6 line-clamp-2 text-xs text-muted">{spell.notes.trim()}</p>}
    </li>
  );
}

export function SpellsPanel({
  character: c,
  editable,
  onEdit,
}: {
  character: Character;
  editable: boolean;
  onEdit: (change: (c: Character) => SheetChange) => void;
}) {
  const [open, setOpen] = useState<KnownSpell | null>(null);
  const sc = c.spellcasting;
  if (!sc) {
    return (
      <EmptyState icon={<BookOpen className="size-8" aria-hidden />} title="No spellcasting">
        Spells you learn from your class, species, feats or the DM's boons will appear here.
      </EmptyState>
    );
  }
  const dc = spellSaveDC(c, sc.ability);
  const attack = spellAttackBonus(c, sc.ability);
  const slotLevels = SLOT_LEVELS.filter((l) => (sc.slots[l]?.max ?? 0) > 0);
  const prepared = sc.spells.filter((s) => s.level > 0 && s.prepared && !s.alwaysPrepared).length;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-3 gap-1.5">
        <StatTile label="Ability" value={sc.ability.toUpperCase()} sub={ABILITY_NAMES[sc.ability]} />
        <StatTile label="Save DC" value={dc ?? '—'} />
        <StatTile label="Attack" value={attack === null ? '—' : formatModifier(attack)} />
      </div>
      {(slotLevels.length > 0 || sc.pact) && (
        <SheetSection title="Spell slots">
          <div className="flex flex-col gap-1.5">
            {slotLevels.map((level) => {
              const track = sc.slots[level]!;
              return (
                <SlotRow
                  key={level}
                  label={`${ordinal(level)} level`}
                  total={track.max}
                  used={track.used}
                  onToggle={editable ? (fill) => onEdit((cur) => slotChange(cur, level, !fill)) : undefined}
                />
              );
            })}
            {sc.pact && (
              <SlotRow
                label={`Pact (${ordinal(sc.pact.slotLevel)})`}
                total={sc.pact.slots.max}
                used={sc.pact.slots.used}
                onToggle={editable ? (fill) => onEdit((cur) => slotChange(cur, sc.pact!.slotLevel, !fill, true)) : undefined}
              />
            )}
          </div>
        </SheetSection>
      )}
      {groupByLevel(sc.spells).map(([level, spells]) => (
        <SheetSection
          key={level}
          title={level === 0 ? 'Cantrips' : `${ordinal(level)} level`}
          action={level === 1 ? <span className="text-xs text-faint tabular-nums">{prepared} prepared</span> : undefined}
        >
          <ul className="flex flex-col divide-y divide-border/60">
            {spells.map((spell) => (
              <SpellRow key={spell.id} c={c} spell={spell} editable={editable} onEdit={onEdit} onOpen={setOpen} />
            ))}
          </ul>
        </SheetSection>
      ))}
      {sc.spells.length === 0 && <p className="text-sm text-muted">No spells recorded yet.</p>}
      <RulesEntryDialog spell={open} onClose={() => setOpen(null)} />
    </div>
  );
}
