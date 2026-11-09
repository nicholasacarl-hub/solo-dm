import { BookMarked, CheckCircle2, Pencil } from 'lucide-react';
import { Button, Card } from '@/ui/components/ui';
import { CharacterSheet } from '@/ui/sheet/CharacterSheet';
import { OlderEditionNotes } from '../BookBadges';
import { StepHeader } from '../BuilderParts';
import { activeSteps, draftAdaptationNotes, draftImports, validateStep } from '../logic';
import { STEP_LABELS } from '../types';
import type { StepProps } from './stepTypes';

export function ReviewStep({ draft, ctx, built, goTo, onDmDecide }: StepProps) {
  const pending = activeSteps(draft, ctx.data)
    .filter((s) => s !== 'review')
    .map((step) => ({ step, issues: validateStep(step, draft, ctx) }))
    .filter((s) => s.issues.length > 0);
  return (
    <div className="flex flex-col gap-5">
      <StepHeader
        title="Review"
        description="Check your hero over. Everything stays editable on the sheet during play, and the DM can help with anything you're unsure about."
        onDmDecide={pending.length ? onDmDecide : undefined}
        dmLabel="Let the DM finish it"
      />
      {pending.length > 0 ? (
        <Card className="flex flex-col gap-3 border-gold/50 p-4">
          <p className="font-medium text-gold">A few choices are still open</p>
          <ul className="flex flex-col gap-2">
            {pending.map(({ step, issues }) => (
              <li key={step} className="flex flex-col gap-1 rounded-lg bg-surface-2 px-3 py-2 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <p className="text-sm font-semibold">{STEP_LABELS[step]}</p>
                  <ul className="list-disc pl-5 text-sm text-muted">
                    {issues.map((issue) => (
                      <li key={issue}>{issue}</li>
                    ))}
                  </ul>
                </div>
                <Button size="sm" variant="secondary" icon={<Pencil className="size-3.5" aria-hidden />} onClick={() => goTo(step)} className="self-start">
                  Fix
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      ) : (
        <p className="flex items-center gap-2 rounded-xl bg-success-soft px-4 py-3 text-sm text-success">
          <CheckCircle2 className="size-4" aria-hidden /> Ready for adventure.
        </p>
      )}
      <Provenance imports={draftImports(draft, ctx.data)} notes={draftAdaptationNotes(draft, ctx.data)} />
      {built && (
        <Card className="p-4">
          <CharacterSheet character={built} variant="full" />
        </Card>
      )}
    </div>
  );
}

/** Which choices come from the player's books, and how older-format ones were fitted to the 2024 rules. */
function Provenance({ imports, notes }: { imports: { name: string; kind: string; book: string }[]; notes: string[] }) {
  if (!imports.length && !notes.length) return null;
  return (
    <div className="flex flex-col gap-3">
      {imports.length > 0 && (
        <p className="flex items-start gap-2 rounded-xl border border-info/30 bg-info-soft/60 px-3.5 py-2.5 text-sm">
          <BookMarked className="mt-0.5 size-4 shrink-0 text-info" aria-hidden />
          <span>
            From your books: {imports.map((i) => `${i.name} (${i.kind})`).join(', ')}. Their text stays on this device; saves keep only the names.
          </span>
        </p>
      )}
      <OlderEditionNotes notes={notes} />
    </div>
  );
}
