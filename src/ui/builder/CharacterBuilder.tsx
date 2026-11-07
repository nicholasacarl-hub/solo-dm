/**
 * The character-builder wizard (2024 order): Class → Background → Species → Ability scores →
 * Skills → Equipment → Spells (casters) → Details → Review, with a live preview and
 * "Let the DM decide" on every step. The draft persists in sessionStorage per campaign.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, Eye, Wand2 } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { BuilderData, Campaign, Character } from '@/types';
import { toast } from '@/ui/components/toast';
import { Button, Dialog } from '@/ui/components/ui';
import { letDmBuildAll, letDmDecide } from './autofill';
import {
  activeSteps,
  buildCharacter,
  firstIncompleteStep,
  previewStats,
  spellPlan,
  validateStep,
  type BuilderContext,
  type PreviewStats,
} from './logic';
import { PreviewCard } from './PreviewCard';
import { AbilitiesStep } from './steps/AbilitiesStep';
import { BackgroundStep } from './steps/BackgroundStep';
import { ClassStep } from './steps/ClassStep';
import { DetailsStep } from './steps/DetailsStep';
import { EquipmentStep } from './steps/EquipmentStep';
import { ReviewStep } from './steps/ReviewStep';
import { SkillsStep } from './steps/SkillsStep';
import { SpeciesStep } from './steps/SpeciesStep';
import { SpellsStep } from './steps/SpellsStep';
import type { StepProps } from './steps/stepTypes';
import { BUILDER_STEPS, STEP_LABELS, type BuilderStep } from './types';
import { clearDraft, useBuilderDraft } from './useBuilderDraft';
import type { SpellOptionsState } from './useSpellOptions';

export interface CharacterBuilderProps {
  campaign: Campaign;
  data: BuilderData;
  spells: SpellOptionsState;
  /** Keep this id when rebuilding an existing character from scratch. */
  characterId?: string;
  onSave: (character: Character) => Promise<void>;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function useBuilt(draftCtx: { draft: StepProps['draft']; ctx: BuilderContext; campaignId: string; characterId?: string }) {
  const { draft, ctx, campaignId, characterId } = draftCtx;
  return useMemo((): { built: Character | null; stats: PreviewStats | null } => {
    try {
      const built = buildCharacter(draft, ctx, { campaignId, id: characterId });
      return { built, stats: built.classes.length ? previewStats(built) : null };
    } catch {
      return { built: null, stats: null };
    }
  }, [draft, ctx, campaignId, characterId]);
}

