import { useState } from 'react';
import { Dices, EyeOff, Hand } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useGame } from '@/state/gameStore';
import type { RollLogEntry } from '@/types';
import { Badge, Button } from '@/ui/components/ui';
import { D20Face } from '../dice/D20Face';
import {
  TONE_TEXT,
  advantageLabel,
  d20Dice,
  isAttackPurpose,
  naturalOf,
  outcomeBadges,
  primaryTone,
  targetLabel,
} from '../dice/rollDisplay';
import { signed } from '../format';
import { usePlayView } from '../playView';

/** A dice card. Secret DM rolls stay behind the screen until revealed. */
export function RollCard({ entry }: { entry: RollLogEntry }) {
  const campaignShowsDmRolls = useGame((s) => s.campaign?.settings.showDmRolls ?? false);
  const revealAll = usePlayView((s) => s.revealAllDmRolls);
  const [revealed, setRevealed] = useState(false);
  const behindScreen = entry.secret && entry.actor === 'dm' && !campaignShowsDmRolls && !revealAll && !revealed;

  if (behindScreen) {
    return (
      <div className="flex items-center gap-3 rounded-2xl border border-dashed border-border px-3 py-2 text-sm text-muted">
        <EyeOff className="size-4 shrink-0 text-faint" aria-hidden />
        <span className="flex-1 italic">The DM rolls behind the screen</span>
        <Button size="sm" variant="ghost" onClick={() => setRevealed(true)}>
          Reveal
        </Button>
      </div>
    );
  }
  return <VisibleRoll entry={entry} />;
}

function VisibleRoll({ entry }: { entry: RollLogEntry }) {
  const { roll } = entry;
  const attack = entry.rollType ? entry.rollType === 'attack' : isAttackPurpose(entry.purpose);
  const natural = naturalOf(roll);
  // A hidden DC or AC is left out of the logged roll: then there is no verdict to show either, only
  // natural 20s and 1s — and the die and total are coloured from those alone, so no colour gives
  // the outcome away before the DM narrates it.
  const badges = outcomeBadges(roll.dc === undefined ? { ...roll, success: undefined } : roll, attack);
  const tone = primaryTone(badges);
  const advantage = advantageLabel(roll);
  const isPlayer = entry.actor === 'player';
  // "20 = 20" says nothing: a lone d20 with no modifier just shows its total.
  const plainD20 = natural !== undefined && roll.modifier === 0 && d20Dice(roll).length === 1;

  return (
    <div className={cn('flex', isPlayer ? 'justify-end' : 'justify-start')}>
      <div className="flex max-w-full items-center gap-3 rounded-2xl border border-border bg-surface px-3 py-2.5 shadow-card">
        {natural !== undefined ? (
          <D20Face value={natural} className={cn('size-12', TONE_TEXT[tone])} />
        ) : (
          <span className="grid size-12 shrink-0 place-items-center rounded-xl bg-surface-2 text-accent">
            <Dices className="size-6" aria-hidden />
          </span>
        )}
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-x-2 text-sm font-medium">
            <span className="line-clamp-2 break-words">{entry.purpose}</span>
            <span className="text-xs font-normal text-faint">{isPlayer ? 'You' : 'DM'}</span>
          </p>
          <p className="mt-0.5 flex flex-wrap items-baseline gap-x-1.5 text-sm text-muted">
            {!plainD20 && (
              <>
                {natural !== undefined ? <D20Values entry={entry} natural={natural} /> : <DiceValues entry={entry} />}
                <span aria-hidden>=</span>
              </>
            )}
            <span className="sr-only">total</span>
            <span
              className={cn(
                'text-xl leading-none font-semibold tabular-nums',
                tone === 'neutral' ? 'text-text' : TONE_TEXT[tone],
              )}
            >
              {roll.total}
            </span>
            {roll.dc !== undefined && (
              <span className="ml-1 text-xs whitespace-nowrap">
                vs {targetLabel({ purpose: entry.purpose })} {roll.dc}
              </span>
            )}
          </p>
          {(badges.length > 0 || advantage || entry.manual || entry.secret) && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {badges.map((b) => (
                <Badge key={b.label} tone={b.tone === 'neutral' ? 'neutral' : b.tone}>
                  {b.label}
                </Badge>
              ))}
              {advantage && <Badge tone="info">{advantage}</Badge>}
              {entry.manual && (
                <Badge>
                  <Hand className="size-3" aria-hidden />
                  Physical dice
                </Badge>
              )}
              {entry.secret && <Badge>Secret roll</Badge>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** "17 ~~4~~ +5": the kept d20, a struck-through dropped d20 (advantage), and the modifier. */
function D20Values({ entry, natural }: { entry: RollLogEntry; natural: number }) {
  const { roll } = entry;
  const d20s = d20Dice(roll);
  const dropped = d20s.filter((d) => d.dropped);
  return (
    <>
      <span className="font-medium text-text tabular-nums">
        <span className="sr-only">rolled </span>
        {natural}
      </span>
      {dropped.map((d, i) => (
        <s key={i} className="text-faint tabular-nums">
          <span className="sr-only">dropped </span>
          {d.value}
        </s>
      ))}
      {roll.modifier !== 0 && <span className="tabular-nums">{signed(roll.modifier)}</span>}
    </>
  );
}

/** Non-d20 rolls: "2d6+3 · 4 5 +3". */
function DiceValues({ entry }: { entry: RollLogEntry }) {
  const { roll } = entry;
  return (
    <>
      <span className="font-mono text-xs">{roll.expression}</span>
      {roll.dice.length > 0 && (
        <span className="flex flex-wrap gap-1" aria-label={`dice ${roll.dice.map((d) => d.value).join(', ')}`}>
          {roll.dice.map((d, i) => (
            <span
              key={i}
              aria-hidden
              className={cn(
                'inline-grid min-w-6 place-items-center rounded-md border border-border px-1 text-xs font-medium text-text tabular-nums',
                d.dropped && 'text-faint line-through',
              )}
            >
              {d.value}
            </span>
          ))}
        </span>
      )}
      {roll.modifier !== 0 && <span className="tabular-nums">{signed(roll.modifier)}</span>}
    </>
  );
}
