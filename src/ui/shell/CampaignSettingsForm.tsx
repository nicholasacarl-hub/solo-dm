/**
 * The campaign "table rules" form: story (tone, setting, notes), rules (fidelity, homebrew,
 * difficulty, narration, roll mode, leveling, DM rolls, rules sources) and safety (lines & veils).
 * Used by the New Campaign wizard (one section per step) and by the Play screen's "Table rules"
 * dialog (all sections). Every option carries a one-line explanation.
 */
import { useId, useState } from 'react';
import { Link } from 'react-router';
import { ShieldCheck } from 'lucide-react';
import type { CampaignSettings } from '@/types';
import { useLibrarySources } from '@/storage';
import { Field, Input, SectionTitle, Textarea } from '@/ui/components/ui';
import { OptionCards } from '@/ui/components/OptionCards';
import { TagInput } from '@/ui/components/TagInput';
import { ErrorBoundary } from '@/ui/components/ErrorBoundary';
import {
  DIFFICULTY_OPTIONS,
  DM_ROLLS_OPTIONS,
  HOMEBREW_OPTIONS,
  LEVELING_OPTIONS,
  NARRATION_OPTIONS,
  ROLL_MODE_OPTIONS,
  RULES_FIDELITY_OPTIONS,
  SAFETY_PRESETS,
  TONE_PRESETS,
  findTonePreset,
  tonePreset,
  toneText,
  type TonePresetId,
} from './campaignOptions';
import { plural } from './format';

export type CampaignSettingsSection = 'story' | 'rules' | 'safety';

export interface CampaignSettingsFormProps {
  value: CampaignSettings;
  onChange: (next: CampaignSettings) => void;
  /** Which groups to show; default all. */
  sections?: Array<CampaignSettingsSection>;
  /** Validation messages to show beside fields (the wizard validates before moving on). */
  errors?: { tone?: string };
}

type Patch = (patch: Partial<CampaignSettings>) => void;

const ALL_SECTIONS: CampaignSettingsSection[] = ['story', 'rules', 'safety'];
const SECTION_TITLES: Record<CampaignSettingsSection, string> = {
  story: 'Story',
  rules: 'Table rules',
  safety: 'Safety',
};

