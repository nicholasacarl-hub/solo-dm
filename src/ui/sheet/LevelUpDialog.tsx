/**
 * Manual level-up from the sheet (the DM can also level the character with its level_up tool), from the
 * merged builder data (spec §5.4): the SRD plus the classes, subclasses and feats of the player's books.
 * Choose the class (or multiclass, with the 2024 13+ primary-ability prerequisite), the HP method, a
 * subclass at its level (chosen by id; a subclass chosen late catches up its earlier features), and —
 * at Ability Score Improvement, Epic Boon and Fighting Style levels — a choice whose default, "Decide
 * with my DM", keeps today's level-up. Applied through the engine's levelUp, then every feature's uses
 * are re-read at the new level (Rage, Lay on Hands, Breath Weapon…).
 */
import { useId, useState, type ReactNode } from 'react';
import { ArrowBigUpDash, Check, TriangleAlert } from 'lucide-react';
import { XP_THRESHOLDS, abilityModifier, characterLevel, levelUp, type LevelUpOptions, type LevelUpResult } from '@/engine';
import { useBuilderData, useRulesIndex } from '@/data';
import { withAdaptationNotes } from '@/data/options/adaptationNotes';
import { featureUseChanges, gainedFeatures, refreshFeatureUses } from '@/data/options/leveling';
import {
  addSubclassSpells,
  applyFeatChoice,
  caughtUpFeatures,
  classRefOf,
  dropChoiceReminder,
  featChoiceNotice,
  featChoices,
  featChoiceTrigger,
  subclassCastingOf,
  subclassRefOf,
  subclassSpellsToAdd,
  type FeatChoice,
  type FeatChoiceTrigger,
  type FeatPick,
  type ScoreIncrease,
  type SubclassSpells,
} from '@/data/options/levelUpChoices';
import { classOptionFor, primaryRuleOf, subclassOptionFor } from '@/data/options/resolve';
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
  type Feature,
  type HitDie,
  type SubclassOption,
} from '@/types';
import { Markdown } from '@/ui/components/Markdown';
import { Badge, Button, Dialog, EmptyState, Input, Segmented, Select, Spinner } from '@/ui/components/ui';
import { BookBadge, OlderEditionBadge, OlderEditionNotes } from '@/ui/builder/BookBadges';
import { RadioCards } from '@/ui/builder/BuilderParts';
import { FeatChoicePanel, featChoiceReady, featPanelTitle } from './FeatChoicePanel';
import { useSheetEdit } from './useSheetActions';

export interface LevelUpDialogProps {
  open: boolean;
  onClose: () => void;
}

export function LevelUpDialog({ open, onClose }: LevelUpDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} title="Level up" size="lg">
      {/* Mounted only while open, so builder data loads on demand. */}
      <LevelUpForm onClose={onClose} />
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
  spells: SubclassSpells;
}

function planLevel(
  c: Character,
  classes: readonly ClassOption[],
  choice: Choice,
  subclassId: string,
  findSpell: Parameters<typeof subclassSpellsToAdd>[3],
): LevelPlan {
  const existing = choice.kind === 'existing' ? c.classes[choice.index] : undefined;
  const option = existing ? classOptionFor(existing, classes) : classes.find((o) => choice.kind === 'new' && o.id === choice.classId);
  const classLevel = (existing?.level ?? 0) + 1;
  const needsSubclass = Boolean(option && classLevel >= option.subclassLevel && !existing?.subclass && option.subclasses.length);
  const sub = needsSubclass ? option?.subclasses.find((s) => s.id === subclassId) : existing ? subclassOptionFor(existing, option) : undefined;
  const ctx = { scores: c.abilityScores, characterLevel: characterLevel(c) + 1 };
  const features = option ? gainedFeatures(option, classLevel, sub, ctx, { have: c.features, subclassChosenNow: needsSubclass }) : [];
  return {
    existing,
    option,
    className: existing?.name ?? option?.name ?? '',
    classLevel,
    hitDie: existing?.hitDie ?? option?.hitDie ?? 8,
    needsSubclass,
    sub,
    features,
    caughtUp: needsSubclass ? caughtUpFeatures(sub, classLevel, c.features) : [],
    trigger: featChoiceTrigger(features),
    spells: subclassSpellsToAdd(sub, classLevel, c.spellcasting?.spells ?? [], findSpell),
  };
}

/** The engine call for the plan: an existing class by its own id; a new one with its numbers and ref. */
function levelUpOptions(plan: LevelPlan, data: BuilderData | null, hpMethod: LevelUpOptions['hpMethod']): LevelUpOptions {
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
  reminders: string[];
}

