import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ScrollText } from 'lucide-react';
import { useGame } from '@/state/gameStore';
import type { DmLogEntry, LogEntry } from '@/types';
import { EmptyState } from '@/ui/components/ui';
import { isBusyPhase } from '../dmStatus';
import { stripMarkdown } from '../format';
import { dmContextGaps } from './dmContext';
import { LogEntryView } from './LogEntryView';
import { useStickToBottom } from './useStickToBottom';

/** Entries rendered at first; "Show earlier" adds this many more. Keeps very long campaigns fast. */
const PAGE_SIZE = 150;

/** The DM entry whose choices are still current: the latest DM entry, if the player hasn't spoken since. */
export function activeChoicesEntryId(log: LogEntry[]): string | null {
  for (let i = log.length - 1; i >= 0; i--) {
    const entry = log[i];
    if (entry.kind === 'player') return null;
    if (entry.kind === 'dm') return entry.choices?.length && !entry.streaming ? entry.id : null;
  }
  return null;
}

/** The error entry that is the latest thing that happened (no narration or player turn after it). */
export function latestErrorEntryId(log: LogEntry[]): string | null {
  for (let i = log.length - 1; i >= 0; i--) {
    const entry = log[i];
    if (entry.kind === 'error') return entry.id;
    if (entry.kind === 'dm' || entry.kind === 'player') return null;
  }
  return null;
}

function latestFinishedDm(log: LogEntry[]): DmLogEntry | null {
  for (let i = log.length - 1; i >= 0; i--) {
    const entry = log[i];
    if (entry.kind === 'dm' && !entry.streaming && entry.text.trim()) return entry;
  }
  return null;
}

/**
 * Screen-reader text for DM narration that finished after the log mounted. The visible log is
 * not a live region, so streaming deltas and history are never read out.
 */
function useFinishedNarrationAnnouncement(log: LogEntry[]): string {
  const [announcement, setAnnouncement] = useState('');
  const announcedId = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const latest = latestFinishedDm(log);
    const id = latest?.id ?? null;
    if (announcedId.current === undefined) {
      announcedId.current = id;
      return;
    }
    if (latest && id !== announcedId.current) {
      announcedId.current = id;
      const options = latest.choices?.length ? ` Options: ${latest.choices.join('; ')}.` : '';
      setAnnouncement(`The DM: ${stripMarkdown(latest.text)}${options}`);
    }
  }, [log]);
  return announcement;
}

export function NarrativeLog() {
  const log = useGame((s) => s.log);
  const transcript = useGame((s) => s.transcript);
  const sessionId = useGame((s) => s.activeSession?.id ?? null);
  const busy = useGame((s) => isBusyPhase(s.dm.phase));
  const [limit, setLimit] = useState(PAGE_SIZE);
  const hiddenCount = Math.max(0, log.length - limit);
  const visible = hiddenCount > 0 ? log.slice(hiddenCount) : log;
  const choicesId = useMemo(() => activeChoicesEntryId(log), [log]);
  const errorId = useMemo(() => latestErrorEntryId(log), [log]);
  // What the DM missed: cut-off narration, and the player's words it hasn't answered yet.
  const gaps = useMemo(() => dmContextGaps(log, transcript, sessionId, busy), [log, transcript, sessionId, busy]);
  const { scrollRef, contentRef, atBottom, onScroll, scrollToBottom } = useStickToBottom(log.length);
  const announcement = useFinishedNarrationAnnouncement(log);

  // The player just spoke: always bring their words (and the reply to come) into view.
  const last = log[log.length - 1];
  const lastPlayerId = last?.kind === 'player' ? last.id : null;
  useLayoutEffect(() => {
    if (lastPlayerId) scrollToBottom();
  }, [lastPlayerId, scrollToBottom]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        role="log"
        aria-live="off"
        aria-label="Story so far"
        tabIndex={0}
        className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain scroll-thin focus-visible:outline-offset-[-2px]"
      >
        <div ref={contentRef} className="mx-auto w-full max-w-[42rem] px-4 pt-6 pb-8 sm:px-6">
          {hiddenCount > 0 && (
            <div className="mb-6 flex justify-center">
              <button
                type="button"
                onClick={() => setLimit((n) => n + PAGE_SIZE)}
                className="rounded-full border border-border px-3 py-1 text-xs font-medium text-muted hover:bg-surface-2 hover:text-text"
              >
                Show earlier entries ({hiddenCount})
              </button>
            </div>
          )}
          {log.length === 0 ? (
            <EmptyState icon={<ScrollText className="size-8" aria-hidden />} title="The story is about to begin">
              Your DM is setting the scene.
            </EmptyState>
          ) : (
            visible.map((entry) => (
              <LogEntryView
                key={entry.id}
                entry={entry}
                showChoices={entry.id === choicesId}
                latestError={entry.id === errorId}
                cutOff={gaps.cutOffIds.has(entry.id)}
                pending={entry.id === gaps.pendingPlayerId}
              />
            ))
          )}
        </div>
      </div>
      {!atBottom && (
        <button
          type="button"
          onClick={() => scrollToBottom('smooth')}
          className="absolute bottom-3 left-1/2 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-surface px-3.5 py-1.5 text-xs font-medium text-text shadow-card hover:bg-surface-2"
        >
          <ArrowDown className="size-3.5" aria-hidden />
          Jump to latest
        </button>
      )}
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
    </div>
  );
}
