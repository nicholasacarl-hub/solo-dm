import { memo } from 'react';
import { cn } from '@/lib/cn';
import type { LogEntry, LogEntryKind } from '@/types';
import { isStoppedNote } from './dmContext';
import { DmEntry } from './DmEntry';
import { RollCard } from './RollCard';
import { ErrorCard, PlayerEntry, RecapCard, SessionDivider, StoppedMarker, SystemNote } from './SimpleEntries';
import { ToolLine } from './ToolLine';

/** Vertical rhythm: narration and dividers breathe, tool lines and rolls hug what they belong to. */
const SPACING: Record<LogEntryKind, string> = {
  dm: 'mt-7',
  player: 'mt-6',
  roll: 'mt-3',
  tool: 'mt-2',
  system: 'mt-4',
  session: 'mt-10 first:mt-0',
  recap: 'mt-6',
  error: 'mt-5',
};

export interface LogEntryViewProps {
  entry: LogEntry;
  /** This DM entry's suggested actions are still current (nothing was said since). */
  showChoices: boolean;
  /** This error is the most recent thing that happened, so Retry makes sense. */
  latestError: boolean;
  /** DM narration the DM never saw: its reply was cut off before it was saved (see dmContext). */
  cutOff?: boolean;
  /** The player's latest words, which the DM hasn't answered yet. */
  pending?: boolean;
}

/** One log entry. Memoized: while the DM streams, only the streaming entry re-renders. */
export const LogEntryView = memo(function LogEntryView({
  entry,
  showChoices,
  latestError,
  cutOff = false,
  pending = false,
}: LogEntryViewProps) {
  // The DM's "Stopped." note sits right under the reply it marks.
  const spacing = isStoppedNote(entry) ? 'mt-2' : SPACING[entry.kind];
  return (
    <div className={cn(spacing, 'first:mt-0')} data-kind={entry.kind}>
      {renderEntry(entry, showChoices, latestError, cutOff, pending)}
    </div>
  );
});

function renderEntry(entry: LogEntry, showChoices: boolean, latestError: boolean, cutOff: boolean, pending: boolean) {
  switch (entry.kind) {
    case 'dm':
      return <DmEntry entry={entry} showChoices={showChoices && !cutOff} cutOff={cutOff} />;
    case 'player':
      return <PlayerEntry entry={entry} pending={pending} />;
    case 'roll':
      return <RollCard entry={entry} />;
    case 'tool':
      return <ToolLine entry={entry} />;
    case 'system':
      return isStoppedNote(entry) ? <StoppedMarker entry={entry} /> : <SystemNote entry={entry} />;
    case 'session':
      return <SessionDivider entry={entry} />;
    case 'recap':
      return <RecapCard entry={entry} />;
    case 'error':
      return <ErrorCard entry={entry} latest={latestError} />;
  }
}
