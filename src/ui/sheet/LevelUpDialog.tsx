/**
 * Manual level-up from the sheet (the DM can also level the character with its level_up tool).
 * Choose the class (or multiclass, with the 2024 13+ primary-ability prerequisite), the HP method,
 * and a subclass at level 3; see the features gained; apply through the engine's levelUp, then
 * re-read every feature's uses at the new level (Rage, Lay on Hands, Breath Weapon…).
 */
import { useId, useState, type ReactNode } from 'react';
import { ArrowBigUpDash, Check, TriangleAlert } from 'lucide-react';
import { XP_THRESHOLDS, abilityModifier, characterLevel, levelUp, proficiencyBonus, type LevelUpOptions, type LevelUpResult } from '@/engine';
import { useBuilderData } from '@/data';
import { nameKey } from '@/lib/id';
import { cn } from '@/lib/cn';
import { useGame } from '@/state/gameStore';
import { ABILITY_NAMES, type Ability, type Character, type ClassFeatureDef, type ClassOption, type Feature } from '@/types';
import { Markdown } from '@/ui/components/Markdown';
import { Badge, Button, Dialog, EmptyState, Input, Segmented, Select, Spinner } from '@/ui/components/ui';
import { RadioCards } from '@/ui/builder/BuilderParts';
import { featuresAtLevel, subclassFeaturesAtLevel } from '@/ui/builder/classFeatures';
import { inferFeatureUses } from '@/ui/builder/featureUses';
import { classOptionFor, featureUseChanges, refreshFeatureUses } from '@/ui/builder/leveling';
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

/** 2024 multiclassing: Fighter needs STR *or* DEX 13; every other class needs all its primary abilities at 13. */
export function meetsPrimary(cls: Pick<ClassOption, 'name' | 'primaryAbilities'>, scores: Character['abilityScores']): boolean {
  if (!cls.primaryAbilities.length) return true;
  const ok = (a: Ability) => scores[a] >= 13;
  return nameKey(cls.name) === 'fighter' ? cls.primaryAbilities.some(ok) : cls.primaryAbilities.every(ok);
}

/** The features gained at a class level, as sheet features (placeholder "Subclass feature" rows skipped). */
export function gainedFeatures(
  cls: ClassOption,
  classLevel: number,
  subclassName: string | undefined,
  ctx: { scores: Character['abilityScores']; characterLevel: number },
): Omit<Feature, 'id'>[] {
  const usesCtx = { level: classLevel, proficiencyBonus: proficiencyBonus(ctx.characterLevel), scores: ctx.scores, cls };
  const sub = cls.subclasses.find((s) => s.name === subclassName);
  const toFeature = (def: ClassFeatureDef, source: Feature['source'], label: string): Omit<Feature, 'id'> => {
    const uses = inferFeatureUses(def.name, def.description, usesCtx);
    return { name: def.name, source, sourceName: `${label} ${classLevel}`, description: def.description, ...(uses ? { uses } : {}) };
  };
  return [
    ...featuresAtLevel(cls, classLevel)
      .filter((d) => !/^subclass feature$/i.test(d.name.trim()))
      .map((d) => toFeature(d, 'class', cls.name)),
    ...subclassFeaturesAtLevel(sub, classLevel).map((d) => toFeature(d, 'subclass', sub!.name)),
  ];
}

function levelUpNotice(
  r: LevelUpResult,
  className: string,
  classLevel: number,
  subclass: string | undefined,
  added: string[],
  uses: string[],
): string {
  const parts = [`Player leveled up to ${className} ${classLevel} (character level ${r.newLevel}): +${r.hpGained} HP (max ${r.character.hp.max})`];
  if (subclass) parts.push(`subclass ${subclass}`);
  if (added.length) parts.push(`new features: ${added.join(', ')}`);
  if (uses.length) parts.push(`feature uses now: ${uses.join(', ')}`);
  if (r.reminders.length) parts.push(`still to choose: ${r.reminders.join(' ')}`);
  return parts.join('; ');
}

// ---------------------------------------------------------------------------
// Form
// ---------------------------------------------------------------------------

type Choice = { kind: 'existing'; index: number } | { kind: 'new'; classId: string };

