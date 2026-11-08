/**
 * Route: #/new — a three-step wizard (premise & tone → table rules → safety), then on to the
 * character builder.
 */
import { useEffect, useId, useRef, useState, type FormEvent, type RefObject } from 'react';
import { Link, useBlocker, useNavigate } from 'react-router';
import { ArrowLeft, ArrowRight, Check, Dices, RefreshCw } from 'lucide-react';
import { defaultArtStyle } from '@/images';
import { createCampaign, type NewCampaignInput } from '@/storage';
import type { CampaignSettings } from '@/types';
import { cn } from '@/lib/cn';
import { Button, Card, Dialog, Field, Input, Textarea } from '@/ui/components/ui';
import { ButtonLink } from '@/ui/components/ButtonLink';
import { toast } from '@/ui/components/toast';
import { CampaignSettingsForm } from '@/ui/shell/CampaignSettingsForm';
import {
  BATTLE_MAPS_SHORT,
  COVER_COLORS,
  COVER_EMOJIS,
  DEFAULT_COVER_COLOR,
  DEFAULT_COVER_EMOJI,
  DIFFICULTY_OPTIONS,
  HOMEBREW_OPTIONS,
  ROLL_MODE_OPTIONS,
  RULES_FIDELITY_OPTIONS,
  TRANSFORMATION_SHORT,
  battleMapsMode,
  coverTint,
  defaultCampaignSettings,
  suggestCampaignName,
  toneLabel,
  tonePreset,
  toneText,
  transformationsMode,
} from '@/ui/shell/campaignOptions';
import { randomPremise } from '@/ui/shell/premises';
import { errorMessage, plural } from '@/ui/shell/format';
import { Page, PageHeader, useDocumentTitle } from '@/ui/shell/Page';
import { askToKeepSaves } from '@/ui/shell/persistentStorage';

// ---------------------------------------------------------------------------
// Draft model & validation (exported for tests)
// ---------------------------------------------------------------------------

export interface CampaignDraft {
  name: string;
  premise: string;
  coverEmoji: string;
  coverColor: string;
  settings: CampaignSettings;
}

export interface CampaignDraftErrors {
  name?: string;
  tone?: string;
}

export function newCampaignDraft(): CampaignDraft {
  return {
    name: '',
    premise: '',
    coverEmoji: DEFAULT_COVER_EMOJI,
    coverColor: DEFAULT_COVER_COLOR,
    settings: defaultCampaignSettings(),
  };
}

export function validatePremiseStep(draft: CampaignDraft): CampaignDraftErrors {
  const errors: CampaignDraftErrors = {};
  if (!draft.name.trim()) errors.name = 'Give your campaign a name.';
  if (!draft.settings.tone.trim()) errors.tone = 'Pick a tone, or describe your own.';
  return errors;
}

export function toCampaignInput(draft: CampaignDraft): NewCampaignInput {
  const s = draft.settings;
  const tone = s.tone.trim();
  return {
    name: draft.name.trim(),
    premise: draft.premise.trim(),
    coverEmoji: draft.coverEmoji,
    coverColor: draft.coverColor,
    settings: {
      ...s,
      tone,
      setting: s.setting.trim(),
      playerNotes: s.playerNotes?.trim() || undefined,
      transformations: transformationsMode(s),
      battleMaps: battleMapsMode(s),
      // Fixed at creation (from the tone unless the player chose one), so every picture matches.
      artStyle: s.artStyle?.trim() || defaultArtStyle(tone),
    },
  };
}

const hasErrors = (errors: CampaignDraftErrors) => Boolean(errors.name || errors.tone);

