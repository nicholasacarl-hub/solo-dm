import { Mountain, ScrollText } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useGame } from '@/state/gameStore';
import type { Quest, QuestObjective, QuestStatus } from '@/types';
import { toast } from '@/ui/components/toast';
import { Badge, EmptyState, type BadgeTone } from '@/ui/components/ui';
import { ClockFace } from '../ClockFace';
import { errorMessage } from '../format';
import { usePlayView } from '../playView';
import { ambitionClock, isClosed, splitAmbitions } from './ambitions';
import { Group } from './Group';

const STATUS_ORDER: { status: QuestStatus; label: string; open: boolean }[] = [
  { status: 'active', label: 'Active', open: true },
  { status: 'rumor', label: 'Rumors', open: true },
  { status: 'completed', label: 'Completed', open: false },
  { status: 'failed', label: 'Failed', open: false },
  { status: 'abandoned', label: 'Abandoned', open: false },
];

/** How a finished ambition turned out (open ones need no badge). */
const AMBITION_OUTCOME: Partial<Record<QuestStatus, { label: string; tone: BadgeTone }>> = {
  completed: { label: 'Achieved', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  abandoned: { label: 'Abandoned', tone: 'neutral' },
};

/** Tick an objective (player edit): saved, and the DM hears about it next turn. */
async function toggleObjective(quest: Quest, objective: QuestObjective): Promise<void> {
  const done = !objective.done;
  const { upsertQuest, queueDmNotice } = useGame.getState();
  try {
    await upsertQuest({
      id: quest.id,
      title: quest.title,
      objectives: quest.objectives.map((o) => (o.id === objective.id ? { ...o, done } : o)),
    });
    queueDmNotice(
      `The player marked the objective "${objective.text}" of the quest "${quest.title}" as ${done ? 'done' : 'not done'}.`,
    );
  } catch (err) {
    toast.error(errorMessage(err));
  }
}

export function QuestsTab() {
  const all = useGame((s) => s.quests);
  if (all.length === 0) {
    return (
      <EmptyState icon={<ScrollText className="size-7" aria-hidden />} title="No quests yet" className="py-8!">
        Leads and goals appear here as the DM records them.
      </EmptyState>
    );
  }
  const { ambitions, quests } = splitAmbitions(all);
  return (
    <div className="flex flex-col gap-4">
      {ambitions.length > 0 && (
        <Group
          label="Ambitions"
          count={ambitions.length}
          icon={<Mountain className="size-3.5 text-gold" aria-hidden />}
          description="Goals you set yourself. They move only for what the hero earns."
        >
          {ambitions.map((q) => (
            <AmbitionCard key={q.id} quest={q} />
          ))}
        </Group>
      )}
      {STATUS_ORDER.map(({ status, label, open }) => {
        const items = quests.filter((q) => q.status === status);
        if (items.length === 0) return null;
        return (
          <Group key={status} label={label} count={items.length} defaultOpen={open}>
            {items.map((q) => (
              <QuestCard key={q.id} quest={q} />
            ))}
          </Group>
        );
      })}
    </div>
  );
}

function QuestCard({ quest }: { quest: Quest }) {
  const meta = [quest.giver && `From ${quest.giver}`, quest.reward && `Reward: ${quest.reward}`]
    .filter(Boolean)
    .join(' · ');
  return (
    <article className={cn('rounded-xl border border-border bg-surface p-3', isClosed(quest.status) && 'opacity-75')}>
      <h4 className="text-sm font-semibold">{quest.title}</h4>
      {quest.summary && <p className="mt-0.5 text-sm text-muted">{quest.summary}</p>}
      {meta && <p className="mt-1 text-xs text-faint">{meta}</p>}
      <Objectives quest={quest} label={`Objectives for ${quest.title}`} />
      <SecretNotes quest={quest} />
    </article>
  );
}

/**
 * An ambition: no checklist of DM-invented steps, just the goal, its progress clock (same name)
 * beside it, and any concrete steps the hero has worked out for themselves.
 */
function AmbitionCard({ quest }: { quest: Quest }) {
  const spoilers = usePlayView((s) => s.showSpoilers);
  const clock = useGame((s) => ambitionClock(quest, s.clocks, spoilers));
  const outcome = AMBITION_OUTCOME[quest.status];
  return (
    <article
      aria-label={`Ambition: ${quest.title}`}
      className={cn(
        'rounded-xl border border-l-[3px] border-gold/35 border-l-gold bg-surface p-3',
        isClosed(quest.status) && 'opacity-75',
      )}
    >
      <div className="flex items-start gap-3">
        {clock && <ClockFace clock={clock} className="size-12" />}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <h4 className="text-sm font-semibold">{quest.title}</h4>
            {outcome && <Badge tone={outcome.tone}>{outcome.label}</Badge>}
          </div>
          {clock && (
            <p className="mt-0.5 text-xs text-faint tabular-nums">
              Progress {Math.min(clock.filled, clock.segments)} of {clock.segments}
            </p>
          )}
          {quest.summary && <p className="mt-1 text-sm text-muted">{quest.summary}</p>}
        </div>
      </div>
      {quest.objectives.length > 0 && (
        <p className="mt-2.5 text-[0.6875rem] font-semibold tracking-wider text-faint uppercase">Steps you’ve identified</p>
      )}
      <Objectives quest={quest} label={`Steps toward ${quest.title}`} className="mt-1.5" />
      <SecretNotes quest={quest} />
    </article>
  );
}

function Objectives({ quest, label, className = 'mt-2' }: { quest: Quest; label: string; className?: string }) {
  if (quest.objectives.length === 0) return null;
  return (
    <ul className={cn('flex flex-col gap-1.5', className)} aria-label={label}>
      {quest.objectives.map((o) => (
        <li key={o.id}>
          <label className="flex cursor-pointer items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={o.done}
              onChange={() => void toggleObjective(quest, o)}
              className="mt-0.5 size-4 shrink-0 accent-[var(--success)]"
            />
            <span className={cn(o.done && 'text-muted line-through')}>{o.text}</span>
          </label>
        </li>
      ))}
    </ul>
  );
}

function SecretNotes({ quest }: { quest: Quest }) {
  const spoilers = usePlayView((s) => s.showSpoilers);
  if (!spoilers || !quest.secretNotes) return null;
  return (
    <p className="mt-2 rounded-lg bg-arcane-soft px-2.5 py-1.5 text-xs text-arcane">
      <span className="font-semibold">DM notes: </span>
      {quest.secretNotes}
    </p>
  );
}
