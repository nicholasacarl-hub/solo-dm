/**
 * The review form's bespoke editors (spec §4.5): fields whose shape a plain input can't hold — speeds,
 * ability scores, CR, a spell's area, attunement, item bonuses, a feat's increase, a background's
 * three abilities and Origin feat, lineages, always-prepared spells and the class editors — and the
 * dispatcher from FORM_SPECS' editor keys to them.
 */
import { useId } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { cn } from '@/lib/cn';
import { ABILITY_NAMES, type Ability, type CreatureSize, type SpeciesData, type SpellArea, type StructuredDataByKind } from '@/types';
import { TagInput } from '@/ui/components/TagInput';
import { Button, IconButton, Input, Select } from '@/ui/components/ui';
import { fieldId, useRecordForm } from './context';
import { CheckField, ChipsField, FieldShell, NumberField, SelectField, TextField, useFieldProps, type Option } from './controls';
import { CR_OPTIONS, XP_BY_CR, pbForCr } from './draft';
import { ABILITY_OPTIONS, CASTER_TYPES, RARITIES, SIZE_OPTIONS, SKILL_OPTIONS, type EditorKey } from './formSpecs';
import { LevelTableEditor } from './LevelTableEditor';
import { PackageEditor } from './PackageEditor';
import { ParentClassSelect, parentChoices } from './ParentClassSelect';
import { getPath, isNamed } from './paths';
import { LegacyFeatureEditor, RowsEditor } from './RowsEditor';
import { TextSpanChip } from './TextSpanChip';
import { TOUCH } from '../touch';

const ABBR: Readonly<Record<Ability, string>> = { str: 'STR', dex: 'DEX', con: 'CON', int: 'INT', wis: 'WIS', cha: 'CHA' };

/** A segmented choice whose values aren't strings (true/false/null/numbers). */
function ValueSegment<T>({ path, label, options, value, onChange, hint }: {
  path: string;
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange(v: T): void;
  hint?: string;
}) {
  const form = useRecordForm();
  const name = useId();
  return (
    <FieldShell path={path} label={label} as="legend" hint={hint}>
      <div className="inline-flex max-w-full flex-wrap rounded-xl border border-border bg-surface-2 p-0.5">
        {options.map((o, i) => (
          <label
            key={o.label}
            className={cn(
              'flex min-h-9 cursor-pointer items-center rounded-[10px] px-3 text-sm font-medium text-muted transition-colors hover:text-text',
              'has-[:checked]:bg-surface has-[:checked]:text-text has-[:checked]:shadow-sm has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring',
              TOUCH,
            )}
          >
            <input
              type="radio"
              name={name}
              id={i === 0 ? fieldId(path) : undefined}
              data-field-path={path}
              checked={Object.is(value, o.value)}
              onFocus={() => form.onFocusField(path)}
              onChange={() => onChange(o.value)}
              className="sr-only"
            />
            {o.label}
          </label>
        ))}
      </div>
    </FieldShell>
  );
}

function MonsterSizeEditor() {
  const form = useRecordForm();
  const sizes = (getPath(form.data, 'sizes') as CreatureSize[] | undefined) ?? [];
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <SelectField path="size" label="Size" options={SIZE_OPTIONS} />
      <details open={sizes.length > 1} className="text-sm">
        <summary className="cursor-pointer text-xs font-medium text-muted">It can be more than one size</summary>
        <div className="mt-2">
          <ChipsField
            path="sizes"
            label="Sizes it can be"
            options={SIZE_OPTIONS}
            hint="“Medium or Small”: pick both. The first is used on the map."
          />
        </div>
      </details>
    </div>
  );
}

function SpeedsEditor() {
  return (
    <FieldShell path="speeds" label="Speed (ft)" as="legend">
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
        <NumberField path="speeds.walk" label="Walk" min={0} max={300} />
        <NumberField path="speeds.fly" label="Fly" min={0} max={300} />
        <NumberField path="speeds.swim" label="Swim" min={0} max={300} />
        <NumberField path="speeds.climb" label="Climb" min={0} max={300} />
        <NumberField path="speeds.burrow" label="Burrow" min={0} max={300} />
        <div className="flex items-end">
          <CheckField path="speeds.hover" label="Hover" />
        </div>
      </div>
    </FieldShell>
  );
}

