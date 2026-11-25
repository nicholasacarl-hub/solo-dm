/**
 * Manual level-up from the sheet (the DM can also level the character with its level_up tool), from the
 * merged builder data (spec §5.4): the SRD plus the classes, subclasses and feats of the player's books.
 * Choose the class (or multiclass, with the 2024 13+ primary-ability prerequisite), the HP method, a
 * subclass at its level (chosen by id; a subclass chosen late catches up its earlier features), and —
 * at Ability Score Improvement, Epic Boon and (Additional) Fighting Style levels — a choice whose
 * default, "Decide with my DM", keeps today's level-up. Applied through the engine's levelUp, then every
 * feature's uses are re-read at the new level (Rage, Lay on Hands, Breath Weapon…), the class's and
 * subclass's always-prepared spells up to the new level are added or turned always prepared, and the class's
 * spell choices are marked open (spellPicks.ts counts them live), with another class's whose pick was turned. The
 * Summary's "Choose spells" continues into the choices form in this same dialog.
 */
import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { ArrowBigUpDash, Check, Sparkles, TriangleAlert } from 'lucide-react';
import { XP_THRESHOLDS, abilityModifier, characterLevel, levelUp, type LevelUpOptions, type LevelUpResult } from '@/engine';
import { getRulesIndex, useBuilderData, useRulesIndexState } from '@/data';
import { withAdaptationNotes } from '@/data/options/adaptationNotes';
import { featureUseChanges, gainedFeatures, keptRulings, refreshFeatureUses } from '@/data/options/leveling';
import {
  applyFeatChoice,
  caughtUpFeatures,
  classRefOf,
  dropChoiceReminder,
  featChoiceNotice,
  featChoices,
  featChoiceTrigger,
  offersScoreIncrease,
  subclassCastingOf,
  subclassFightingStyle,
  subclassRefOf,
  type FeatChoice,
  type FeatChoiceTrigger,
  type FeatPick,
  type ScoreIncrease,
} from '@/data/options/levelUpChoices';
import { subclassesOf, withoutReplacedSrd } from '@/data/options/replaced';
import { classOptionFor, multiclassPrimariesFor, primaryRuleOf, subclassOptionFor } from '@/data/options/resolve';
import {
  alwaysPreparedGained,
  applyAlwaysPrepared,
  levelSpellsEdit,
  openSpellPicks,
  owedSpells,
  owedSpellsSummary,
  recordingClause,
  spellPicksAfterLevel,
  swapsText,
  withoutSpellReview,
  type AlwaysPreparedGain,
  type OpenSpellPicks,
  type OwedSpells,
  type TurnedSpell,
} from '@/data/options/spellPicks';
import { nameKey } from '@/lib/id';
import { useGame } from '@/state/gameStore';
import {
  ABILITY_NAMES,
  type Ability,
  type BuilderData,
  type Character,
  type ClassFeatureDef,
  type ClassLevel,
  type ClassOption,
  type CompendiumEntry,
  type Feature,
  type HitDie,
  type SpellPicksOwed,
  type SubclassOption,
} from '@/types';
import { Markdown } from '@/ui/components/Markdown';
import { Badge, Button, Dialog, EmptyState, Input, Segmented, Select, Spinner } from '@/ui/components/ui';
import { BookBadge, OlderEditionBadge, OlderEditionNotes } from '@/ui/builder/BookBadges';
import { RadioCards } from '@/ui/builder/BuilderParts';
import { FeatChoicePanel, featChoiceReady, featPanelTitle } from './FeatChoicePanel';
import { SpellPicksForm, type ReaderBack } from './SpellPicksForm';
import { openPicksText, picksText } from './spellPicksText';
import { useSheetEdit } from './useSheetActions';

export interface LevelUpDialogProps {
  open: boolean;
  onClose: () => void;
}

