import { ScrollText } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useGame } from '@/state/gameStore';
import type { Quest, QuestObjective, QuestStatus } from '@/types';
import { toast } from '@/ui/components/toast';
import { EmptyState } from '@/ui/components/ui';
import { errorMessage } from '../format';
import { usePlayView } from '../playView';
import { Group } from './Group';

const STATUS_ORDER: { status: QuestStatus; label: string; open: boolean }[] = [
  { status: 'active', label: 'Active', open: true },
  { status: 'rumor', label: 'Rumors', open: true },
  { status: 'completed', label: 'Completed', open: false },
  { status: 'failed', label: 'Failed', open: false },
  { status: 'abandoned', label: 'Abandoned', open: false },
];

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
  const quests = useGame((s) => s.quests);
  if (quests.length === 0) {
    return (
      <EmptyState icon={<ScrollText className="size-7" aria-hidden />} title="No quests yet" className="py-8">
        Leads and goals appear here as the DM records them.
      </EmptyState>
    );
  }
  return (
    <div className="flex flex-col gap-4">
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
  const spoilers = usePlayView((s) => s.showSpoilers);
  const closed = quest.status !== 'active' && quest.status !== 'rumor';
  const meta = [quest.giver && `From ${quest.giver}`, quest.reward && `Reward: ${quest.reward}`]
    .filter(Boolean)
    .join(' · ');
  return (
    <article className={cn('rounded-xl border border-border bg-surface p-3', closed && 'opacity-75')}>
      <h4 className="text-sm font-semibold">{quest.title}</h4>
      {quest.summary && <p className="mt-0.5 text-sm text-muted">{quest.summary}</p>}
      {meta && <p className="mt-1 text-xs text-faint">{meta}</p>}
      {quest.objectives.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1.5" aria-label={`Objectives for ${quest.title}`}>
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
      )}
      {spoilers && quest.secretNotes && (
        <p className="mt-2 rounded-lg bg-arcane-soft px-2.5 py-1.5 text-xs text-arcane">
          <span className="font-semibold">DM notes: </span>
          {quest.secretNotes}
        </p>
      )}
    </article>
  );
}