const modifier = (score: unknown) => (typeof score === 'number' && Number.isFinite(score) ? Math.floor((score - 10) / 2) : null);

function AbilityScoresEditor() {
  const form = useRecordForm();
  return (
    <FieldShell path="abilities" label="Ability scores" as="legend">
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
        {(Object.keys(ABBR) as Ability[]).map((a) => {
          const mod = modifier(getPath(form.data, `abilities.${a}`));
          return (
            <div key={a} className="flex flex-col gap-0.5">
              <NumberField
                path={`abilities.${a}`}
                label={ABBR[a]}
                min={1}
                max={30}
                hint={mod === null ? undefined : `${mod >= 0 ? '+' : ''}${mod}`}
              />
              <span className="sr-only">{ABILITY_NAMES[a]}</span>
            </div>
          );
        })}
      </div>
    </FieldShell>
  );
}

function CrEditor() {
  const form = useRecordForm();
  const cr = String(getPath(form.data, 'cr') ?? '0');
  return (
    <div className="grid grid-cols-3 gap-2">
      <SelectField path="cr" label="CR" options={CR_OPTIONS.map((c) => ({ value: c, label: c }))} />
      <NumberField path="xp" label="XP" min={0} hint={XP_BY_CR[cr] !== undefined ? `CR ${cr}: ${XP_BY_CR[cr].toLocaleString('en')}` : undefined} />
      <NumberField path="pb" label="PB" min={2} max={9} hint={`CR ${cr}: +${pbForCr(cr)}`} />
    </div>
  );
}

const AREA_SHAPES: readonly Option[] = [
  { value: 'sphere', label: 'Sphere' },
  { value: 'cylinder', label: 'Cylinder' },
  { value: 'cone', label: 'Cone' },
  { value: 'line', label: 'Line' },
  { value: 'cube', label: 'Cube' },
  { value: 'emanation', label: 'Emanation' },
];
const SIZE_LABEL: Readonly<Record<SpellArea['shape'], string>> = {
  sphere: 'Radius', cylinder: 'Radius', emanation: 'Distance', cone: 'Length', line: 'Length', cube: 'Side',
};

function SpellAreaEditor() {
  const form = useRecordForm();
  const area = getPath(form.data, 'area') as SpellArea | undefined;
  const props = useFieldProps('area');
  return (
    <FieldShell path="area" label="Area" as="legend" hint="What the battle map's template uses.">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={props.id} className="text-xs font-medium text-muted">
            Shape
          </label>
          <Select
            {...props}
            value={area?.shape ?? ''}
            onChange={(e) => {
              const shape = e.target.value as SpellArea['shape'] | '';
              if (!shape) form.set('area', undefined);
              else form.set('area', { shape, sizeFt: area?.sizeFt ?? 10, ...(shape === 'line' ? { widthFt: area?.widthFt ?? 5 } : {}) });
            }}
          >
            <option value="">No area</option>
            {AREA_SHAPES.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </div>
        {area && <NumberField path="area.sizeFt" label={SIZE_LABEL[area.shape]} unit="ft" min={5} max={1000} />}
        {area?.shape === 'line' && <NumberField path="area.widthFt" label="Width" unit="ft" min={5} max={60} />}
        {area?.shape === 'cylinder' && <NumberField path="area.heightFt" label="Height" unit="ft" min={5} max={1000} />}
      </div>
    </FieldShell>
  );
}

function CantripDiceEditor() {
  const form = useRecordForm();
  const value = (getPath(form.data, 'damageByCharacterLevel') as Record<string, string> | undefined) ?? {};
  const set = (level: string, dice: string) => {
    const next = { ...value };
    if (dice.trim()) next[level] = dice;
    else delete next[level];
    form.set('damageByCharacterLevel', Object.keys(next).length ? next : undefined);
  };
  return (
    <FieldShell path="damageByCharacterLevel" label="Cantrip damage at character levels" as="legend">
      <div className="grid grid-cols-3 gap-2">
        {['5', '11', '17'].map((level, i) => (
          <label key={level} className="flex flex-col gap-1 text-xs font-medium text-muted">
            Level {level}
            <Input
              id={i === 0 ? fieldId('damageByCharacterLevel') : undefined}
              data-field-path="damageByCharacterLevel"
              value={value[level] ?? ''}
              placeholder={`${i + 2}d10`}
              onFocus={() => form.onFocusField('damageByCharacterLevel')}
              onChange={(e) => set(level, e.target.value)}
            />
          </label>
        ))}
      </div>
    </FieldShell>
  );
}

function RarityEditor() {
  const form = useRecordForm();
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <SelectField path="rarity" label="Rarity" options={RARITIES} />
      {getPath(form.data, 'rarity') === 'varies' && <TextField path="rarityText" label="Rarity as printed" optional placeholder="Rarity varies" />}
    </div>
  );
}