function choiceKey(choice: Choice): string {
  return choice.kind === 'existing' ? `existing:${choice.index}` : `new:${choice.classId}`;
}

function Prereq({ cls, scores }: { cls: ClassOption; scores: Character['abilityScores'] }) {
  const met = meetsPrimary(cls, scores);
  const joiner = nameKey(cls.name) === 'fighter' ? ' or ' : ' and ';
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

function Summary({ result, uses, onClose }: { result: LevelUpResult; uses: string[]; onClose: () => void }) {
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

function LevelUpForm({ onClose }: { onClose: () => void }) {
  const character = useGame((s) => s.character);
  const rollMode = useGame((s) => s.campaign?.settings.playerRollMode ?? 'prompt');
  const milestone = useGame((s) => s.campaign?.settings.milestoneLeveling ?? true);
  const builder = useBuilderData();
  const edit = useSheetEdit();
  const [choice, setChoice] = useState<Choice>({ kind: 'existing', index: 0 });
  const [hpMethod, setHpMethod] = useState<'average' | 'roll'>('average');
  const [hpFace, setHpFace] = useState('');
  const [subclass, setSubclass] = useState('');
  const [allowAnyway, setAllowAnyway] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ level: LevelUpResult; uses: string[] } | null>(null);
  const faceId = useId();
  const multiId = useId();

  if (result) return <Summary result={result.level} uses={result.uses} onClose={onClose} />;
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
  const existing = choice.kind === 'existing' ? character.classes[choice.index] : undefined;
  const option = existing ? classOptionFor(existing, classes) : classes.find((c) => choice.kind === 'new' && c.id === choice.classId);
  const className = existing?.name ?? option?.name ?? '';
  const classLevel = (existing?.level ?? 0) + 1;
  const hitDie = existing?.hitDie ?? option?.hitDie ?? 8;
  const conMod = abilityModifier(character.abilityScores.con);
  const average = Math.max(1, hitDie / 2 + 1 + conMod);
  const physical = rollMode === 'physical';
  const face = Number(hpFace);
  const faceValid = Number.isInteger(face) && face >= 1 && face <= hitDie;

  const multiclassing = choice.kind === 'new';
  const prereqClasses = multiclassing
    ? [option, ...character.classes.map((cl) => classOptionFor(cl, classes))].filter((c): c is ClassOption => Boolean(c))
    : [];
  const prereqMet = prereqClasses.every((c) => meetsPrimary(c, character.abilityScores));

  const needsSubclass = Boolean(option && classLevel >= option.subclassLevel && !existing?.subclass && option.subclasses.length);
  const subclassName = needsSubclass ? subclass : existing?.subclass;
  const features = option ? gainedFeatures(option, classLevel, subclassName, { scores: character.abilityScores, characterLevel: level + 1 }) : [];
  const xpNeeded = XP_THRESHOLDS[level];
  const shortOnXp = !milestone && character.xp < xpNeeded;

  const canApply =
    Boolean(className) &&
    (!multiclassing || prereqMet || allowAnyway) &&
    (!needsSubclass || Boolean(subclass)) &&
    !(hpMethod === 'roll' && physical && !faceValid) &&
    !busy;

  const apply = async () => {
    if (!canApply) return;
    setBusy(true);
    const opts: LevelUpOptions = {
      className,
      ...(option ? { classId: option.id, hitDie: option.hitDie, casterType: option.casterType } : {}),
      ...(option?.spellcastingAbility ? { spellcastingAbility: option.spellcastingAbility } : {}),
      ...(needsSubclass && subclass ? { subclass } : {}),
      hpMethod: hpMethod === 'average' ? 'average' : physical ? { fixed: face } : 'roll',
      newFeatures: features,
      // Lets level-up recompute AC (Unarmored Defense, Draconic Resilience...) against real armor stats.
      ...(builder.data ? { equipment: builder.data.equipment } : {}),
    };
    const outcome: { result: LevelUpResult | null; uses: string[] } = { result: null, uses: [] };
    const saved = await edit((c) => {
      const r = levelUp(c, opts);
      if (r.character === c) {
        return { character: c, notice: null, warning: r.events.find((e) => e.type === 'warning')?.message ?? 'Could not level up.' };
      }
      // Existing features grow too: Rage, Second Wind, Lay on Hands, Breath Weapon, Draconic Flight at 5…
      const refreshed = refreshFeatureUses(r.character, builder.data);
      const uses = featureUseChanges(c, refreshed);
      outcome.result = { ...r, character: refreshed };
      outcome.uses = uses;
      return {
        character: refreshed,
        notice: levelUpNotice(r, className, classLevel, needsSubclass ? subclass : undefined, features.map((f) => f.name), uses),
      };
    });
    setBusy(false);
    if (saved && outcome.result) setResult({ level: { ...outcome.result, character: saved }, uses: outcome.uses });
  };

  const existingOptions = character.classes.map((cl, index) => ({
    value: choiceKey({ kind: 'existing', index }),
    title: `${cl.name} ${cl.level} → ${cl.level + 1}`,
    meta: <span>{cl.subclass ?? `d${cl.hitDie} hit die`}</span>,
  }));
  const multiclassOptions = classes.filter((o) => !character.classes.some((cl) => classOptionFor(cl, classes)?.id === o.id));
  const selectChoice = (next: Choice) => {
    setChoice(next);
    setSubclass('');
    setAllowAnyway(false);
  };

  return (
    <div className="flex flex-col gap-5">
      {builder.error && <p className="text-sm text-danger">Class data couldn't load ({builder.error}); you can still level your current class.</p>}
      <Section title="Class">
        <RadioCards
          label="Class to gain a level in"
          value={choice.kind === 'existing' ? choiceKey(choice) : null}
          onChange={(key) => selectChoice({ kind: 'existing', index: Number(key.split(':')[1]) })}
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
              onChange={(e) => (e.target.value ? selectChoice({ kind: 'new', classId: e.target.value }) : selectChoice({ kind: 'existing', index: 0 }))}
              className="h-9 sm:w-64"
            >
              <option value="">Choose a new class…</option>
              {multiclassOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name} (d{o.hitDie})
                </option>
              ))}
            </Select>
          </div>
        )}
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
                <input type="checkbox" checked={allowAnyway} onChange={(e) => setAllowAnyway(e.target.checked)} className="size-4 accent-[var(--accent)]" />
                My DM allows it anyway
              </label>
            )}
          </div>
        )}
        {shortOnXp && (
          <p className="text-sm text-gold">
            You have {character.xp.toLocaleString()} XP; level {level + 1} needs {xpNeeded.toLocaleString()} XP. Level up only if your DM agrees.
          </p>
        )}
      </Section>

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

      {needsSubclass && option && (
        <Section title={`${option.name} subclass`}>
          <div role="radiogroup" aria-label="Subclass" className="flex flex-col gap-2">
            {option.subclasses.map((s) => (
              <button
                key={s.id}
                type="button"
                role="radio"
                aria-checked={subclass === s.name}
                onClick={() => setSubclass(s.name)}
                className={cn('rounded-xl border px-3 py-2 text-left', subclass === s.name ? 'border-accent bg-accent-soft' : 'border-border hover:bg-surface-2')}
              >
                <span className="font-medium">{s.name}</span>
                {s.summary && <span className="block text-xs text-muted">{s.summary}</span>}
              </button>
            ))}
          </div>
        </Section>
      )}

      <Section title={`New at ${className || 'this'} level ${classLevel}`}>
        {features.length ? (
          <ul className="flex flex-col gap-1.5">
            {features.map((f) => (
              <li key={`${f.source}-${f.name}`} className="rounded-xl border border-border bg-surface-2">
                <details>
                  <summary className="flex cursor-pointer items-center justify-between gap-2 px-3 py-2 text-sm font-medium">
                    <span>{f.name}</span>
                    {f.source === 'subclass' && <Badge tone="arcane">Subclass</Badge>}
                  </summary>
                  <div className="border-t border-border px-3 py-2">
                    <Markdown className="text-sm">{f.description || 'No description.'}</Markdown>
                  </div>
                </details>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">{option ? 'No new features listed at this level.' : 'Feature details are unavailable; the DM will fill you in.'}</p>
        )}
      </Section>

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