export function LevelUpDialog({ open, onClose }: LevelUpDialogProps) {
  // The Summary's "Choose spells" continues in this same dialog: no dialog on a dialog, and it works where the sheet
  // isn't mounted (Level up from the composer's menu). The level-up stays mounted behind the choices form, so Cancel
  // goes back to its Summary.
  const [picking, setPicking] = useState<string | null>(null);
  const [footer, setFooter] = useState<HTMLDivElement | null>(null);
  const chooseButton = useRef<HTMLButtonElement>(null);
  const readerBack = useRef<ReaderBack | null>(null);
  if (!open && picking !== null) setPicking(null);
  const close = () => {
    setPicking(null);
    onClose();
  };
  // Escape or Android Back while a spell is read in the choices goes back to their lists (the picks stay); otherwise it
  // closes, as Close does.
  const cancel = () => {
    if (!readerBack.current?.()) close();
  };
  const back = () => {
    setPicking(null);
    requestAnimationFrame(() => chooseButton.current?.focus());
  };
  return (
    <Dialog open={open} onClose={close} onCancel={cancel} title={picking ? 'Choose spells' : 'Level up'} size="lg" footer={picking ? <div ref={setFooter} className="w-full" /> : undefined}>
      {/* Mounted only while open, so builder data loads on demand. */}
      <div hidden={picking !== null}>
        <LevelUpForm onClose={close} onChooseSpells={setPicking} chooseButton={chooseButton} />
      </div>
      {picking && <SpellPicksForm target={{ mode: 'level', classId: picking }} footer={footer} onCancel={back} onDone={close} focusOnOpen readerBackRef={readerBack} />}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** 2024 multiclassing: 13+ in the class's primary abilities — any one of them ("Strength or Dexterity") or all. */
export function meetsPrimary(cls: Pick<ClassOption, 'id' | 'primaryAbilities' | 'primaryAbilityRule'>, scores: Character['abilityScores']): boolean {
  if (!cls.primaryAbilities.length) return true;
  const ok = (a: Ability) => scores[a] >= 13;
  return primaryRuleOf(cls) === 'any' ? cls.primaryAbilities.some(ok) : cls.primaryAbilities.every(ok);
}

type Choice = { kind: 'existing'; index: number } | { kind: 'new'; classId: string };

function choiceKey(choice: Choice): string {
  return choice.kind === 'existing' ? `existing:${choice.index}` : `new:${choice.classId}`;
}

/** What this level-up brings, from the builder data: the class, its subclass, features, spells and choice. */
interface LevelPlan {
  existing?: ClassLevel;
  option?: ClassOption;
  className: string;
  classLevel: number;
  hitDie: HitDie;
  /** The class reaches its subclass level without a subclass: one must be chosen now. */
  needsSubclass: boolean;
  /** The subclass chosen now, or the one the class already has. */
  sub?: SubclassOption;
  features: Omit<Feature, 'id'>[];
  caughtUp: ClassFeatureDef[];
  trigger: FeatChoiceTrigger | null;
  /** The always-prepared spells the class and subclass grant up to the new level: added, or turned always prepared. */
  spells: AlwaysPreparedGain;
  /** The spell choices the new level opens (worked out on the hero as the level-up leaves them), or null. */
  next: { owed: OwedSpells; entry: SpellPicksOwed } | null;
}

type FindSpell = (name: string) => CompendiumEntry | undefined;

/**
 * What the class's spell choices will be once the level is gained: the class entry at its new level (a new class at
 * level 1), the always-prepared spells applied (they free places), then the mark the level-up writes.
 */
function nextSpellPicks(c: Character, existing: ClassLevel | undefined, option: ClassOption | undefined, classLevel: number, gain: AlwaysPreparedGain): LevelPlan['next'] {
  if (!option) return null;
  const cl: ClassLevel = existing
    ? { ...existing, level: classLevel }
    : { classId: option.id, name: option.name, level: 1, hitDie: option.hitDie, casterType: option.casterType, ...(option.spellcastingAbility ? { spellcastingAbility: option.spellcastingAbility } : {}) };
  const levelled = applyAlwaysPrepared({ ...c, classes: existing ? c.classes.map((x) => (x === existing ? cl : x)) : [...c.classes, cl] }, gain);
  const owed = owedSpells(levelled, cl, option);
  if (!owed) return null;
  // A hero without spellcasting yet gains it with the class's slots; its level 1 has nothing to replace.
  const marked = spellPicksAfterLevel(levelled.spellcasting ? levelled : { ...levelled, spellcasting: { ability: option.spellcastingAbility ?? 'int', slots: {}, spells: [], concentratingOn: null } }, cl, option);
  const entry = marked.spellcasting?.spellPicks?.find((p) => p.classId === cl.classId);
  return entry ? { owed, entry } : null;
}

function planLevel(c: Character, classes: readonly ClassOption[], choice: Choice, subclassId: string, findSpell: FindSpell): LevelPlan {
  const existing = choice.kind === 'existing' ? c.classes[choice.index] : undefined;
  const option = existing ? classOptionFor(existing, classes) : classes.find((o) => choice.kind === 'new' && o.id === choice.classId);
  const classLevel = (existing?.level ?? 0) + 1;
  const choices = option ? subclassesOf(option) : [];
  const needsSubclass = Boolean(option && classLevel >= option.subclassLevel && !existing?.subclass && choices.length);
  const sub = needsSubclass ? choices.find((s) => s.id === subclassId) : existing ? subclassOptionFor(existing, option, classes) : undefined;
  const ctx = { scores: c.abilityScores, characterLevel: characterLevel(c) + 1 };
  // A multiclass hero's other classes' subclasses: a feature of one of theirs isn't this subclass's.
  const otherSubclasses = c.classes.filter((cl) => cl !== existing).flatMap((cl) => (cl.subclass ? [cl.subclass] : []));
  const features = option ? gainedFeatures(option, classLevel, sub, ctx, { have: c.features, subclassChosenNow: needsSubclass, otherSubclasses }) : [];
  // With the classes' data, a turned spell names the class whose list it leaves, and a spellbook keeps its own.
  const spells = alwaysPreparedGained(c, option, sub, classLevel, findSpell, classes);
  return {
    existing,
    option,
    className: existing?.name ?? option?.name ?? '',
    classLevel,
    hitDie: existing?.hitDie ?? option?.hitDie ?? 8,
    needsSubclass,
    sub,
    features,
    caughtUp: needsSubclass ? caughtUpFeatures(sub, classLevel, c.features, otherSubclasses) : [],
    trigger: featChoiceTrigger(features),
    spells,
    next: nextSpellPicks(c, existing, option, classLevel, spells),
  };
}

/** The engine call for the plan: an existing class by its own id; a new one with its numbers and ref. */
function levelUpOptions(plan: LevelPlan, data: BuilderData | null, hpMethod: LevelUpOptions['hpMethod'], c: Character): LevelUpOptions {
  const { existing, option } = plan;
  const chosen = plan.needsSubclass ? plan.sub : undefined;
  const subclassRef = subclassRefOf(chosen);
  const subclassCasting = subclassCastingOf(chosen);
  const classRef = existing ? undefined : classRefOf(option);
  return {
    className: plan.className,
    ...(existing ? { classId: existing.classId } : option ? { classId: option.id, hitDie: option.hitDie, casterType: option.casterType } : {}),
    ...(!existing && option?.spellcastingAbility ? { spellcastingAbility: option.spellcastingAbility } : {}),
    ...(classRef ? { classRef } : {}),
    ...(chosen ? { subclass: chosen.name, subclassId: chosen.id } : {}),
    ...(subclassRef ? { subclassRef } : {}),
    ...(subclassCasting ? { subclassCasting } : {}),
    hpMethod,
    newFeatures: plan.features,
    // Lets level-up recompute AC (Unarmored Defense, Draconic Resilience...) against real armor stats.
    ...(data ? { equipment: data.equipment } : {}),
    // A book's classes have no SRD data: the engine checks their multiclass prerequisites from these.
    ...(data ? { multiclassPrimaries: multiclassPrimariesFor(existing ? undefined : option, c, data.classes) } : {}),
  };
}

interface NoticeParts {
  className: string;
  classLevel: number;
  newLevel: number;
  hpGained: number;
  hpMax: number;
  subclass?: string;
  added: string[];
  /** "chose: +2 Strength", "always prepared: Faerie Fire, Sleep". */
  extras: string[];
  uses: string[];
  /** The uses the DM ruled (keptRulings), or null. */
  rulings: string | null;
  reminders: string[];
}

/**
 * The class's open spell choices for the DM, in place of the engine's generic "Review your … spells" line: "spells to
 * choose: 1 cantrip, 6 spellbook spells and 2 prepared spells", with the level's swaps; a level that only swaps says
 * nothing new is owed. Then how to record spells the player names instead, for a DM whose session began before its
 * level_up said so.
 */
function spellsToChooseNotice(owed: OwedSpells, entry: SpellPicksOwed): string {
  const summary = owedSpellsSummary(owed);
  const swaps = swapsText(entry);
  const recording = `; if the player names them to you instead: ${recordingClause(owed, entry)}`;
  if (!summary) return `spells to choose: none new (may ${swaps})${recording}`;
  return `spells to choose: ${summary}${swaps ? ` (may also ${swaps})` : ''}${recording}`;
}

/** "Faerie Fire, Sleep (Dusk Domain)": spells by the feature or subclass they come from, in order. */
function bySource<T extends { name: string; source?: string }>(spells: readonly T[]): [string, string[]][] {
  const groups = new Map<string, string[]>();
  for (const s of spells) groups.set(s.source ?? '', [...(groups.get(s.source ?? '') ?? []), s.name]);
  return [...groups.entries()];
}

interface TurnedGroup {
  /** The feature or subclass that keeps them prepared now. */
  source: string;
  /** The hero's class whose list they leave, if any. */
  owner?: string;
  /** They stay in that class's spellbook. */
  inBook: boolean;
  names: string[];
}

/** Turned spells by their new source, the class whose list they leave and whether a spellbook keeps them, in order. */
function turnedGroups(flips: readonly TurnedSpell[]): TurnedGroup[] {
  const groups: TurnedGroup[] = [];
  for (const f of flips) {
    const inBook = f.inBook === true;
    const group = groups.find((g) => g.source === f.source && g.owner === f.owner && g.inBook === inBook);
    if (group) group.names.push(f.name);
    else groups.push({ source: f.source, ...(f.owner ? { owner: f.owner } : {}), inBook, names: [f.name] });
  }
  return groups;
}

/**
 * " — no longer counted among your Cleric prepared spells; it stays in your spellbook": the class named when it isn't
 * the one gaining the level.
 */
function turnedTail(group: TurnedGroup, levelled: string): string {
  const other = group.owner && nameKey(group.owner) !== nameKey(levelled) ? `${group.owner} ` : '';
  const book = group.inBook ? `; ${group.names.length === 1 ? 'it stays' : 'they stay'} in your spellbook` : '';
  return ` — no longer counted among your ${other}prepared spells${book}`;
}

/**
 * The DM notice (names only). With "Decide with my DM", no subclass spells and no uses the DM ruled it is exactly what it
 * always was; the uses it ruled, which the level-up left as they are, are named so the DM keeps them in mind.
 */
function levelUpNotice(n: NoticeParts): string {
  const parts = [`Player leveled up to ${n.className} ${n.classLevel} (character level ${n.newLevel}): +${n.hpGained} HP (max ${n.hpMax})`];
  if (n.subclass) parts.push(`subclass ${n.subclass}`);
  if (n.added.length) parts.push(`new features: ${n.added.join(', ')}`);
  parts.push(...n.extras);
  if (n.uses.length) parts.push(`feature uses now: ${n.uses.join(', ')}`);
  if (n.rulings) parts.push(n.rulings);
  if (n.reminders.length) parts.push(`still to choose: ${n.reminders.join(' ')}`);
  return parts.join('; ');
}

// ---------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------

function Prereq({ cls, scores }: { cls: ClassOption; scores: Character['abilityScores'] }) {
  const met = meetsPrimary(cls, scores);
  const joiner = primaryRuleOf(cls) === 'any' ? ' or ' : ' and ';
  const text = cls.primaryAbilities.map((a) => `${ABILITY_NAMES[a]} ${scores[a]}`).join(joiner);
  return (
    <li className="flex items-center gap-2 text-sm">
      {met ? <Check className="size-4 text-success" aria-hidden /> : <TriangleAlert className="size-4 text-danger" aria-hidden />}
      <span>
        {cls.name} needs {cls.primaryAbilities.map((a) => ABILITY_NAMES[a]).join(joiner)} 13+ <span className="text-muted">(you have {text})</span>
      </span>
      <span className="sr-only">{met ? 'met' : 'not met'}</span>
    </li>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="font-display text-xs font-semibold tracking-[0.14em] text-muted uppercase">{title}</h3>
      {children}
    </section>
  );
}

/** "Wickwright · The Gloamwood Almanac (d8)"; SRD classes keep "Fighter (d10)". */
function multiclassLabel(o: ClassOption): string {
  return o.source ? `${o.name} · ${o.source.title} (d${o.hitDie})` : `${o.name} (d${o.hitDie})`;
}

/** The player's choice in the summary, from the increases that took effect: "You raised Strength by 2.", "You took Lantern Bearer (+1 Wisdom)." */
function choiceSummary(choice: FeatChoice, increases: readonly ScoreIncrease[]): string | null {
  const raised = increases.map((p) => `${ABILITY_NAMES[p.ability]} by ${p.amount}`).join(' and ');
  switch (choice.kind) {
    case 'dm':
      return null;
    case 'plus-two':
    case 'plus-one-one':
      return raised ? `You raised ${raised}.` : null;
    case 'feat': {
      const inc = increases[0];
      return `You took ${choice.pick.name}${inc ? ` (+${inc.amount} ${ABILITY_NAMES[inc.ability]})` : ''}.`;
    }
  }
}

function Summary({
  result,
  uses,
  choice,
  picks,
  onChooseSpells,
  chooseButton,
  onClose,
}: {
  result: LevelUpResult;
  uses: string[];
  choice: string | null;
  /**
   * The spell choices this level-up left open and still open (live: the form, or the DM's spells, settle them): the
   * levelled class's first, then those of classes whose picks it turned always prepared.
   */
  picks: OpenSpellPicks[];
  onChooseSpells?: (classId: string) => void;
  chooseButton?: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}) {
  // The form and its Level up button are gone: focus the first line, so it is read and Tab goes on to the actions.
  const heading = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, []);
  // "Choose spells" opens the levelled class's choices while they are open, else the next class's.
  const first = picks[0];
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3 rounded-xl bg-gold-soft px-4 py-3">
        <ArrowBigUpDash className="size-6 text-gold" aria-hidden />
        <div>
          <p ref={heading} tabIndex={-1} className="font-display font-semibold focus:outline-none">
            Level {result.newLevel}!
          </p>
          <p className="text-sm text-muted">
            +{result.hpGained} HP{result.hpRoll ? ` (rolled ${result.hpRoll.breakdown})` : ''} · HP max {result.character.hp.max}
          </p>
        </div>
      </div>
      {choice && <p className="text-sm">{choice}</p>}
      {uses.length > 0 && (
        <Section title="Feature uses">
          <ul className="list-disc pl-5 text-sm">
            {/* A static list: two lines can read alike (featureUseChanges tells most apart), so the index keys it. */}
            {uses.map((u, i) => (
              <li key={i}>{u}</li>
            ))}
          </ul>
        </Section>
      )}
      {picks.length > 0 && (
        <Section title="Spells to choose">
          {picks.map((p) => (
            <p key={p.cl.classId} className="text-sm">
              {openPicksText(p)}
            </p>
          ))}
          <p className="text-xs text-muted">Choose them now, or later from the Spells tab.</p>
        </Section>
      )}
      {result.reminders.length > 0 && (
        <Section title="Still to do">
          <ul className="list-disc pl-5 text-sm">
            {result.reminders.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          <p className="text-xs text-muted">The DM has been told, and can help you make these choices.</p>
        </Section>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        {first && onChooseSpells && (
          <Button ref={chooseButton} variant="arcane" icon={<Sparkles className="size-4" aria-hidden />} onClick={() => onChooseSpells(first.cl.classId)}>
            Choose spells
          </Button>
        )}
        <Button variant={first && onChooseSpells ? 'secondary' : 'primary'} onClick={onClose}>
          Done
        </Button>
      </div>
    </div>
  );
}

function ClassSection({
  character,
  classes,
  choice,
  onChoice,
  allowAnyway,
  onAllowAnyway,
  prereqClasses,
  prereqMet,
  option,
}: {
  character: Character;
  classes: readonly ClassOption[];
  choice: Choice;
  onChoice: (next: Choice) => void;
  allowAnyway: boolean;
  onAllowAnyway: (value: boolean) => void;
  prereqClasses: ClassOption[];
  prereqMet: boolean;
  option?: ClassOption;
}) {
  const multiId = useId();
  const held = character.classes.map((cl) => classOptionFor(cl, classes)?.id).filter(Boolean);
  const heldNames = new Map(character.classes.map((cl) => [nameKey(cl.name), cl.name]));
  // Without the SRD classes a 2024 book's class of the same name stands in for (the one chosen stays).
  const notHeld = withoutReplacedSrd(classes, [choice.kind === 'new' ? choice.classId : null]).filter((o) => !held.includes(o.id));
  // D29: two "Fighter" entries couldn't be told apart (the DM levels a class by name).
  const multiclassOptions = notHeld.filter((o) => !heldNames.has(nameKey(o.name)));
  const hidden = notHeld.filter((o) => heldNames.has(nameKey(o.name)));
  const existingOptions = character.classes.map((cl, index) => ({
    value: choiceKey({ kind: 'existing', index }),
    title: `${cl.name} ${cl.level} → ${cl.level + 1}`,
    meta: (
      <>
        <span>{cl.subclass ?? `d${cl.hitDie} hit die`}</span>
        {cl.ref && <BookBadge title={cl.ref.sourceTitle} />}
      </>
    ),
  }));
  const multiclassing = choice.kind === 'new';
  return (
    <Section title="Class">
      <RadioCards
        label="Class to gain a level in"
        value={choice.kind === 'existing' ? choiceKey(choice) : null}
        onChange={(key) => onChoice({ kind: 'existing', index: Number(key.split(':')[1]) })}
        options={existingOptions}
      />
      {multiclassOptions.length > 0 && (
        <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
          <label htmlFor={multiId} className="text-sm text-muted">
            Or multiclass into
          </label>
          <Select
            id={multiId}
            value={choice.kind === 'new' ? choice.classId : ''}
            onChange={(e) => (e.target.value ? onChoice({ kind: 'new', classId: e.target.value }) : onChoice({ kind: 'existing', index: 0 }))}
            className="h-9 sm:w-72"
          >
            <option value="">Choose a new class…</option>
            {multiclassOptions.map((o) => (
              <option key={o.id} value={o.id}>
                {multiclassLabel(o)}
              </option>
            ))}
          </Select>
        </div>
      )}
      {hidden.map((o) => (
        <p key={o.id} className="text-xs text-muted">
          {o.name} ({o.source?.title ?? 'SRD 5.2.1'}) isn't offered: your hero already has {heldNames.get(nameKey(o.name))}.
        </p>
      ))}
      {multiclassing && option && (
        <div className="flex flex-col gap-2 rounded-xl border border-border p-3">
          <p className="text-sm font-medium">Multiclassing prerequisites (13+ in each primary ability)</p>
          <ul className="flex flex-col gap-1">
            {prereqClasses.map((c) => (
              <Prereq key={c.id} cls={c} scores={character.abilityScores} />
            ))}
          </ul>
          {!prereqMet && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={allowAnyway} onChange={(e) => onAllowAnyway(e.target.checked)} className="size-4 accent-[var(--accent)]" />
              My DM allows it anyway
            </label>
          )}
        </div>
      )}
    </Section>
  );
}

function SubclassSection({ option, value, onChange }: { option: ClassOption; value: string; onChange: (id: string) => void }) {
  const choices = subclassesOf(option);
  const notes = choices.find((s) => s.id === value)?.source?.adaptations.map((a) => a.note) ?? [];
  return (
    <Section title={`${option.name} subclass`}>
      <RadioCards
        label="Subclass"
        value={value || null}
        onChange={onChange}
        columns="sm:grid-cols-1"
        options={withoutReplacedSrd(choices, [value]).map((s) => ({
          value: s.id,
          title: s.name,
          meta: s.source ? (
            <>
              <BookBadge title={s.source.title} />
              <OlderEditionBadge notes={s.source.adaptations.map((a) => a.note)} />
            </>
          ) : undefined,
          description: s.summary,
        }))}
      />
      <OlderEditionNotes notes={notes} />
    </Section>
  );
}

function FeatureList({ features }: { features: Omit<Feature, 'id'>[] }) {
  return (
    <ul className="flex flex-col gap-1.5">
      {features.map((f) => (
        <li key={`${f.source}-${f.name}`} className="rounded-xl border border-border bg-surface-2">
          <details>
            <summary className="flex cursor-pointer flex-col gap-1 px-3 py-2 text-sm font-medium">
              <span>{f.name}</span>
              {/* Under the name, so a phone keeps the name on one line. */}
              {(f.ref || f.source === 'subclass') && (
                <span className="flex flex-wrap items-center gap-1">
                  {f.ref && <BookBadge title={f.ref.sourceTitle} />}
                  {f.source === 'subclass' && <Badge tone="arcane">Subclass</Badge>}
                </span>
              )}
            </summary>
            <div className="border-t border-border px-3 py-2">
              <Markdown className="text-sm">{f.description || 'No description.'}</Markdown>
            </div>
          </details>
        </li>
      ))}
    </ul>
  );
}

function GainedSection({ plan, bookMissing, rulesLoading }: { plan: LevelPlan; bookMissing: string | null; rulesLoading: boolean }) {
  const { features, option, sub } = plan;
  const fromSubclass = plan.needsSubclass && sub ? features.filter((f) => f.source === 'subclass').map((f) => f.name) : [];
  const caughtUp = plan.caughtUp.map((d) => `${d.name} (level ${d.level})`);
  return (
    <Section title={`New at ${plan.className || 'this'} level ${plan.classLevel}`}>
      {fromSubclass.length > 0 && sub && (
        <p className="text-sm">
          From choosing {sub.name}: {fromSubclass.join(', ')}
          {caughtUp.length > 0 && <span className="text-muted"> — caught up from earlier levels: {caughtUp.join(', ')}</span>}
        </p>
      )}
      {features.length ? (
        <FeatureList features={features} />
      ) : (
        <p className="text-sm text-muted">{option ? 'No new features listed at this level.' : (bookMissing ?? 'Feature details are unavailable; the DM will fill you in.')}</p>
      )}
      {bySource(plan.spells.add).map(([source, names]) => (
        <p key={`add:${source}`} className="text-sm">
          {source ? `Always prepared from ${source}: ${names.join(', ')}` : `Always prepared: ${names.join(', ')}`}
        </p>
      ))}
      {turnedGroups(plan.spells.flip).map((group) => (
        <p key={`flip:${group.source}:${group.owner ?? ''}:${group.inBook}`} className="text-sm">
          {`Now always prepared from ${group.source}: ${group.names.join(', ')}`}
          <span className="text-muted">{turnedTail(group, plan.className)}</span>
        </p>
      ))}
      {/* Until the rules index is first built, every spell looks missing: Level up looks them up once it's there. */}
      {!rulesLoading && plan.spells.missing.length > 0 && (
        <p className="text-xs text-muted">Not in your rules yet: {plan.spells.missing.join(', ')} — your DM can add {plan.spells.missing.length === 1 ? 'it' : 'them'}.</p>
      )}
      {plan.next && picksText(plan.next.owed, plan.next.entry) && (
        <p className="flex items-start gap-1.5 text-sm text-arcane">
          <Sparkles className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>Next: {picksText(plan.next.owed, plan.next.entry)}</span>
        </p>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Form
// ---------------------------------------------------------------------------

function LevelUpForm({
  onClose,
  onChooseSpells,
  chooseButton,
}: {
  onClose: () => void;
  onChooseSpells?: (classId: string) => void;
  chooseButton?: RefObject<HTMLButtonElement | null>;
}) {
  const character = useGame((s) => s.character);
  const campaignId = useGame((s) => s.campaignId);
  const rollMode = useGame((s) => s.campaign?.settings.playerRollMode ?? 'prompt');
  const milestone = useGame((s) => s.campaign?.settings.milestoneLeveling ?? true);
  const builder = useBuilderData();
  // Null until the rules index is first built: Level up then waits for it (getRulesIndex) to look its spells up.
  const { index, loading: rulesLoading } = useRulesIndexState();
  const edit = useSheetEdit();
  const [choice, setChoice] = useState<Choice>({ kind: 'existing', index: 0 });
  const [hpMethod, setHpMethod] = useState<'average' | 'roll'>('average');
  const [hpFace, setHpFace] = useState('');
  const [subclassId, setSubclassId] = useState('');
  const [allowAnyway, setAllowAnyway] = useState(false);
  const [featChoice, setFeatChoice] = useState<FeatChoice>({ kind: 'dm' });
  const [featAllowed, setFeatAllowed] = useState(false);
  const [busy, setBusy] = useState(false);
  // `classIds`: the classes whose spell choices this level-up left open, the levelled class first.
  const [result, setResult] = useState<{ level: LevelUpResult; uses: string[]; choice: string | null; classIds: string[] } | null>(null);
  const faceId = useId();

  if (result) {
    // Those classes' spell choices, live: the choices form, or the DM's spells, settle them.
    const open = character && builder.data ? openSpellPicks(character, builder.data.classes) : [];
    const picks = result.classIds.flatMap((id) => open.filter((p) => p.cl.classId === id));
    return <Summary result={result.level} uses={result.uses} choice={result.choice} picks={picks} onChooseSpells={onChooseSpells} chooseButton={chooseButton} onClose={onClose} />;
  }
  if (!character) return <EmptyState title="No character loaded" />;
  const level = characterLevel(character);
  if (level >= 20) return <EmptyState title="Level 20 — the summit">There are no more levels to gain; ask the DM about Epic Boons.</EmptyState>;
  if (builder.loading) {
    return (
      <div className="flex justify-center py-8">
        <Spinner label="Loading class data" />
      </div>
    );
  }

  const classes = builder.data?.classes ?? [];
  const findSpell: FindSpell = (name) => index?.findByName(name, { kind: 'spell', campaignId });
  const plan = planLevel(character, classes, choice, subclassId, findSpell);
  const { existing, option, className, classLevel, hitDie } = plan;
  const conMod = abilityModifier(character.abilityScores.con);
  const average = Math.max(1, hitDie / 2 + 1 + conMod);
  const physical = rollMode === 'physical';
  const face = Number(hpFace);
  const faceValid = Number.isInteger(face) && face >= 1 && face <= hitDie;
  const bookMissing = !option && existing?.ref ? `Class data for ${existing.name} comes from “${existing.ref.sourceTitle}”, which isn't on this device; your DM can fill in its features.` : null;

  const multiclassing = choice.kind === 'new';
  // Each class once: the new class is the hero's too while the Summary is being swapped in.
  const prereqClasses = multiclassing
    ? [option, ...character.classes.map((cl) => classOptionFor(cl, classes))].filter((c, i, all): c is ClassOption => Boolean(c) && all.findIndex((x) => x?.id === c?.id) === i)
    : [];
  const prereqMet = prereqClasses.every((c) => meetsPrimary(c, character.abilityScores));
  // An older book's subclass whose own Fighting Style lists its styles: the panel offers those.
  const subclassStyle = subclassFightingStyle(plan.trigger, plan.sub);
  const picks: FeatPick[] = plan.trigger
    ? featChoices(plan.trigger.kind, builder.data?.feats ?? [], {
        cls: option,
        characterLevel: level + 1,
        have: character.features,
        ...(featChoice.kind === 'feat' ? { keepId: featChoice.pick.id } : {}),
        ...(subclassStyle ? { subclassStyle } : {}),
      })
    : [];
  // The panel's choice counts only while this level's panel offers it: a subclass change can take the panel away or
  // change what it lists. The panel shows, and Level up applies, this one: the listed pick of its id, so a style of one
  // name that another subclass prints too ("inline:<name>") brings that subclass's text and ref, as the panel shows it.
  const listed = featChoice.kind === 'feat' ? picks.find((p) => p.id === featChoice.pick.id) : undefined;
  const offered = plan.trigger && (featChoice.kind === 'feat' ? Boolean(listed) : featChoice.kind === 'dm' || offersScoreIncrease(plan.trigger.kind));
  const chosen: FeatChoice = !offered ? { kind: 'dm' } : featChoice.kind === 'feat' && listed ? { ...featChoice, pick: listed } : featChoice;
  const xpNeeded = XP_THRESHOLDS[level];
  const shortOnXp = !milestone && character.xp < xpNeeded;

  const canApply =
    Boolean(className) &&
    (!multiclassing || prereqMet || allowAnyway) &&
    (!plan.needsSubclass || Boolean(plan.sub)) &&
    (!plan.trigger || featChoiceReady(chosen, featAllowed, character.abilityScores)) &&
    !(hpMethod === 'roll' && physical && !faceValid) &&
    !busy;

  const apply = async () => {
    if (!canApply) return;
    setBusy(true);
    // The always-prepared spells are looked up in the rules index, which a quick Level up can reach before it is first
    // built (Divine Smite would look missing): wait for it, and without it name what wasn't added.
    const rules = index ?? (await getRulesIndex().catch(() => null));
    const findRuleSpell: FindSpell = (name) => rules?.findByName(name, { kind: 'spell', campaignId });
    const base = levelUpOptions(plan, builder.data, hpMethod === 'average' ? 'average' : physical ? { fixed: face } : 'roll', character);
    // A feat picked here joins the level-up, which counts what it brings at this level (Tough: twice the level), and
    // applyFeatChoice completes that same feature by its id: a trait of its name, or an earlier taking of a Repeatable
    // feat, stays beside it as it is.
    const opts: LevelUpOptions =
      chosen.kind === 'feat' && chosen.pick.feat
        ? { ...base, newFeatures: [...(base.newFeatures ?? []), { name: chosen.pick.name, source: 'feat', description: chosen.pick.description }] }
        : base;
    const outcome: { result: LevelUpResult | null; uses: string[]; choice: string | null; classIds: string[] } = { result: null, uses: [], choice: null, classIds: [] };
    const saved = await edit((c) => {
      const r = levelUp(c, opts);
      if (r.character === c) {
        return { character: c, notice: null, warning: r.events.find((e) => e.type === 'warning')?.message ?? 'Could not level up.' };
      }
      const before = new Set(c.features.map((f) => f.id));
      const addedIds = new Set(r.character.features.filter((f) => !before.has(f.id)).map((f) => f.id));
      let next = r.character;
      const warnings: string[] = [];
      let increases: ScoreIncrease[] = [];
      if (plan.trigger) {
        const applied = applyFeatChoice(next, plan.trigger, chosen, { className, classLevel, addedIds, equipment: builder.data?.equipment, ...(plan.sub ? { subclassName: plan.sub.name } : {}) });
        next = applied.character;
        increases = applied.increases;
        warnings.push(...applied.warnings);
      }
      // The older-edition notes of what this level brings (a 2014 subclass chosen now, a book's class or feat) join the sheet's (B6).
      next = withAdaptationNotes(next, [option, plan.sub, chosen.kind === 'feat' ? chosen.pick.feat : undefined]);
      // Existing features grow too: Rage, Second Wind, Lay on Hands, Breath Weapon, Draconic Flight at 5…
      const refreshed = refreshFeatureUses(next, builder.data);
      const uses = featureUseChanges(c, refreshed);
      // The always-prepared spells up to the new level, on the sheet as it is now: added, or a pick turned always prepared
      // (it stops counting). Then the class's choices are marked open, counted with the places those free (SRD 5.2.1
      // srd:rule:gaining-spells: "a spell that you always have prepared doesn't count against the number of spells"), and
      // so are another class's whose pick was turned (levelSpellsEdit, on the levelled entry as the level-up left it).
      const levelledId = plan.existing?.classId ?? option?.id;
      const levelled = refreshed.classes.find((cl) => (levelledId ? cl.classId === levelledId : nameKey(cl.name) === nameKey(className)));
      const spells = option && levelled ? levelSpellsEdit(refreshed, levelled, option, plan.sub, findRuleSpell, classes) : null;
      const final = spells?.character ?? refreshed;
      const gain = spells?.gain ?? { add: [], flip: [], missing: [] };
      const owed = spells?.owed ?? null;
      const others = spells?.others ?? [];
      // Named for what took effect (a score at 20 can't rise), and a choice that changed nothing keeps its reminder; the
      // engine's generic spell line gives way wherever the class's table could be counted.
      const chose = featChoiceNotice(chosen, increases);
      const answered = plan.trigger ? dropChoiceReminder(r.reminders, plan.trigger.kind, chosen, increases) : r.reminders;
      const reminders = owed ? withoutSpellReview(answered, className, classLevel) : answered;
      const added = chosen.kind === 'dm' ? plan.features.map((f) => f.name) : refreshed.features.filter((f) => !before.has(f.id)).map((f) => f.name);
      const hpGained = final.hp.max - c.hp.max;
      outcome.result = { ...r, character: final, hpGained, reminders };
      outcome.uses = uses;
      outcome.choice = choiceSummary(chosen, increases);
      outcome.classIds = levelled ? [levelled.classId, ...others.map((o) => o.cl.classId)] : [];
      return {
        character: final,
        notice: levelUpNotice({
          className,
          classLevel,
          newLevel: r.newLevel,
          hpGained,
          hpMax: final.hp.max,
          ...(plan.needsSubclass && plan.sub ? { subclass: plan.sub.name } : {}),
          added,
          extras: [
            ...(chose ? [chose] : []),
            ...(gain.add.length ? [`always prepared: ${gain.add.map((s) => s.name).join(', ')}`] : []),
            ...(gain.flip.length ? [`now always prepared: ${gain.flip.map((s) => s.name).join(', ')}`] : []),
            // A granted spell the rules here lack (a book that isn't on this device): the DM can add it.
            ...(gain.missing.length ? [`not added (not in the rules here): ${gain.missing.join(', ')}`] : []),
            ...(owed && spells?.entry ? [spellsToChooseNotice(owed, spells.entry)] : []),
            // Another class whose pick was turned always prepared has that place to fill again.
            ...others.map((o) => `${o.cl.name} ${o.cl.level} spells to choose: ${owedSpellsSummary(o.owed)}`),
          ],
          uses,
          rulings: keptRulings(final),
          reminders,
        }),
        warning: warnings.join(' ') || null,
      };
    });
    setBusy(false);
    if (saved && outcome.result) setResult({ level: { ...outcome.result, character: saved }, uses: outcome.uses, choice: outcome.choice, classIds: outcome.classIds });
  };

  const selectChoice = (next: Choice) => {
    setChoice(next);
    setSubclassId('');
    setAllowAnyway(false);
    setFeatChoice({ kind: 'dm' });
    setFeatAllowed(false);
  };

  return (
    <div className="flex flex-col gap-5">
      {builder.error && <p className="text-sm text-danger">Class data couldn't load ({builder.error}); you can still level your current class.</p>}
      <ClassSection
        character={character}
        classes={classes}
        choice={choice}
        onChoice={selectChoice}
        allowAnyway={allowAnyway}
        onAllowAnyway={setAllowAnyway}
        prereqClasses={prereqClasses}
        prereqMet={prereqMet}
        option={option}
      />
      {shortOnXp && (
        <p className="text-sm text-gold">
          You have {character.xp.toLocaleString()} XP; level {level + 1} needs {xpNeeded.toLocaleString()} XP. Level up only if your DM agrees.
        </p>
      )}

      <Section title="Hit points">
        <Segmented
          className="self-start"
          value={hpMethod}
          onChange={setHpMethod}
          options={[
            { value: 'average', label: `Average (${average})` },
            { value: 'roll', label: `Roll 1d${hitDie} ${conMod >= 0 ? '+' : '−'} ${Math.abs(conMod)}` },
          ]}
        />
        {hpMethod === 'roll' && physical && (
          <div className="flex items-center gap-2">
            <label htmlFor={faceId} className="text-sm">
              Your d{hitDie} roll
            </label>
            <Input id={faceId} type="number" inputMode="numeric" min={1} max={hitDie} value={hpFace} onChange={(e) => setHpFace(e.target.value)} className="h-9 w-20 tabular-nums" />
          </div>
        )}
        <p className="text-xs text-muted">At least 1 HP per level. Features such as Dwarven Toughness are added automatically.</p>
      </Section>

      {plan.needsSubclass && option && <SubclassSection option={option} value={subclassId} onChange={setSubclassId} />}

      {plan.trigger && (
        <Section title={featPanelTitle(plan.trigger)}>
          <FeatChoicePanel
            trigger={plan.trigger}
            picks={picks}
            choice={chosen}
            onChoice={(next) => {
              // "My DM allows it" belongs to one feat: picking another clears it.
              if (next.kind !== 'feat' || chosen.kind !== 'feat' || next.pick.id !== chosen.pick.id) setFeatAllowed(false);
              setFeatChoice(next);
            }}
            scores={character.abilityScores}
            dmAllows={featAllowed}
            onDmAllows={setFeatAllowed}
          />
        </Section>
      )}

      <GainedSection plan={plan} bookMissing={bookMissing} rulesLoading={rulesLoading} />

      <div className="flex justify-end gap-2 border-t border-border pt-3">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" loading={busy} disabled={!canApply} icon={<ArrowBigUpDash className="size-4" aria-hidden />} onClick={() => void apply()}>
          Level up
        </Button>
      </div>
    </div>
  );
}