function AttunementEditor() {
  const form = useRecordForm();
  const raw = getPath(form.data, 'attunement');
  const mode = raw === true ? 'required' : typeof raw === 'string' ? 'by' : 'none';
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <ValueSegment<'none' | 'required' | 'by'>
        path="attunement"
        label="Attunement"
        value={mode}
        options={[
          { value: 'none', label: 'None' },
          { value: 'required', label: 'Required' },
          { value: 'by', label: 'Required by…' },
        ]}
        onChange={(v) => form.set('attunement', v === 'none' ? false : v === 'required' ? true : typeof raw === 'string' ? raw : 'by a ')}
      />
      {mode === 'by' && (
        <label className="flex flex-col gap-1 text-xs font-medium text-muted">
          Who can attune (shown, never enforced)
          <Input
            data-field-path="attunement"
            value={typeof raw === 'string' ? raw : ''}
            placeholder="by a Wizard"
            onFocus={() => form.onFocusField('attunement')}
            onChange={(e) => form.set('attunement', e.target.value || true)}
          />
        </label>
      )}
    </div>
  );
}

const ANY_ITEMS = ['Any Light Armor', 'Any Medium Armor', 'Any Heavy Armor', 'Any Medium or Heavy Armor', 'Any Simple Weapon', 'Any Martial Weapon', 'Any Weapon'];

function BaseItemEditor() {
  const form = useRecordForm();
  const listId = useId();
  const catalog = (form.builder?.equipment ?? []).filter((e) => !e.magic && (e.category === 'armor' || e.category === 'weapon' || e.category === 'shield'));
  return (
    <>
      <TextField
        path="baseItem"
        label="Base item"
        optional
        list={listId}
        placeholder="Chain Mail"
        hint="The armor or weapon it is. Matching one in the gear list gives the item that armor's AC."
      />
      <datalist id={listId}>
        {[...catalog.map((e) => e.name), ...ANY_ITEMS].map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
    </>
  );
}

function BonusesEditor() {
  const form = useRecordForm();
  const props = useFieldProps('bonuses.acOnlyWhen');
  const bonuses = getPath(form.data, 'bonuses') as Record<string, unknown> | undefined;
  return (
    <FieldShell path="bonuses" label="Flat bonuses while worn or wielded" as="legend" hint="Leave a bonus empty when the item has none.">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <NumberField path="bonuses.ac" label="AC" signed min={1} max={5} />
        <NumberField path="bonuses.savingThrows" label="Saving throws" signed min={1} max={5} />
        <NumberField path="bonuses.attack" label="Attack rolls" signed min={1} max={5} />
        <NumberField path="bonuses.damage" label="Damage rolls" signed min={1} max={5} />
      </div>
      {bonuses?.ac !== undefined && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={props.id} className="text-xs font-medium text-muted">
            The AC bonus applies
          </label>
          <Select
            {...props}
            value={String(bonuses.acOnlyWhen ?? '')}
            onChange={(e) => form.set('bonuses.acOnlyWhen', e.target.value || undefined)}
          >
            <option value="">Always</option>
            <option value="no-armor">Only while not wearing armor</option>
            <option value="no-armor-no-shield">Only without armor or a shield</option>
          </Select>
        </div>
      )}
      <p className="text-xs text-muted">Attack and damage bonuses are shown on the item; add them to your rolls.</p>
    </FieldShell>
  );
}