const STEPS = [
  { id: 'premise', label: 'Premise & tone', description: 'What kind of story do you want to play?' },
  { id: 'rules', label: 'Table rules', description: 'How your DM runs the game. You can change these during play.' },
  { id: 'safety', label: 'Safety', description: 'Optional. Skip it if nothing is off the table for you.' },
] as const;

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export function NewCampaignScreen() {
  useDocumentTitle('New campaign');
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<CampaignDraft>(newCampaignDraft);
  const [errors, setErrors] = useState<CampaignDraftErrors>({});
  const [creating, setCreating] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const movedStep = useRef(false);
  const leaving = useRef(false);

  const dirty = draft.name.trim() !== '' || draft.premise.trim() !== '' || step > 0;
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty && !leaving.current && currentLocation.pathname !== nextLocation.pathname,
  );

  useEffect(() => {
    if (!movedStep.current) return;
    window.scrollTo({ top: 0 });
    headingRef.current?.focus({ preventScroll: true });
  }, [step]);

  const patchDraft = (patch: Partial<CampaignDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    if (patch.name?.trim()) setErrors((e) => ({ ...e, name: undefined }));
  };

  const patchSettings = (settings: CampaignSettings) => {
    setDraft((d) => ({ ...d, settings }));
    if (settings.tone.trim()) setErrors((e) => ({ ...e, tone: undefined }));
  };

  /** Validate step 1; focus the first problem. */
  const checkPremise = (): boolean => {
    const found = validatePremiseStep(draft);
    setErrors(found);
    if (found.name) nameRef.current?.focus();
    else if (found.tone) formRef.current?.querySelector<HTMLElement>('[data-field="tone"]')?.focus();
    return !hasErrors(found);
  };

  const goTo = (target: number) => {
    if (target === step || target < 0 || target >= STEPS.length) return;
    if (target > step && step === 0 && !checkPremise()) return;
    movedStep.current = true;
    setStep(target);
  };

  const surprise = () => {
    const seed = randomPremise(draft.name);
    setDraft((d) => ({
      ...d,
      name: seed.name,
      premise: seed.premise,
      coverEmoji: seed.emoji,
      coverColor: seed.color,
      settings: { ...d.settings, tone: toneText(tonePreset(seed.tone)), setting: seed.setting },
    }));
    setErrors({});
  };

  const create = async () => {
    if (creating) return;
    if (hasErrors(validatePremiseStep(draft))) {
      goTo(0);
      return;
    }
    setCreating(true);
    try {
      const campaign = await createCampaign(toCampaignInput(draft));
      askToKeepSaves();
      toast.success(`“${campaign.name}” is ready. Now, your hero.`);
      leaving.current = true;
      navigate(`/campaign/${campaign.id}/character`);
    } catch (error) {
      toast.error(errorMessage(error, 'Could not create the campaign.'));
      setCreating(false);
    }
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (step < STEPS.length - 1) goTo(step + 1);
    else void create();
  };

  const current = STEPS[step];
  const isLast = step === STEPS.length - 1;

  return (
    <Page width="narrow">
      <PageHeader
        title="New campaign"
        eyebrow={
          <Link to="/" className="inline-flex items-center gap-1 text-sm text-muted hover:text-text">
            <ArrowLeft className="size-4" aria-hidden />
            Campaigns
          </Link>
        }
      />
      <Stepper current={step} onSelect={goTo} />

      <form ref={formRef} noValidate onSubmit={onSubmit} className="mt-6">
        <Card className="p-4 sm:p-6">
          <div className="mb-6 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 ref={headingRef} tabIndex={-1} className="text-lg font-semibold focus:outline-none">
                {current.label}
              </h2>
              <p className="mt-0.5 text-sm text-muted">{current.description}</p>
            </div>
            {step === 0 && (
              <Button size="sm" icon={<Dices className="size-4" aria-hidden />} onClick={surprise}>
                Surprise me
              </Button>
            )}
          </div>

          {step === 0 && (
            <PremiseStep
              draft={draft}
              errors={errors}
              nameRef={nameRef}
              onDraft={patchDraft}
              onSettings={patchSettings}
            />
          )}
          {step === 1 && <CampaignSettingsForm sections={['rules']} value={draft.settings} onChange={patchSettings} />}
          {step === 2 && (
            <div className="flex flex-col gap-8">
              <CampaignSettingsForm sections={['safety']} value={draft.settings} onChange={patchSettings} />
              <ReadySummary draft={draft} />
            </div>
          )}
        </Card>

        <div className="mt-5 flex items-center justify-between gap-3">
          {step === 0 ? (
            <ButtonLink to="/" variant="ghost">
              Cancel
            </ButtonLink>
          ) : (
            <Button variant="ghost" icon={<ArrowLeft className="size-4" aria-hidden />} onClick={() => goTo(step - 1)}>
              Back
            </Button>
          )}
          <Button type="submit" variant="primary" loading={creating}>
            {isLast ? (
              'Create campaign'
            ) : (
              <>
                Next: {STEPS[step + 1].label}
                <ArrowRight className="size-4" aria-hidden />
              </>
            )}
          </Button>
        </div>
      </form>

      <Dialog
        open={blocker.state === 'blocked'}
        onClose={() => blocker.reset?.()}
        size="sm"
        title="Leave without creating?"
        footer={
          <>
            <Button variant="ghost" onClick={() => blocker.reset?.()}>
              Keep editing
            </Button>
            <Button variant="danger" onClick={() => blocker.proceed?.()}>
              Discard
            </Button>
          </>
        }
      >
        <p className="text-sm">This campaign hasn’t been created yet. If you leave now, your choices will be lost.</p>
      </Dialog>
    </Page>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function Stepper({ current, onSelect }: { current: number; onSelect: (step: number) => void }) {
  return (
    <nav aria-label="Campaign setup">
      <ol className="grid grid-cols-3 gap-2 sm:gap-3">
        {STEPS.map((s, i) => {
          const done = i < current;
          const active = i === current;
          return (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => onSelect(i)}
                aria-current={active ? 'step' : undefined}
                className="group flex w-full flex-col gap-2 rounded-lg pt-1 text-left"
              >
                <span className={cn('h-1 rounded-full transition-colors', i <= current ? 'bg-accent' : 'bg-surface-3')} />
                <span
                  className={cn(
                    'flex items-center gap-1 text-xs font-medium sm:text-sm',
                    active ? 'text-text' : 'text-muted group-hover:text-text',
                  )}
                >
                  {done && <Check className="size-3.5 shrink-0 text-accent" aria-hidden />}
                  <span className="truncate">{s.label}</span>
                  {done && <span className="sr-only">(done)</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function PremiseStep({
  draft,
  errors,
  nameRef,
  onDraft,
  onSettings,
}: {
  draft: CampaignDraft;
  errors: CampaignDraftErrors;
  nameRef: RefObject<HTMLInputElement | null>;
  onDraft: (patch: Partial<CampaignDraft>) => void;
  onSettings: (settings: CampaignSettings) => void;
}) {
  const id = useId();
  const [suggestion, setSuggestion] = useState(() => suggestCampaignName());
  const nameError = errors.name;

  return (
    <div className="flex flex-col gap-6">
      <Field label="Campaign name" htmlFor={`${id}-name`}>
        <Input
          ref={nameRef}
          id={`${id}-name`}
          value={draft.name}
          maxLength={80}
          autoComplete="off"
          placeholder={suggestion}
          aria-invalid={nameError ? true : undefined}
          aria-describedby={nameError ? `${id}-name-error` : undefined}
          className="aria-[invalid=true]:border-danger"
          onChange={(e) => onDraft({ name: e.target.value })}
        />
        {nameError && (
          <p id={`${id}-name-error`} className="text-xs text-danger">
            {nameError}
          </p>
        )}
        <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted">
          <span>Need a name? Try</span>
          <button
            type="button"
            className="rounded font-medium text-accent underline-offset-2 hover:underline"
            onClick={() => onDraft({ name: suggestion })}
          >
            {suggestion}
          </button>
          <button
            type="button"
            aria-label="Suggest another name"
            title="Suggest another name"
            className="grid size-6 place-items-center rounded-md text-faint hover:bg-surface-2 hover:text-text"
            onClick={() => setSuggestion((s) => suggestCampaignName(s))}
          >
            <RefreshCw className="size-3.5" aria-hidden />
          </button>
        </p>
      </Field>

      <Field
        label="Premise"
        htmlFor={`${id}-premise`}
        hint="A hook, a mystery, a place, a problem. Leave it blank and the DM will pitch one when you start."
      >
        <Textarea
          id={`${id}-premise`}
          rows={4}
          maxLength={4000}
          value={draft.premise}
          placeholder="A lighthouse keeper vanished the night the old lantern lit itself…"
          onChange={(e) => onDraft({ premise: e.target.value })}
        />
      </Field>

      <CampaignSettingsForm sections={['story']} value={draft.settings} onChange={onSettings} errors={{ tone: errors.tone }} />

      <CoverPicker
        name={draft.name}
        emoji={draft.coverEmoji}
        color={draft.coverColor}
        onChange={(patch) => onDraft(patch)}
      />
    </div>
  );
}

function CoverPicker({
  name,
  emoji,
  color,
  onChange,
}: {
  name: string;
  emoji: string;
  color: string;
  onChange: (patch: Pick<Partial<CampaignDraft>, 'coverEmoji' | 'coverColor'>) => void;
}) {
  const id = useId();
  const choice =
    'cursor-pointer has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring';
  return (
    <div className="flex flex-col gap-3">
      <div>
        <p className="text-sm font-medium">Cover</p>
        <p className="mt-0.5 text-xs text-muted">How this campaign looks on its save slot.</p>
      </div>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <div
          className="flex items-center gap-3 rounded-xl border border-border border-t-4 bg-surface-2 p-3 sm:w-56 sm:shrink-0"
          style={{ borderTopColor: color }}
        >
          <div
            aria-hidden
            className="grid size-12 shrink-0 place-items-center rounded-xl text-2xl leading-none"
            style={{ background: coverTint(color) }}
          >
            {emoji}
          </div>
          <div className="min-w-0">
            <p className="truncate font-serif font-semibold">{name.trim() || 'Your campaign'}</p>
            <p className="text-xs text-muted">Preview</p>
          </div>
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <fieldset>
            <legend className="sr-only">Cover emoji</legend>
            <div className="grid max-w-xs grid-cols-8 gap-1">
              {COVER_EMOJIS.map((e) => (
                <label
                  key={e}
                  className={cn(
                    choice,
                    'grid aspect-square place-items-center rounded-lg text-xl leading-none transition-colors hover:bg-surface-2',
                    'has-[:checked]:bg-accent-soft has-[:checked]:ring-2 has-[:checked]:ring-accent',
                  )}
                >
                  <input
                    type="radio"
                    name={`${id}-emoji`}
                    value={e}
                    checked={emoji === e}
                    onChange={() => onChange({ coverEmoji: e })}
                    className="sr-only"
                  />
                  {e}
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset>
            <legend className="sr-only">Accent color</legend>
            <div className="flex flex-wrap gap-2 sm:gap-2.5">
              {COVER_COLORS.map((c) => (
                <label
                  key={c.value}
                  title={c.name}
                  className={cn(
                    choice,
                    'grid size-7 place-items-center rounded-full ring-offset-2 ring-offset-surface transition-shadow sm:size-8',
                    'has-[:checked]:ring-2 has-[:checked]:ring-text',
                  )}
                  style={{ background: c.value }}
                >
                  <input
                    type="radio"
                    name={`${id}-color`}
                    value={c.value}
                    checked={color === c.value}
                    onChange={() => onChange({ coverColor: c.value })}
                    className="sr-only"
                  />
                  <span className="sr-only">{c.name}</span>
                  {color === c.value && <Check className="size-4 text-white drop-shadow" aria-hidden />}
                </label>
              ))}
            </div>
          </fieldset>
        </div>
      </div>
    </div>
  );
}

const labelOf = <T extends string>(options: readonly { value: T; label: string }[], value: T) =>
  options.find((o) => o.value === value)?.label ?? value;

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function ReadySummary({ draft }: { draft: CampaignDraft }) {
  const s = draft.settings;
  const rows: [string, string][] = [
    ['Campaign', `${draft.coverEmoji} ${draft.name.trim()}`],
    ['Tone', toneLabel(s.tone)],
    [
      'Rules',
      `${labelOf(RULES_FIDELITY_OPTIONS, s.rulesFidelity)} · ${labelOf(HOMEBREW_OPTIONS, s.homebrewFreedom)} homebrew · ${labelOf(DIFFICULTY_OPTIONS, s.difficulty)}`,
    ],
    [
      'Rolls',
      `${labelOf(ROLL_MODE_OPTIONS, s.playerRollMode)} · DM rolls ${s.showDmRolls ? 'shown' : 'hidden'} · ${s.milestoneLeveling ? 'milestones' : 'XP'}`,
    ],
    ['Transformations', capitalize(TRANSFORMATION_SHORT[transformationsMode(s)])],
    ['Battle maps', capitalize(BATTLE_MAPS_SHORT[battleMapsMode(s)])],
    ['Safety', `${plural(s.lines.length, 'line')}, ${plural(s.veils.length, 'veil')}`],
  ];
  return (
    <section aria-label="Summary" className="rounded-xl border border-border bg-surface-2 p-4">
      <p className="text-sm font-semibold">Ready when you are</p>
      <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
        {rows.map(([term, detail]) => (
          <div key={term} className="contents">
            <dt className="text-muted">{term}</dt>
            <dd className="[overflow-wrap:anywhere]">{detail}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-xs text-muted">Next you’ll create your character.</p>
    </section>
  );
}
