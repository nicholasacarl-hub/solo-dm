/**
 * The sheet's spell choices: one form, two modes (SRD 5.2.1, each class's Spellcasting or Pact Magic).
 * - level: a class's open choices after a level gained (openSpellPicks): new cantrips, a Wizard's spellbook spells and
 *   prepared spells, each "up to" what the class's table still has room for, worked out live, with the level's optional
 *   swaps ("give up one", which adds one to its list's count).
 * - rest: what a Long Rest lets the class change (classSpellRules), one for one: a Cleric's or Druid's prepared spells
 *   (any), a Paladin's or Ranger's (one), a Wizard's cantrip (its prepared spells change with the Spells tab's
 *   checkboxes, from its spellbook).
 * The lists are the class's own (spellsForClassOption, one spell per name), up to the class's own spell level; a name the
 * sheet holds is shown but not offered ("already known"), and one picked in a list is not offered in another. The
 * footer holds the one live status and the actions (HpMaxDialog's pattern). It renders into `footer`, the dialog's footer
 * slot, so the form serves both the level-up dialog's next step and a dialog of its own (no dialog on a dialog). A
 * spell's text opens in the form itself. Changes go through sheetChanges.ts, checked against the latest sheet.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft } from 'lucide-react';
import { useBuilderData } from '@/data';
import { classSpellRules, classSpellsOf, openSpellPicks, spellLevelsText, type OpenSpellPicks } from '@/data/options/spellPicks';
import { classOptionFor } from '@/data/options/resolve';
import { classSpellLevelCap } from '@/engine';
import { cn } from '@/lib/cn';
import { nameKey } from '@/lib/id';
import { useGame } from '@/state/gameStore';
import { SRD_SOURCE_ID, type Character, type ClassLevel, type ClassOption, type CompendiumEntry, type KnownSpell } from '@/types';
import { Markdown } from '@/ui/components/Markdown';
import { Button, Dialog, Field, Select, Spinner } from '@/ui/components/ui';
import { SubHeading } from '@/ui/builder/BuilderParts';
import { SpellChoiceList } from '@/ui/builder/SpellChoiceList';
import { knownSpell, spellsForClassOption, type SpellInfo } from '@/ui/builder/spells';
import { visibleSpells } from '@/ui/builder/sources';
import { useSpellOptions } from '@/ui/builder/useSpellOptions';
import { restSpellChange, skipSpellPicksChange, spellPicksChange, type SpellPicksChoice } from './sheetChanges';
import { magicalSecretsText, membersOf, multiclassCapText, picksStatus, restStatus, type PickSection } from './spellPicksText';
import { useSheetEdit } from './useSheetActions';

export type SpellPicksMode = 'level' | 'rest';

/** Which class's choices the form shows, and in which mode. */
export interface SpellPicksTarget {
  mode: SpellPicksMode;
  classId: string;
}

export interface SpellPicksFormProps {
  target: SpellPicksTarget;
  /** The dialog's footer slot: the status and the actions render there. */
  footer: HTMLElement | null;
  /** Cancel: nothing changes (the level-up dialog goes back to its summary). */
  onCancel: () => void;
  /** After Apply or Skip. */
  onDone: () => void;
  /** Move focus into the form when it opens (the level-up dialog's next step, whose button it replaces). */
  focusOnOpen?: boolean;
}