function StepNav({
  steps,
  current,
  complete,
  onSelect,
}: {
  steps: BuilderStep[];
  current: BuilderStep;
  complete: (step: BuilderStep) => boolean;
  onSelect: (step: BuilderStep) => void;
}) {
  return (
    <nav aria-label="Character creation steps" className="-mx-4 min-w-0 overflow-x-auto px-4 scroll-thin lg:mx-0 lg:px-0">
      <ol className="flex gap-1.5 lg:flex-col">
        {steps.map((step, i) => {
          const isCurrent = step === current;
          const done = step !== 'review' && complete(step);
          return (
            <li key={step} className="shrink-0">
              <button
                type="button"
                aria-current={isCurrent ? 'step' : undefined}
                onClick={() => onSelect(step)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm font-medium whitespace-nowrap transition-colors',
                  isCurrent ? 'bg-surface-2 text-text shadow-sm ring-1 ring-border' : 'text-muted hover:bg-surface-2/70 hover:text-text',
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    'grid size-6 shrink-0 place-items-center rounded-full border text-xs tabular-nums',
                    done ? 'border-success bg-success text-white' : isCurrent ? 'border-accent text-accent' : 'border-border',
                  )}
                >
                  {done ? <Check className="size-3.5" /> : i + 1}
                </span>
                {STEP_LABELS[step]}
                {done && <span className="sr-only">(done)</span>}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export function CharacterBuilder({ campaign, data, spells, characterId, onSave }: CharacterBuilderProps) {
  const { draft, setDraft } = useBuilderDraft(campaign.id);
  const ctx = useMemo<BuilderContext>(() => ({ data, spells: spells.spells }), [data, spells.spells]);
  const steps = activeSteps(draft, data);
  const step: BuilderStep = steps.includes(draft.step)
    ? draft.step
    : ([...steps].reverse().find((s) => BUILDER_STEPS.indexOf(s) < BUILDER_STEPS.indexOf(draft.step)) ?? 'class');
  const { built, stats } = useBuilt({ draft, ctx, campaignId: campaign.id, characterId });
  const [saving, setSaving] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const lastStep = useRef(step);

  // Move focus to the new step (not on first render) so keyboard and screen-reader users follow along.
  useEffect(() => {
    if (lastStep.current === step) return;
    lastStep.current = step;
    contentRef.current?.focus({ preventScroll: true });
    contentRef.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  }, [step]);

  const index = steps.indexOf(step);
  const prev = steps[index - 1];
  const next = steps[index + 1];
  const issues = validateStep(step, draft, ctx);
  const allIssues = validateStep('review', draft, ctx);
  const casterNeedsSpells = spellPlan(draft, data).casting && spells.loading;

  const goTo = (s: BuilderStep) => setDraft((d) => ({ ...d, step: s }));
  const onDmDecide = () => setDraft((d) => letDmDecide(step, d, ctx));
  const onDmBuildAll = () => {
    setDraft((d) => letDmBuildAll(d, ctx));
    toast.info('The DM filled in the rest. Review and change anything you like.');
  };

  const save = async () => {
    const missing = firstIncompleteStep(draft, ctx);
    if (missing) {
      goTo(missing);
      return;
    }
    setSaving(true);
    try {
      const character = buildCharacter(draft, ctx, { campaignId: campaign.id, id: characterId });
      await onSave(character);
      clearDraft(campaign.id);
    } catch (err) {
      toast.error(`Couldn't save your character: ${errorText(err)}`);
      setSaving(false);
    }
  };

  const stepProps: StepProps = { draft, setDraft, ctx, onDmDecide, built, goTo };
  const content = (() => {
    switch (step) {
      case 'class':
        return <ClassStep {...stepProps} />;
      case 'background':
        return <BackgroundStep {...stepProps} />;
      case 'species':
        return <SpeciesStep {...stepProps} />;
      case 'abilities':
        return <AbilitiesStep {...stepProps} />;
      case 'skills':
        return <SkillsStep {...stepProps} />;
      case 'equipment':
        return <EquipmentStep {...stepProps} />;
      case 'spells':
        return <SpellsStep {...stepProps} spellsLoading={spells.loading} spellsError={spells.error} />;
      case 'details':
        return <DetailsStep {...stepProps} />;
      case 'review':
        return <ReviewStep {...stepProps} onDmDecide={onDmBuildAll} />;
    }
  })();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted">
          Step {index + 1} of {steps.length}
          {issues.length === 0 && step !== 'review' && <span className="text-success"> · done</span>}
        </p>
        {step !== 'review' && (
          <Button
            variant="arcane"
            size="sm"
            icon={<Wand2 className="size-4" aria-hidden />}
            onClick={onDmBuildAll}
            disabled={casterNeedsSpells}
            title="Fill every open choice with sensible picks and jump to Review"
          >
            Let the DM build the rest
          </Button>
        )}
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[13rem_minmax(0,1fr)_19rem]">
        <StepNav steps={steps} current={step} complete={(s) => validateStep(s, draft, ctx).length === 0} onSelect={goTo} />
        <div ref={contentRef} tabIndex={-1} className="flex min-w-0 scroll-mt-20 flex-col gap-6 focus:outline-none">
          {content}
        </div>
        <aside className="hidden lg:block" aria-label="Preview">
          <div className="sticky top-20">
            <PreviewCard built={built} stats={stats} />
          </div>
        </aside>
      </div>
      <div className="sticky bottom-0 z-20 -mx-4 mt-2 border-t border-border bg-bg px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:-mx-6 sm:px-6">
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={() => prev && goTo(prev)} disabled={!prev} icon={<ArrowLeft className="size-4" aria-hidden />}>
            Back
          </Button>
          <Button variant="secondary" className="lg:hidden" onClick={() => setPreviewOpen(true)} icon={<Eye className="size-4" aria-hidden />}>
            <span className="tabular-nums">{stats ? `HP ${stats.hp} · AC ${stats.ac}` : 'Preview'}</span>
          </Button>
          <div className="ml-auto flex items-center gap-2">
            {step === 'review' ? (
              <Button variant="primary" size="lg" loading={saving} onClick={() => void save()} title={allIssues.length ? 'Some choices are still open' : undefined}>
                {allIssues.length ? 'Finish the open choices' : 'Begin the adventure'}
              </Button>
            ) : (
              <Button variant="primary" onClick={() => next && goTo(next)} disabled={!next} aria-label={next ? `Next: ${STEP_LABELS[next]}` : 'Next'}>
                <span className="sm:hidden">Next</span>
                <span className="hidden sm:inline">Next: {next ? STEP_LABELS[next] : ''}</span>
                <ArrowRight className="size-4" aria-hidden />
              </Button>
            )}
          </div>
        </div>
      </div>
      <Dialog open={previewOpen} onClose={() => setPreviewOpen(false)} title="Preview">
        <PreviewCard built={built} stats={stats} className="border-0 p-0 shadow-none" />
      </Dialog>
    </div>
  );
}