/** The DM notice (names only). With "Decide with my DM" and no subclass spells it is exactly what it always was. */
function levelUpNotice(n: NoticeParts): string {
  const parts = [`Player leveled up to ${n.className} ${n.classLevel} (character level ${n.newLevel}): +${n.hpGained} HP (max ${n.hpMax})`];
  if (n.subclass) parts.push(`subclass ${n.subclass}`);
  if (n.added.length) parts.push(`new features: ${n.added.join(', ')}`);
  parts.push(...n.extras);
  if (n.uses.length) parts.push(`feature uses now: ${n.uses.join(', ')}`);
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

function Summary({ result, uses, choice, onClose }: { result: LevelUpResult; uses: string[]; choice: string | null; onClose: () => void }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3 rounded-xl bg-gold-soft px-4 py-3">
        <ArrowBigUpDash className="size-6 text-gold" aria-hidden />
        <div>
          <p className="font-display font-semibold">Level {result.newLevel}!</p>
          <p className="text-sm text-muted">
            +{result.hpGained} HP{result.hpRoll ? ` (rolled ${result.hpRoll.breakdown})` : ''} · HP max {result.character.hp.max}
          </p>
        </div>
      </div>
      {choice && <p className="text-sm">{choice}</p>}
      {uses.length > 0 && (
        <Section title="Feature uses">
          <ul className="list-disc pl-5 text-sm">
            {uses.map((u) => (
              <li key={u}>{u}</li>
            ))}
          </ul>
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
      <div className="flex justify-end">
        <Button variant="primary" onClick={onClose}>
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
  const notHeld = classes.filter((o) => !held.includes(o.id));
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
  const notes = option.subclasses.find((s) => s.id === value)?.source?.adaptations.map((a) => a.note) ?? [];
  return (
    <Section title={`${option.name} subclass`}>
      <RadioCards
        label="Subclass"
        value={value || null}
        onChange={onChange}
        columns="sm:grid-cols-1"
        options={option.subclasses.map((s) => ({
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

function GainedSection({ plan, bookMissing }: { plan: LevelPlan; bookMissing: string | null }) {
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
      {plan.spells.spells.length > 0 && sub && (
        <p className="text-sm">
          Always prepared from {sub.name}: {plan.spells.spells.map((s) => s.name).join(', ')}
        </p>
      )}
      {plan.spells.missing.length > 0 && (
        <p className="text-xs text-muted">Not in your rules yet: {plan.spells.missing.join(', ')} — your DM can add {plan.spells.missing.length === 1 ? 'it' : 'them'}.</p>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Form
// ---------------------------------------------------------------------------

function LevelUpForm({ onClose }: { onClose: () => void }) {
  const character = useGame((s) => s.character);
  const campaignId = useGame((s) => s.campaignId);
  const rollMode = useGame((s) => s.campaign?.settings.playerRollMode ?? 'prompt');
  const milestone = useGame((s) => s.campaign?.settings.milestoneLeveling ?? true);
  const builder = useBuilderData();
  const index = useRulesIndex();
  const edit = useSheetEdit();
  const [choice, setChoice] = useState<Choice>({ kind: 'existing', index: 0 });
  const [hpMethod, setHpMethod] = useState<'average' | 'roll'>('average');
  const [hpFace, setHpFace] = useState('');
  const [subclassId, setSubclassId] = useState('');
  const [allowAnyway, setAllowAnyway] = useState(false);
  const [featChoice, setFeatChoice] = useState<FeatChoice>({ kind: 'dm' });
  const [featAllowed, setFeatAllowed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ level: LevelUpResult; uses: string[]; choice: string | null } | null>(null);
  const faceId = useId();

  if (result) return <Summary result={result.level} uses={result.uses} choice={result.choice} onClose={onClose} />;
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
  const findSpell = (name: string) => index?.findByName(name, { kind: 'spell', campaignId });
  const plan = planLevel(character, classes, choice, subclassId, findSpell);
  const { existing, option, className, classLevel, hitDie } = plan;
  const conMod = abilityModifier(character.abilityScores.con);
  const average = Math.max(1, hitDie / 2 + 1 + conMod);
  const physical = rollMode === 'physical';
  const face = Number(hpFace);
  const faceValid = Number.isInteger(face) && face >= 1 && face <= hitDie;
  const bookMissing = !option && existing?.ref ? `Class data for ${existing.name} comes from “${existing.ref.sourceTitle}”, which isn't on this device; your DM can fill in its features.` : null;

  const multiclassing = choice.kind === 'new';
  const prereqClasses = multiclassing
    ? [option, ...character.classes.map((cl) => classOptionFor(cl, classes))].filter((c): c is ClassOption => Boolean(c))
    : [];
  const prereqMet = prereqClasses.every((c) => meetsPrimary(c, character.abilityScores));
  const picks: FeatPick[] = plan.trigger
    ? featChoices(plan.trigger.kind, builder.data?.feats ?? [], { cls: option, characterLevel: level + 1, have: character.features })
    : [];
  const xpNeeded = XP_THRESHOLDS[level];
  const shortOnXp = !milestone && character.xp < xpNeeded;

  const canApply =
    Boolean(className) &&
    (!multiclassing || prereqMet || allowAnyway) &&
    (!plan.needsSubclass || Boolean(plan.sub)) &&
    (!plan.trigger || featChoiceReady(featChoice, featAllowed, character.abilityScores)) &&
    !(hpMethod === 'roll' && physical && !faceValid) &&
    !busy;

  const apply = async () => {
    if (!canApply) return;
    setBusy(true);
    const opts = levelUpOptions(plan, builder.data, hpMethod === 'average' ? 'average' : physical ? { fixed: face } : 'roll');
    const outcome: { result: LevelUpResult | null; uses: string[]; choice: string | null } = { result: null, uses: [], choice: null };
    const saved = await edit((c) => {
      const r = levelUp(c, opts);
      if (r.character === c) {
        return { character: c, notice: null, warning: r.events.find((e) => e.type === 'warning')?.message ?? 'Could not level up.' };
      }
      const before = new Set(c.features.map((f) => f.id));
      const addedIds = new Set(r.character.features.filter((f) => !before.has(f.id)).map((f) => f.id));
      let next = addSubclassSpells(r.character, plan.spells.spells);
      const warnings: string[] = [];
      let increases: ScoreIncrease[] = [];
      if (plan.trigger) {
        const applied = applyFeatChoice(next, plan.trigger, featChoice, { className, classLevel, addedIds, equipment: builder.data?.equipment });
        next = applied.character;
        increases = applied.increases;
        warnings.push(...applied.warnings);
      }
      // The older-edition notes of what this level brings (a 2014 subclass chosen now, a book's class or feat) join the sheet's (B6).
      next = withAdaptationNotes(next, [option, plan.sub, featChoice.kind === 'feat' ? featChoice.pick.feat : undefined]);
      // Existing features grow too: Rage, Second Wind, Lay on Hands, Breath Weapon, Draconic Flight at 5…
      const refreshed = refreshFeatureUses(next, builder.data);
      const uses = featureUseChanges(c, refreshed);
      // Named for what took effect (a score at 20 can't rise), and a choice that changed nothing keeps its reminder.
      const chose = featChoiceNotice(featChoice, increases);
      const reminders = plan.trigger ? dropChoiceReminder(r.reminders, plan.trigger.kind, featChoice, increases) : r.reminders;
      const added = featChoice.kind === 'dm' ? plan.features.map((f) => f.name) : refreshed.features.filter((f) => !before.has(f.id)).map((f) => f.name);
      const spells = plan.spells.spells.map((s) => s.name);
      const hpGained = refreshed.hp.max - c.hp.max;
      outcome.result = { ...r, character: refreshed, hpGained, reminders };
      outcome.uses = uses;
      outcome.choice = choiceSummary(featChoice, increases);
      return {
        character: refreshed,
        notice: levelUpNotice({
          className,
          classLevel,
          newLevel: r.newLevel,
          hpGained,
          hpMax: refreshed.hp.max,
          ...(plan.needsSubclass && plan.sub ? { subclass: plan.sub.name } : {}),
          added,
          extras: [...(chose ? [chose] : []), ...(spells.length ? [`always prepared: ${spells.join(', ')}`] : [])],
          uses,
          reminders,
        }),
        warning: warnings.join(' ') || null,
      };
    });
    setBusy(false);
    if (saved && outcome.result) setResult({ level: { ...outcome.result, character: saved }, uses: outcome.uses, choice: outcome.choice });
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
            choice={featChoice}
            onChoice={(next) => {
              // "My DM allows it" belongs to one feat: picking another clears it.
              if (next.kind !== 'feat' || featChoice.kind !== 'feat' || next.pick.id !== featChoice.pick.id) setFeatAllowed(false);
              setFeatChoice(next);
            }}
            scores={character.abilityScores}
            dmAllows={featAllowed}
            onDmAllows={setFeatAllowed}
          />
        </Section>
      )}

      <GainedSection plan={plan} bookMissing={bookMissing} />

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