/** The form in a dialog of its own (the Spells tab's banner, the sheet header's note). */
export function SpellPicksDialog({ target, onClose }: { target: SpellPicksTarget | null; onClose: () => void }) {
  const [footer, setFooter] = useState<HTMLDivElement | null>(null);
  return (
    <Dialog open={target !== null} onClose={onClose} size="lg" title={target?.mode === 'rest' ? 'Change prepared spells' : 'Choose spells'} footer={<div ref={setFooter} className="w-full" />}>
      {target && <SpellPicksForm key={`${target.mode}:${target.classId}`} target={target} footer={footer} onCancel={onClose} onDone={onClose} />}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------

/** The footer: one live status, then the actions (HpMaxDialog's pattern; held sideways, side by side). */
function FormFooter({ slot, status, children }: { slot: HTMLElement | null; status: string; children: ReactNode }) {
  if (!slot) return null;
  return createPortal(
    <div className="flex w-full flex-col gap-2 phone-landscape:flex-row phone-landscape:items-center phone-landscape:gap-3">
      <p aria-live="polite" className="min-h-5 text-sm text-muted tabular-nums phone-landscape:max-h-10 phone-landscape:min-w-0 phone-landscape:flex-1 phone-landscape:overflow-y-auto">
        {status}
      </p>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 pointer-coarse:[&_button]:min-h-11">{children}</div>
    </div>,
    slot,
  );
}

function Notice({ children }: { children: ReactNode }) {
  return <p className="rounded-xl border border-border bg-surface-2 px-4 py-3 text-sm text-muted">{children}</p>;
}

/** A spell's rules text inside the form (a dialog on top of the dialog is avoided); Back returns to the lists. */
function SpellReader({ spell, onBack }: { spell: SpellInfo; onBack: () => void }) {
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => back.current?.focus(), []);
  const about = [spell.entry.summary, spell.entry.sourceName].filter(Boolean).join(' · ');
  return (
    <section aria-label={spell.name} className="flex flex-col gap-3">
      <Button ref={back} variant="ghost" size="sm" icon={<ArrowLeft className="size-4" aria-hidden />} onClick={onBack} className="self-start pointer-coarse:min-h-11">
        Back to the spells
      </Button>
      <div>
        <h3 className="font-display text-lg font-semibold">{spell.name}</h3>
        {about && <p className="text-sm text-muted">{about}</p>}
      </div>
      {spell.entry.text ? <Markdown className="text-sm">{spell.entry.text}</Markdown> : <p className="text-sm text-muted">No rules text found for {spell.name}. Ask your DM.</p>}
    </section>
  );
}

/** "Give up one cantrip": one of the class's own, or none; the list below then takes one more. */
function GiveUpSelect({ label, none, spells, value, onChange }: { label: string; none: string; spells: readonly KnownSpell[]; value: string; onChange: (id: string) => void }) {
  const id = useId();
  return (
    <Field label={label} htmlFor={id} hint="Replacing ends with this level's choices.">
      <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} aria-describedby={`${id}-hint`} className="sm:max-w-xs">
        <option value="">{none}</option>
        {spells.map((s) => (
          <option key={s.id} value={s.id}>
            {s.level ? `${s.name} (level ${s.level})` : s.name}
          </option>
        ))}
      </Select>
    </Field>
  );
}

/** A sheet spell as a list row: the rules index's entry for its looks and text, the sheet's id (picks are by id). */
function sheetSpellInfo(s: KnownSpell, spells: readonly SpellInfo[]): SpellInfo {
  const found = spells.find((x) => x.id === s.id) ?? spells.find((x) => nameKey(x.name) === nameKey(s.name));
  if (found) return { ...found, id: s.id, name: s.name, level: s.level };
  const entry: CompendiumEntry = { id: s.id, sourceId: s.ref?.sourceId ?? SRD_SOURCE_ID, sourceName: s.ref?.sourceTitle ?? '', kind: 'spell', name: s.name, text: '' };
  return { id: s.id, name: s.name, level: s.level, ritual: Boolean(s.ritual), concentration: Boolean(s.concentration), classes: [], entry };
}

const byLevelThenName = (a: SpellInfo, b: SpellInfo) => a.level - b.level || a.name.localeCompare(b.name);

/** The ids of the pool's spells whose names are in `names`: shown, but not offered. */
function takenIn(pool: readonly SpellInfo[], names: ReadonlySet<string>): Set<string> {
  return new Set(pool.filter((s) => names.has(nameKey(s.name))).map((s) => s.id));
}