function DexCapEditor() {
  const form = useRecordForm();
  const raw = getPath(form.data, 'dexCap');
  const value = raw === null ? null : typeof raw === 'number' ? raw : undefined;
  return (
    <ValueSegment<number | null | undefined>
      path="dexCap"
      label="Dexterity bonus"
      value={value}
      options={[
        { value: null, label: 'All of it' },
        { value: 2, label: 'Up to +2' },
        { value: 0, label: 'None' },
      ]}
      onChange={(v) => form.set('dexCap', v)}
    />
  );
}

function AbilityIncreaseEditor() {
  const form = useRecordForm();
  const value = getPath(form.data, 'abilityIncrease') as StructuredDataByKind['feat']['abilityIncrease'];
  const abilities = value?.abilities ?? [];
  const toggle = (a: Ability) => {
    const next = abilities.includes(a) ? abilities.filter((x) => x !== a) : (Object.keys(ABBR) as Ability[]).filter((x) => x === a || abilities.includes(x));
    form.set('abilityIncrease', next.length ? { abilities: next, amount: value?.amount ?? 1 } : undefined);
  };
  return (
    <FieldShell path="abilityIncrease" label="Increase one of these abilities" as="legend" hint="Leave all off when the feat raises no ability.">
      <div className="flex flex-wrap gap-1.5">
        {ABILITY_OPTIONS.map((o, i) => {
          const pressed = abilities.includes(o.value as Ability);
          return (
            <button
              key={o.value}
              type="button"
              id={i === 0 ? fieldId('abilityIncrease') : undefined}
              data-field-path="abilityIncrease"
              aria-pressed={pressed}
              onFocus={() => form.onFocusField('abilityIncrease')}
              onClick={() => toggle(o.value as Ability)}
              className={cn(
                'min-h-9 rounded-lg border px-2.5 text-sm transition-colors',
                TOUCH,
                pressed ? 'border-accent bg-accent-soft text-text' : 'border-border bg-surface text-muted hover:text-text',
              )}
            >
              {o.label}
            </button>
          );
        })}
      </div>
      {value && (
        <ValueSegment<1 | 2>
          path="abilityIncrease.amount"
          label="By"
          value={value.amount}
          options={[
            { value: 1, label: '+1' },
            { value: 2, label: '+2' },
          ]}
          onChange={(amount) => form.set('abilityIncrease', { ...value, amount })}
        />
      )}
    </FieldShell>
  );
}

function BackgroundAbilitiesEditor() {
  const form = useRecordForm();
  const value = (getPath(form.data, 'abilityScores') as Ability[] | undefined) ?? [];
  const any = value.length === 0;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <CheckFieldRaw
        label="The player chooses any three"
        checked={any}
        onChange={(on) => form.set('abilityScores', on ? [] : ['str', 'dex', 'con'])}
      />
      {!any && <ChipsField path="abilityScores" label="Ability scores (pick three)" options={ABILITY_OPTIONS} max={3} />}
    </div>
  );
}

function CheckFieldRaw({ label, checked, onChange }: { label: string; checked: boolean; onChange(v: boolean): void }) {
  return (
    <label className="flex min-h-11 cursor-pointer items-center gap-2.5 text-sm font-medium">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="size-4 accent-[var(--accent)]" />
      {label}
    </label>
  );
}