export function CampaignSettingsForm({ value, onChange, sections = ALL_SECTIONS, errors }: CampaignSettingsFormProps) {
  const patch: Patch = (p) => onChange({ ...value, ...p });
  const showTitles = sections.length > 1;
  return (
    <div className="flex flex-col gap-10">
      {sections.map((section) => (
        <div key={section} className="flex flex-col gap-6">
          {showTitles && <SectionTitle className="mb-0">{SECTION_TITLES[section]}</SectionTitle>}
          {section === 'story' && <StoryFields value={value} patch={patch} toneError={errors?.tone} />}
          {section === 'rules' && <RulesFields value={value} patch={patch} />}
          {section === 'safety' && <SafetyFields value={value} patch={patch} />}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Story
// ---------------------------------------------------------------------------

type ToneChoice = TonePresetId | 'custom';

const TONE_OPTIONS: { value: ToneChoice; label: string; description: string }[] = [
  ...TONE_PRESETS.map((p) => ({ value: p.id, label: p.label, description: p.description })),
  { value: 'custom', label: 'Custom', description: 'Describe your own blend.' },
];

function StoryFields({ value, patch, toneError }: { value: CampaignSettings; patch: Patch; toneError?: string }) {
  const id = useId();
  const preset = findTonePreset(value.tone);
  const selected: ToneChoice = preset?.id ?? 'custom';
  // Remember custom text while the player tries presets, so switching back restores it.
  const [customDraft, setCustomDraft] = useState(preset ? '' : value.tone);

  const chooseTone = (choice: ToneChoice) => {
    patch({ tone: choice === 'custom' ? customDraft : toneText(tonePreset(choice)) });
  };

  return (
    <>
      <div>
        <OptionCards
          legend="Tone"
          hint="Sets the mood of the narration and the kind of trouble you’ll find."
          columns={2}
          value={selected}
          options={TONE_OPTIONS}
          onChange={chooseTone}
        />
        {selected === 'custom' && (
          <Field
            className="mt-3"
            label="Your tone"
            htmlFor={`${id}-tone`}
            error={toneError}
            hint="For example: “Folk horror with a dry sense of humor.”"
          >
            <Input
              id={`${id}-tone`}
              data-field="tone"
              value={value.tone}
              maxLength={200}
              aria-invalid={toneError ? true : undefined}
              className="aria-[invalid=true]:border-danger"
              placeholder="Describe the mood you want"
              onChange={(e) => {
                setCustomDraft(e.target.value);
                patch({ tone: e.target.value });
              }}
            />
          </Field>
        )}
        {toneError && selected !== 'custom' && <p className="mt-2 text-xs text-danger">{toneError}</p>}
      </div>

      <Field
        label="Setting notes"
        htmlFor={`${id}-setting`}
        hint="Places, factions, themes, inspirations. Optional: the DM builds on whatever you give it."
      >
        <Textarea
          id={`${id}-setting`}
          rows={3}
          maxLength={4000}
          value={value.setting}
          placeholder="A coastal frontier town built over drowned ruins…"
          onChange={(e) => patch({ setting: e.target.value })}
        />
      </Field>

      <Field
        label="Notes for the DM"
        htmlFor={`${id}-notes`}
        hint="What you enjoy and what you’d like more or less of. Optional."
      >
        <Textarea
          id={`${id}-notes`}
          rows={2}
          maxLength={2000}
          value={value.playerNotes ?? ''}
          placeholder="I love puzzles and talking my way out of trouble."
          onChange={(e) => patch({ playerNotes: e.target.value })}
        />
      </Field>
    </>
  );
}

// ---------------------------------------------------------------------------
// Table rules
// ---------------------------------------------------------------------------

function RulesFields({ value, patch }: { value: CampaignSettings; patch: Patch }) {
  return (
    <>
      <OptionCards
        legend="Rules fidelity"
        hint="How closely the DM sticks to the 2024 rules."
        columns={3}
        value={value.rulesFidelity}
        options={RULES_FIDELITY_OPTIONS}
        onChange={(rulesFidelity) => patch({ rulesFidelity })}
      />
      <OptionCards
        legend="Homebrew freedom"
        hint="How much the DM may invent or change. Homebrew is saved where you can read, edit or veto it."
        columns={2}
        value={value.homebrewFreedom}
        options={HOMEBREW_OPTIONS}
        onChange={(homebrewFreedom) => patch({ homebrewFreedom })}
      />
      <OptionCards
        legend="Difficulty"
        hint="How hard the world pushes back."
        columns={2}
        value={value.difficulty}
        options={DIFFICULTY_OPTIONS}
        onChange={(difficulty) => patch({ difficulty })}
      />
      <OptionCards
        legend="Narration length"
        columns={3}
        value={value.narrationLength}
        options={NARRATION_OPTIONS}
        onChange={(narrationLength) => patch({ narrationLength })}
      />
      <OptionCards
        legend="Your rolls"
        hint="How you roll checks, saving throws, attacks and damage."
        columns={3}
        value={value.playerRollMode}
        options={ROLL_MODE_OPTIONS}
        onChange={(playerRollMode) => patch({ playerRollMode })}
      />
      <OptionCards
        legend="Leveling"
        columns={2}
        value={value.milestoneLeveling ? 'milestone' : 'xp'}
        options={LEVELING_OPTIONS}
        onChange={(choice) => patch({ milestoneLeveling: choice === 'milestone' })}
      />
      <OptionCards
        legend="DM rolls"
        hint="Monster attacks, secret checks and random tables."
        columns={2}
        value={value.showDmRolls ? 'shown' : 'hidden'}
        options={DM_ROLLS_OPTIONS}
        onChange={(choice) => patch({ showDmRolls: choice === 'shown' })}
      />
      <ErrorBoundary
        fallback={() => <p className="text-xs text-muted">Your imported books couldn’t be listed right now.</p>}
      >
        <SourcesPicker value={value.enabledSources} onChange={(enabledSources) => patch({ enabledSources })} />
      </ErrorBoundary>
    </>
  );
}

function SourcesPicker({ value, onChange }: { value: string[]; onChange: (next: string[]) => void }) {
  const sources = useLibrarySources();
  const imports = (sources ?? []).filter((s) => s.kind === 'import');

  const toggle = (sourceId: string, on: boolean) => {
    const rest = value.filter((v) => v !== sourceId);
    onChange(on ? [...rest, sourceId] : rest);
  };

  const row = 'flex items-center gap-3 rounded-xl border border-border bg-surface px-3 py-2.5';
  return (
    <fieldset className="min-w-0">
      <legend className="text-sm font-medium">Rules sources</legend>
      <p className="mt-0.5 text-xs text-muted">What the DM may consult in this campaign. The SRD is always on.</p>
      <ul className="mt-2 flex flex-col gap-2">
        <li>
          <label className={row}>
            <input type="checkbox" checked disabled className="size-4 accent-accent" />
            <span className="flex-1 text-sm font-medium">SRD 5.2.1</span>
            <span className="text-xs text-muted">Always on</span>
          </label>
        </li>
        {imports.map((source) => (
          <li key={source.id}>
            <label className={`${row} cursor-pointer hover:border-faint`}>
              <input
                type="checkbox"
                className="size-4 accent-accent"
                checked={value.includes(source.id)}
                onChange={(e) => toggle(source.id, e.target.checked)}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{source.title}</span>
                <span className="block text-xs text-muted">
                  {plural(source.entryCount, 'entry', 'entries')}
                  {!source.enabled && ' · switched off in the Library'}
                </span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      {sources !== undefined && imports.length === 0 && (
        <p className="mt-2 text-xs text-muted">
          Own other books?{' '}
          <Link to="/library?tab=mine" className="text-accent underline underline-offset-2">
            Import them in the Library
          </Link>{' '}
          and switch them on here.
        </p>
      )}
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// Safety
// ---------------------------------------------------------------------------

const sameTopic = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;
const withoutTopics = (list: string[], remove: string[]) => list.filter((t) => !remove.some((r) => sameTopic(r, t)));

function SafetyFields({ value, patch }: { value: CampaignSettings; patch: Patch }) {
  const id = useId();
  // A topic is either a line or a veil: adding it to one list takes it off the other.
  const setLines = (lines: string[]) => patch({ lines, veils: withoutTopics(value.veils, lines) });
  const setVeils = (veils: string[]) => patch({ veils, lines: withoutTopics(value.lines, veils) });

  return (
    <>
      <p className="text-sm text-muted">
        Tell the DM what to keep out of your story. You can change these at any time during play.
      </p>
      <div>
        <label htmlFor={`${id}-lines`} className="text-sm font-medium">
          Lines
        </label>
        <p id={`${id}-lines-hint`} className="mt-0.5 mb-2 text-xs text-muted">
          Hard limits. These never appear in the story, not even off-screen.
        </p>
        <TagInput
          id={`${id}-lines`}
          label="Lines"
          describedBy={`${id}-lines-hint`}
          value={value.lines}
          onChange={setLines}
          placeholder="Add a topic, e.g. drowning"
          suggestions={withoutTopics([...SAFETY_PRESETS], value.veils)}
          suggestionsLabel="Common lines"
        />
      </div>
      <div>
        <label htmlFor={`${id}-veils`} className="text-sm font-medium">
          Veils
        </label>
        <p id={`${id}-veils-hint`} className="mt-0.5 mb-2 text-xs text-muted">
          Fade to black. These can happen, but off-screen and without detail.
        </p>
        <TagInput
          id={`${id}-veils`}
          label="Veils"
          describedBy={`${id}-veils-hint`}
          value={value.veils}
          onChange={setVeils}
          placeholder="Add a topic, e.g. torture"
          suggestions={withoutTopics([...SAFETY_PRESETS], value.lines)}
          suggestionsLabel="Common veils"
        />
      </div>
      <div className="flex gap-3 rounded-xl border border-border bg-surface-2 px-4 py-3 text-sm">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
        <p>
          <span className="font-medium">The X-card is always on the table.</span>{' '}
          <span className="text-muted">
            During play, tap it and the DM steers away from the current content, no explanation needed.
          </span>
        </p>
      </div>
    </>
  );
}