/** A spell read in the form, and where focus goes back to. */
function useReader() {
  const [reading, setReading] = useState<SpellInfo | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const open = (spell: SpellInfo) => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setReading(spell);
  };
  const close = () => {
    setReading(null);
    const el = opener.current;
    requestAnimationFrame(() => {
      if (el?.isConnected) el.focus();
    });
  };
  return { reading, open, close };
}

// ---------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------

/** The element that scrolls the form (the dialog's body). */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === 'auto' || overflowY === 'scroll') return node;
  }
  return null;
}

export function SpellPicksForm({ target, footer, onCancel, onDone, focusOnOpen = false }: SpellPicksFormProps) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = root.current;
    if (!focusOnOpen || !el) return;
    // The level-up dialog's body was scrolled down to its Summary's button: the form starts at its top.
    const scroller = scrollParent(el);
    if (scroller) scroller.scrollTop = 0;
    el.focus({ preventScroll: true });
  }, [focusOnOpen]);
  return (
    // One wrapper whatever the form shows (loading, the lists), so focus moved into it stays.
    <div ref={root} tabIndex={-1} className="flex flex-col gap-5 outline-none">
      <FormBody target={target} footer={footer} onCancel={onCancel} onDone={onDone} />
    </div>
  );
}

function FormBody({ target, footer, onCancel, onDone }: Omit<SpellPicksFormProps, 'focusOnOpen'>) {
  const character = useGame((s) => s.character);
  const campaignId = useGame((s) => s.campaignId);
  const builder = useBuilderData();
  const options = useSpellOptions(campaignId);

  const only = (body: ReactNode, status = '') => (
    <>
      {body}
      <FormFooter slot={footer} status={status}>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </FormFooter>
    </>
  );

  const cl = character?.classes.find((x) => x.classId === target.classId);
  if (!character || !cl) return only(<Notice>That class isn't on your sheet any more.</Notice>);
  if (builder.loading) {
    return only(
      <div className="flex items-center gap-2 text-sm text-muted">
        <Spinner label="Loading class data" /> Loading your class…
      </div>,
    );
  }
  const classes = builder.data?.classes ?? [];
  const cls = classOptionFor(cl, classes);
  if (!cls) {
    return only(
      <Notice>
        {cl.name}'s details aren't on this device{builder.error ? ` (${builder.error})` : ''}, so its spells can't be listed here. Your DM can add spells; your choices stay open.
      </Notice>,
    );
  }
  if (options.loading) {
    return only(
      <div className="flex items-center gap-2 text-sm text-muted">
        <Spinner label="Loading spells" /> Loading the spell lists…
      </div>,
    );
  }
  if (!options.spells.length) {
    return only(<Notice>The spell lists aren't available right now{options.error ? ` (${options.error})` : ''}. Your DM can add spells; your choices stay open.</Notice>);
  }
  const shared = { character, cl, cls, spells: options.spells, footer, onCancel, onDone };
  if (target.mode === 'rest') return <RestPicks {...shared} />;
  const open = openSpellPicks(character, classes).find((p) => p.cl.classId === cl.classId);
  if (!open) return only(<Notice>Nothing left to choose for {cl.name} {cl.level}: your sheet has the spells its table gives.</Notice>, 'Nothing left to choose');
  return <LevelPicks {...shared} open={open} />;
}

interface PicksProps {
  character: Character;
  cl: ClassLevel;
  cls: ClassOption;
  spells: SpellInfo[];
  footer: HTMLElement | null;
  onCancel: () => void;
  onDone: () => void;
}

// ---------------------------------------------------------------------------
// A level's choices
// ---------------------------------------------------------------------------

function LevelPicks({ character, cl, cls, spells, footer, onCancel, onDone, open }: PicksProps & { open: OpenSpellPicks }) {
  const edit = useSheetEdit();
  const reader = useReader();
  const [cantrips, setCantrips] = useState<string[]>([]);
  const [book, setBook] = useState<string[]>([]);
  // A class list's new prepared spells, or a spellbook's spells to prepare (its entries' ids and the new book spells').
  const [prepared, setPrepared] = useState<string[]>([]);
  const [giveUpCantrip, setGiveUpCantrip] = useState('');
  const [giveUpSpell, setGiveUpSpell] = useState('');
  const [busy, setBusy] = useState(false);

  const { owed, entry } = open;
  const hasBook = owed.spellbook !== null;
  const own = classSpellsOf(character, cl.name);
  const ownCantrips = own.filter((s) => s.level === 0);
  const ownSpells = own.filter((s) => s.level >= 1);
  const held = new Set((character.spellcasting?.spells ?? []).map((s) => nameKey(s.name)));
  const classList = spellsForClassOption(spells, cls);
  const chosen = new Set([...cantrips, ...book, ...prepared]);
  const cantripPool = visibleSpells(classList.filter((s) => s.level === 0), null, chosen);
  const spellPool = visibleSpells(classList.filter((s) => s.level >= 1 && s.level <= owed.maxLevel), null, chosen);
  const byId = new Map([...cantripPool, ...spellPool].map((s) => [s.id, s]));
  const namesOf = (ids: readonly string[]) => new Set(ids.flatMap((id) => (byId.has(id) ? [nameKey(byId.get(id)!.name)] : [])));
  const without = (...lists: (readonly string[])[]) => new Set([...held, ...lists.flatMap((l) => [...namesOf(l)])]);

  const giveUpCantripSpell = entry.replaceCantrip ? ownCantrips.find((s) => s.id === giveUpCantrip) : undefined;
  const giveUpSpellSpell = entry.replaceSpell && !hasBook ? ownSpells.find((s) => s.id === giveUpSpell) : undefined;
  const cantripOwed = owed.cantrips?.owed ?? 0;
  const cantripMax = cantripOwed + (giveUpCantripSpell ? 1 : 0);
  const bookOwed = owed.spellbook?.owed ?? 0;
  const preparedMax = owed.prepared.owed + (giveUpSpellSpell ? 1 : 0);
  const showCantrips = Boolean(owed.cantrips) && (cantripOwed > 0 || (entry.replaceCantrip === true && ownCantrips.length > 0));
  const showBook = hasBook && bookOwed > 0;
  const showPrepared = owed.prepared.owed > 0 || (!hasBook && entry.replaceSpell === true && ownSpells.length > 0);

  const valid = (ids: readonly string[], pool: readonly SpellInfo[]) => ids.filter((id) => pool.some((s) => s.id === id));
  const validCantrips = valid(cantrips, cantripPool);
  const validBook = valid(book, spellPool);
  // A spellbook's spells to prepare: its unprepared entries of a level it has slots for, and the new book spells.
  const unprepared = ownSpells.filter((s) => !s.prepared && s.level <= owed.maxLevel);
  const prepareOptions = [...validBook.map((id) => byId.get(id)!), ...unprepared.map((s) => sheetSpellInfo(s, spells))].sort(byLevelThenName);
  const validPrepared = valid(prepared, hasBook ? prepareOptions : spellPool);

  const sections: PickSection[] = [
    ...(showCantrips ? [{ kind: 'cantrip' as const, owed: cantripOwed, picked: validCantrips.length, giveUp: giveUpCantripSpell?.name }] : []),
    ...(showBook ? [{ kind: 'book' as const, owed: bookOwed, picked: validBook.length }] : []),
    ...(showPrepared ? [{ kind: hasBook ? ('prepare' as const) : ('prepared' as const), owed: owed.prepared.owed, picked: validPrepared.length, giveUp: giveUpSpellSpell?.name }] : []),
  ];
  const status = picksStatus(sections);
  const canApply = !busy && validCantrips.length + validBook.length + validPrepared.length > 0;

  const toKnown = (ids: readonly string[]): KnownSpell[] => ids.flatMap((id) => (byId.has(id) ? [knownSpell(byId.get(id), byId.get(id)!, { source: cl.name })] : []));
  const apply = async () => {
    if (!canApply) return;
    setBusy(true);
    const choice: SpellPicksChoice = {
      classId: cl.classId,
      cantrips: toKnown(validCantrips),
      spellbook: toKnown(validBook),
      prepared: hasBook ? [] : toKnown(validPrepared),
      prepare: hasBook ? validPrepared : [],
      giveUpCantrip: giveUpCantripSpell?.id ?? null,
      giveUpSpell: giveUpSpellSpell?.id ?? null,
    };
    const saved = await edit((c) => spellPicksChange(c, cls, choice));
    setBusy(false);
    if (saved) onDone();
  };
  const skip = async () => {
    setBusy(true);
    const saved = await edit((c) => skipSpellPicksChange(c, cls, cl.classId));
    setBusy(false);
    if (saved) onDone();
  };

  const cap = multiclassCapText(character, cl, owed.maxLevel);
  const levels = spellLevelsText(owed.maxLevel);
  const secrets = magicalSecretsText(cl, cls);
  const common = { onInfo: reader.open, countInLegend: true };

  return (
    <>
      {reader.reading && <SpellReader spell={reader.reading} onBack={reader.close} />}
      <div hidden={reader.reading !== null} className="flex flex-col gap-5">
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium">
            {cl.name} {cl.level}
          </p>
          {cap ? (
            <p className="text-xs text-muted">{cap}</p>
          ) : (
            levels && <p className="text-xs text-muted phone-landscape:sr-only">{`${levels.charAt(0).toUpperCase()}${levels.slice(1)}, as your ${cl.name} slots allow. Your DM is told what you choose.`}</p>
          )}
        </div>

        {showCantrips &&
          (cantripMax > 0 ? (
            <SpellChoiceList
              {...common}
              label="Cantrips"
              options={cantripPool}
              selected={cantrips}
              max={cantripMax}
              onChange={setCantrips}
              taken={takenIn(cantripPool, without(book, prepared))}
              note={
                entry.replaceCantrip && ownCantrips.length > 0 ? (
                  <GiveUpSelect
                    label="Give up one cantrip (optional)"
                    none="Keep all my cantrips"
                    spells={ownCantrips}
                    value={giveUpCantrip}
                    onChange={(id) => {
                      setGiveUpCantrip(id);
                      if (!id) setCantrips((list) => list.slice(0, cantripOwed));
                    }}
                  />
                ) : undefined
              }
            />
          ) : (
            <section aria-label="Cantrips" className="flex flex-col gap-2">
              <SubHeading>Cantrips</SubHeading>
              <GiveUpSelect label="Give up one cantrip (optional)" none="Keep all my cantrips" spells={ownCantrips} value={giveUpCantrip} onChange={setGiveUpCantrip} />
              <p className="text-xs text-muted">Choose one to give up, and its replacement is chosen here.</p>
            </section>
          ))}

        {showBook && (
          <SpellChoiceList
            {...common}
            byLevel
            label="Spellbook"
            options={spellPool}
            selected={book}
            max={bookOwed}
            onChange={(next) => {
              setBook(next);
              // A new book spell taken out of the book can't stay prepared.
              setPrepared((list) => list.filter((id) => next.includes(id) || unprepared.some((s) => s.id === id)));
            }}
            taken={takenIn(spellPool, without(cantrips))}
            note={<p className="text-xs text-muted">{`${cl.name} spells of a level you have slots for; those already in your book show as known.`}</p>}
          />
        )}

        {showPrepared &&
          (hasBook ? (
            <SpellChoiceList
              {...common}
              byLevel
              label="Prepare from your spellbook"
              options={prepareOptions}
              selected={prepared}
              max={owed.prepared.owed}
              onChange={setPrepared}
              note={<p className="text-xs text-muted">Your book's unprepared spells{showBook ? ', and the ones you add above' : ''}.</p>}
            />
          ) : preparedMax > 0 ? (
            <SpellChoiceList
              {...common}
              byLevel
              label="Prepared spells"
              options={spellPool}
              selected={prepared}
              max={preparedMax}
              onChange={setPrepared}
              taken={takenIn(spellPool, without(cantrips, book))}
              note={
                <>
                  {secrets && <p className="text-xs text-muted">{secrets}.</p>}
                  {entry.replaceSpell && ownSpells.length > 0 && (
                    <GiveUpSelect
                      label="Give up one spell (optional)"
                      none="Keep all my spells"
                      spells={ownSpells}
                      value={giveUpSpell}
                      onChange={(id) => {
                        setGiveUpSpell(id);
                        if (!id) setPrepared((list) => list.slice(0, owed.prepared.owed));
                      }}
                    />
                  )}
                </>
              }
            />
          ) : (
            <section aria-label="Prepared spells" className="flex flex-col gap-2">
              <SubHeading>Prepared spells</SubHeading>
              <GiveUpSelect label="Give up one spell (optional)" none="Keep all my spells" spells={ownSpells} value={giveUpSpell} onChange={setGiveUpSpell} />
              <p className="text-xs text-muted">Choose one to give up, and its replacement is chosen here.</p>
            </section>
          ))}
      </div>

      <FormFooter slot={footer} status={status}>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void skip()} className="mr-auto text-xs text-faint phone-landscape:mr-0">
          Skip these choices
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" loading={busy} disabled={!canApply} onClick={() => void apply()}>
          Apply
        </Button>
      </FormFooter>
    </>
  );
}

// ---------------------------------------------------------------------------
// A Long Rest's change
// ---------------------------------------------------------------------------

function RestPicks({ character, cl, cls, spells, footer, onCancel, onDone }: PicksProps) {
  const edit = useSheetEdit();
  const reader = useReader();
  const [giveUp, setGiveUp] = useState<string[]>([]);
  const [picks, setPicks] = useState<string[]>([]);
  const [giveUpCantrip, setGiveUpCantrip] = useState('');
  const [cantrip, setCantrip] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const giveUpId = useId();

  const rules = classSpellRules(cls).longRest;
  const spellsPart = rules.spells !== null && !rules.fromSpellbook;
  const one = rules.spells === 'one';
  const cap = classSpellLevelCap(cl);
  const own = classSpellsOf(character, cl.name);
  const ownPrepared = own.filter((s) => s.level >= 1 && s.prepared);
  const ownCantrips = own.filter((s) => s.level === 0);
  const held = new Set((character.spellcasting?.spells ?? []).map((s) => nameKey(s.name)));
  const classList = spellsForClassOption(spells, cls);
  const chosen = new Set([...picks, ...cantrip]);
  const spellPool = visibleSpells(classList.filter((s) => s.level >= 1 && s.level <= cap), null, chosen);
  const cantripPool = visibleSpells(classList.filter((s) => s.level === 0), null, chosen);
  const byId = new Map([...spellPool, ...cantripPool].map((s) => [s.id, s]));
  const giveUpOptions = ownPrepared.map((s) => sheetSpellInfo(s, spells)).sort(byLevelThenName);
  const validGiveUp = giveUp.filter((id) => ownPrepared.some((s) => s.id === id));
  const validPicks = picks.filter((id) => spellPool.some((s) => s.id === id)).slice(0, validGiveUp.length);
  const cantripOut = ownCantrips.find((s) => s.id === giveUpCantrip);
  const cantripIn = cantripOut ? cantrip.filter((id) => cantripPool.some((s) => s.id === id)).slice(0, 1) : [];

  const parts = [...(spellsPart ? [{ givenUp: validGiveUp.length, picked: validPicks.length }] : []), ...(rules.cantrip ? [{ givenUp: cantripOut ? 1 : 0, picked: cantripIn.length }] : [])];
  const balanced = parts.every((p) => p.givenUp === p.picked);
  const canApply = !busy && balanced && parts.some((p) => p.picked > 0);
  const status = parts.length ? restStatus(parts) : '';

  const toKnown = (id: string): KnownSpell | null => (byId.has(id) ? knownSpell(byId.get(id), byId.get(id)!, { source: cl.name }) : null);
  const apply = async () => {
    if (!canApply) return;
    setBusy(true);
    const change = {
      classId: cl.classId,
      giveUp: validGiveUp,
      picks: validPicks.flatMap((id) => toKnown(id) ?? []),
      giveUpCantrip: cantripOut?.id ?? null,
      cantrip: cantripIn[0] ? toKnown(cantripIn[0]) : null,
    };
    const saved = await edit((c) => restSpellChange(c, cls, change));
    setBusy(false);
    if (saved) onDone();
  };

  const members = membersOf(cl.name);
  const intro = spellsPart
    ? `${members} change ${one ? 'one of these' : 'these'} after a Long Rest. Your DM is told.`
    : rules.cantrip
      ? `${members} replace one cantrip after a Long Rest. Your DM is told.`
      : `${members} don't change their spells after a Long Rest.`;
  const takenSpells = takenIn(spellPool, held);
  const common = { onInfo: reader.open, countInLegend: true };

  return (
    <>
      {reader.reading && <SpellReader spell={reader.reading} onBack={reader.close} />}
      <div hidden={reader.reading !== null} className="flex flex-col gap-5">
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium">
            {cl.name} {cl.level}
          </p>
          <p className="text-xs text-muted">{intro}</p>
          {rules.fromSpellbook && <p className="text-xs text-muted">Your spellbook's prepared spells change with the Prepared checkboxes on the Spells tab.</p>}
        </div>

        {spellsPart &&
          (one ? (
            <Field label="Spell to give up" htmlFor={giveUpId}>
              <Select
                id={giveUpId}
                value={validGiveUp[0] ?? ''}
                onChange={(e) => {
                  setGiveUp(e.target.value ? [e.target.value] : []);
                  if (!e.target.value) setPicks([]);
                }}
                className="sm:max-w-xs"
              >
                <option value="">Keep all my spells</option>
                {ownPrepared.map((s) => (
                  <option key={s.id} value={s.id}>
                    {`${s.name} (level ${s.level})`}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <SpellChoiceList
              {...common}
              byLevel
              label="Prepared spells to give up"
              options={giveUpOptions}
              selected={giveUp}
              max={giveUpOptions.length}
              onChange={(next) => {
                setGiveUp(next);
                setPicks((list) => list.slice(0, next.length));
              }}
            />
          ))}
        {spellsPart &&
          (validGiveUp.length > 0 ? (
            <SpellChoiceList {...common} byLevel label="Replacements" options={spellPool} selected={picks} max={validGiveUp.length} onChange={setPicks} taken={takenSpells} />
          ) : (
            <p className="text-xs text-muted">Give up a spell first; its replacement is chosen from the {cl.name} list here.</p>
          ))}

        {rules.cantrip && (
          <section aria-label="Cantrips" className={cn('flex flex-col gap-2', spellsPart && 'border-t border-border pt-4')}>
            <GiveUpSelectRest
              spells={ownCantrips}
              value={cantripOut?.id ?? ''}
              onChange={(id) => {
                setGiveUpCantrip(id);
                if (!id) setCantrip([]);
              }}
            />
            {cantripOut ? (
              <SpellChoiceList {...common} label="Replacement cantrip" options={cantripPool} selected={cantrip} max={1} onChange={setCantrip} taken={takenIn(cantripPool, held)} />
            ) : (
              <p className="text-xs text-muted">Choose a cantrip to give up; its replacement is chosen here.</p>
            )}
          </section>
        )}
      </div>

      <FormFooter slot={footer} status={status}>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" loading={busy} disabled={!canApply} onClick={() => void apply()}>
          Apply
        </Button>
      </FormFooter>
    </>
  );
}

function GiveUpSelectRest({ spells, value, onChange }: { spells: readonly KnownSpell[]; value: string; onChange: (id: string) => void }) {
  const id = useId();
  return (
    <Field label="Cantrip to replace" htmlFor={id}>
      <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} className="sm:max-w-xs">
        <option value="">Keep all my cantrips</option>
        {spells.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </Select>
    </Field>
  );
}