function OriginFeatEditor() {
  const form = useRecordForm();
  const props = useFieldProps('feat');
  const value = String(getPath(form.data, 'feat') ?? '');
  const names = new Set<string>();
  for (const f of form.builder?.feats ?? []) if (f.category === 'origin') names.add(f.name);
  for (const r of form.bookRecords) {
    if (r.kind === 'feat' && r.status !== 'rejected' && (r.data as StructuredDataByKind['feat'] | null)?.category === 'origin') names.add(r.name);
  }
  const sorted = [...names].sort((a, b) => a.localeCompare(b));
  return (
    <FieldShell path="feat" label="Origin feat" hint={value && !names.has(value) ? `“${value}” isn't an Origin feat the app knows yet.` : undefined}>
      <Select {...props} value={value} onChange={(e) => form.set('feat', e.target.value)}>
        <option value="">The player chooses one</option>
        {value && !names.has(value) && <option value={value}>{value}</option>}
        {sorted.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </Select>
    </FieldShell>
  );
}

function LineageTraitEditor() {
  const form = useRecordForm();
  const traits = ((getPath(form.data, 'traits') as SpeciesData['traits'] | undefined) ?? []).map((t) => t.name).filter(Boolean);
  return (
    <SelectField
      path="lineageTrait"
      label="Trait that offers the lineages"
      optional
      emptyLabel="None"
      options={traits.map((t) => ({ value: t, label: t }))}
    />
  );
}

function LegacyIncreasesEditor() {
  const form = useRecordForm();
  const increases = (getPath(form.data, 'legacyAbilityIncreases') as SpeciesData['legacyAbilityIncreases']) ?? [];
  const languages = (getPath(form.data, 'languages') as string[] | undefined) ?? [];
  const checked = isNamed(form.check, 'legacyAbilityIncreases');
  return (
    <div className="flex flex-col gap-2 text-sm" data-field-path="legacyAbilityIncreases">
      <p className="font-medium">
        Set aside{checked && <span className="sr-only"> (check)</span>}
      </p>
      {increases.length > 0 ? (
        <p>
          Ability increases it prints, for reference:{' '}
          {increases.map((x) => `+${x.amount} ${x.ability === 'any' ? 'any ability' : ABILITY_NAMES[x.ability]}`).join(', ')}. In the 2024
          rules your background sets ability scores, so these aren't applied.
        </p>
      ) : (
        <p className="text-muted">No ability increases printed.</p>
      )}
      {languages.length > 0 && <p>Languages it lists: {languages.join(', ')}. They're suggested for the two language choices, never added.</p>}
    </div>
  );
}

function AlwaysPreparedEditor() {
  const form = useRecordForm();
  const rows = (getPath(form.data, 'alwaysPreparedSpells') as { level: number; spells: string[] }[] | undefined) ?? [];
  const write = (next: typeof rows) => form.set('alwaysPreparedSpells', next.length ? next : undefined);
  return (
    <FieldShell path="alwaysPreparedSpells" label="Always-prepared spells, by class level" as="legend">
      {rows.length === 0 && <p className="text-sm text-muted">None.</p>}
      <ol className="flex flex-col gap-2">
        {rows.map((row, i) => (
          <li key={i} className="flex items-start gap-2 rounded-xl border border-border bg-surface p-2.5">
            <label className="flex w-20 shrink-0 flex-col gap-1 text-xs font-medium text-muted">
              Level
              <Input
                inputMode="numeric"
                data-field-path={`alwaysPreparedSpells.${i}.level`}
                value={Number.isFinite(row.level) ? String(row.level) : ''}
                onChange={(e) => write(rows.map((r, j) => (j === i ? { ...r, level: Number(e.target.value) } : r)))}
              />
            </label>
            <div className="min-w-0 flex-1">
              <TagInput
                label={`Spells at level ${row.level}`}
                value={row.spells}
                onChange={(spells) => write(rows.map((r, j) => (j === i ? { ...r, spells } : r)))}
              />
            </div>
            <IconButton label={`Remove the level ${row.level} spells`} size="sm" onClick={() => write(rows.filter((_, j) => j !== i))}>
              <Trash2 className="size-4" aria-hidden />
            </IconButton>
          </li>
        ))}
      </ol>
      <div>
        <Button size="sm" icon={<Plus className="size-4" aria-hidden />} onClick={() => write([...rows, { level: 1, spells: [] }])}>
          Add a level
        </Button>
      </div>
    </FieldShell>
  );
}

function PrimaryAbilitiesEditor() {
  const form = useRecordForm();
  const rule = getPath(form.data, 'primaryAbilityRule');
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <ChipsField path="primaryAbilities" label="Primary ability" options={ABILITY_OPTIONS} />
      <CheckFieldRaw
        label="Any one of them is enough (“Strength or Dexterity”)"
        checked={rule === 'any'}
        onChange={(on) => form.set('primaryAbilityRule', on ? 'any' : 'all')}
      />
    </div>
  );
}

function SkillChoicesEditor() {
  return (
    <FieldShell path="skillChoices" label="Skill proficiencies" as="legend" hint="Pick none to let the player choose from every skill.">
      <div className="w-32">
        <NumberField path="skillChoices.count" label="How many" min={0} max={18} />
      </div>
      <ChipsField path="skillChoices.from" label="Chosen from" options={SKILL_OPTIONS} />
    </FieldShell>
  );
}

function CastingEditor() {
  const form = useRecordForm();
  const caster = getPath(form.data, 'casterType');
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      <SelectField path="casterType" label="Spellcasting" options={CASTER_TYPES} />
      {caster !== 'none' && <SelectField path="spellcastingAbility" label="Spellcasting ability" options={ABILITY_OPTIONS} optional />}
    </div>
  );
}

function SpanEditor({ path, label }: { path: string; label: string }) {
  const form = useRecordForm();
  const span = getPath(form.data, path) as StructuredDataByKind['feat']['text'] | undefined;
  const props = useFieldProps(path);
  if (!span) return null;
  return (
    <FieldShell path={path} label={label} as="legend">
      <TextSpanChip
        span={span}
        blocks={form.blocks}
        entriesById={form.entriesById}
        disabled={form.disabled}
        id={props.id}
        fieldPath={path}
        describedBy={props['aria-describedby']}
        onFocus={props.onFocus}
        onChange={(next) => form.set(path, next)}
      />
    </FieldShell>
  );
}

function ParentClassEditor() {
  const form = useRecordForm();
  const parentClass = String(getPath(form.data, 'parentClass') ?? '');
  const choices = parentChoices(form.builder, form.sourceId, form.bookRecords);
  return (
    <ParentClassSelect
      value={form.parentClassId}
      onChange={form.setParentClassId}
      parentClass={parentClass}
      sourceId={form.sourceId}
      choices={choices}
      checked={isNamed(form.check, 'parentClassId') || isNamed(form.check, 'parentClass')}
      issue={form.issues.parentClassId}
      disabled={form.disabled}
      onFocus={() => form.onFocusField('parentClass')}
    />
  );
}

/** FORM_SPECS editor key → component. */
export function Editor({ editor, path, label }: { editor: EditorKey; path: string; label: string }) {
  switch (editor) {
    case 'monsterSize':
      return <MonsterSizeEditor />;
    case 'speeds':
      return <SpeedsEditor />;
    case 'abilityScores':
      return <AbilityScoresEditor />;
    case 'cr':
      return <CrEditor />;
    case 'spellArea':
      return <SpellAreaEditor />;
    case 'cantripDice':
      return <CantripDiceEditor />;
    case 'rarity':
      return <RarityEditor />;
    case 'attunement':
      return <AttunementEditor />;
    case 'baseItem':
      return <BaseItemEditor />;
    case 'bonuses':
      return <BonusesEditor />;
    case 'dexCap':
      return <DexCapEditor />;
    case 'abilityIncrease':
      return <AbilityIncreaseEditor />;
    case 'backgroundAbilities':
      return <BackgroundAbilitiesEditor />;
    case 'originFeat':
      return <OriginFeatEditor />;
    case 'span':
      return <SpanEditor path={path} label={label} />;
    case 'traits':
      return <RowsEditor path={path} label={label} noun="trait" />;
    case 'lineageTrait':
      return <LineageTraitEditor />;
    case 'lineages':
      return <RowsEditor path={path} label={label} noun="lineage" optional />;
    case 'legacyFeature':
      return <LegacyFeatureEditor path={path} label={label} />;
    case 'legacyIncreases':
      return <LegacyIncreasesEditor />;
    case 'features':
      return <RowsEditor path={path} label={label} noun="feature" withLevel />;
    case 'packages':
      return <PackageEditor path={path} label={label} />;
    case 'levelTable':
      return <LevelTableEditor path={path} label={label} />;
    case 'parentClass':
      return <ParentClassEditor />;
    case 'alwaysPrepared':
      return <AlwaysPreparedEditor />;
    case 'primaryAbilities':
      return <PrimaryAbilitiesEditor />;
    case 'skillChoices':
      return <SkillChoicesEditor />;
    case 'casting':
      return <CastingEditor />;
  }
}
