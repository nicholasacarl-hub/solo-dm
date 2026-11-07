/**
 * Route #/play/:id — the table. Claims the campaign for this tab (one tab at a time may play a
 * campaign), loads it (and unloads it on the way out), sends players without a character to the
 * builder, and asks the DM to begin or resume the session once.
 */
import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router';
import { AppWindow, BookX } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { dm } from '@/dm';
import { useGame, whenPersisted } from '@/state/gameStore';
import { acquireCampaignLock, type CampaignLock } from '@/storage';
import { Button, EmptyState, Spinner } from '@/ui/components/ui';
import { runDm, waitForDmIdle } from '@/ui/play/dmStatus';
import { errorMessage } from '@/ui/play/format';
import { PlayTable } from '@/ui/play/PlayTable';
import { useDocumentTitle } from '@/ui/shell/Page';

/** dm.isBusy() as a safe boolean for effects (an effect has nowhere useful to throw to). */
function dmIsBusy(): boolean {
  try {
    return dm.isBusy();
  } catch {
    return false;
  }
}

/** Leaving the table mid-turn: stop the DM so it doesn't keep writing to an unloaded campaign. */
function stopDm(): void {
  try {
    if (dm.isBusy()) dm.cancel();
  } catch {
    // Nothing to stop.
  }
}

/**
 * Resolve once dm.isBusy() is false (true) or the deadline passes (false). Waits on the store's
 * reactive phase, re-checking the controller in case the two briefly disagree.
 */
async function whenDmIdle(timeoutMs: number, isCancelled: () => boolean): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (dmIsBusy()) {
    if (isCancelled() || Date.now() >= deadline) return false;
    await waitForDmIdle(Math.min(1000, deadline - Date.now()));
    if (dmIsBusy()) await new Promise((resolve) => window.setTimeout(resolve, 200));
  }
  return !isCancelled();
}

/**
 * Call dm.beginOrResume() once per arrival at the table (StrictMode-safe), after any in-flight DM
 * work. `arrival` names one: the campaign id, plus a counter that moves when this tab takes the
 * campaign back from another tab (which may have ended or started a session meanwhile).
 */
function useBeginOrResume(arrival: string | null): void {
  const begunFor = useRef<string | null>(null);
  useEffect(() => {
    if (!arrival || begunFor.current === arrival) return;
    let cancelled = false;
    void (async () => {
      if (!(await whenDmIdle(30_000, () => cancelled)) || begunFor.current === arrival) return;
      // Marked only when the call is made, so a cancelled wait (unmount, reload) can try again.
      begunFor.current = arrival;
      try {
        await dm.beginOrResume();
      } catch (err) {
        // Let a later render try again (e.g. the campaign was mid-reload), unless we've left.
        if (begunFor.current === arrival) begunFor.current = null;
        if (!cancelled) await runDm(() => Promise.reject(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [arrival]);
}

/** Used when locking itself fails: playing on beats locking the player out of their campaign. */
const UNLOCKED: CampaignLock = { release: () => {}, lost: new Promise<void>(() => {}) };

/**
 * Whether this tab may play the campaign: 'waiting' for the lock, 'held', 'elsewhere' (another
 * tab had it open first) or 'taken' (another tab took it over from this one).
 */
type Access = 'waiting' | 'held' | 'elsewhere' | 'taken';

export function PlayScreen() {
  const { id } = useParams<{ id: string }>();
  const { storeCampaignId, loadedId, name, sessionNumber, hasCharacter, loading, loadError } = useGame(
    useShallow((s) => ({
      storeCampaignId: s.campaignId,
      loadedId: s.campaign?.id ?? null,
      name: s.campaign?.name ?? null,
      sessionNumber: s.activeSession?.number ?? null,
      hasCharacter: Boolean(s.campaign?.characterId) && s.character !== null,
      loading: s.loading,
      loadError: s.loadError,
    })),
  );
  const [failure, setFailure] = useState<{ id: string; message: string } | null>(null);
  // The id whose load THIS screen started has finished. The store may already hold the campaign
  // (the builder leaves it loaded), but the DM must not start until our own reload settles —
  // otherwise the reload replaces the store's state in the middle of the session's opening.
  const [readyId, setReadyId] = useState<string | null>(null);
  const [access, setAccess] = useState<{ id: string; state: Access } | null>(null);
  // "Use this tab instead": the next claim of this id takes the campaign over from the other tab.
  const takeOverId = useRef<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!id) return;
    let active = true;
    const steal = takeOverId.current === id;
    takeOverId.current = null;
    // Claim the campaign before reading it: a second tab must never load it, start the DM or write.
    // (Holders in one tab share the lock, so a StrictMode remount doesn't lock itself out.)
    const claim = acquireCampaignLock(id, steal ? { steal: true } : undefined).catch((err: unknown) => {
      console.error('[PlayScreen] Could not claim the campaign for this tab:', err);
      return UNLOCKED;
    });
    claim
      .then((lock) => {
        if (!active) return;
        if (!lock) {
          // Not even a copy the builder left loaded may be written from here.
          useGame.getState().unloadCampaign();
          setAccess({ id, state: 'elsewhere' });
          return;
        }
        setAccess({ id, state: 'held' });
        // Another tab took over: stop the DM and step back before this tab writes anything else.
        void lock.lost.then(() => {
          if (!active) return;
          stopDm();
          useGame.getState().unloadCampaign();
          setReadyId(null);
          setAccess({ id, state: 'taken' });
        });
        return useGame
          .getState()
          .loadCampaign(id)
          .then(() => {
            if (active) setReadyId(id);
          });
      })
      .catch((err: unknown) => setFailure({ id, message: errorMessage(err) }));
    return () => {
      active = false;
      setReadyId(null);
      stopDm();
      useGame.getState().unloadCampaign();
      // Let go once this tab's last writes are saved, so a tab that takes over reads all of them.
      void Promise.all([claim, whenPersisted(id)]).then(([lock]) => lock?.release());
    };
  }, [id, attempt]);

  const state = access && access.id === id ? access.state : 'waiting';
  const loaded = Boolean(id) && state === 'held' && readyId === id && loadedId === id && !loading;
  useBeginOrResume(loaded && hasCharacter && id ? `${id}#${attempt}` : null);

  const error =
    failure && failure.id === id ? failure.message : id && storeCampaignId === id && !loading ? loadError : null;
  const elsewhere = state === 'elsewhere' || state === 'taken';
  useDocumentTitle(
    error
      ? "Campaign couldn't be opened"
      : elsewhere
        ? 'Open in another tab'
        : loaded && name
          ? sessionNumber
            ? `${name} · Session ${sessionNumber}`
            : name
          : 'Opening the campaign',
  );

  if (!id) return <Navigate to="/" replace />;
  if (error) return <LoadFailed message={error} />;
  if (elsewhere) {
    const takeOver = () => {
      takeOverId.current = id;
      setAccess({ id, state: 'waiting' });
      setAttempt((n) => n + 1);
    };
    return <OpenElsewhere taken={state === 'taken'} onTakeOver={takeOver} />;
  }
  if (!loaded) return <Opening />;
  if (!hasCharacter) return <Navigate to={`/campaign/${id}/character`} replace />;
  return <PlayTable />;
}

function Opening() {
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-3 bg-bg text-muted">
      <Spinner label="Opening the campaign" className="size-6!" />
      <p className="text-sm">Opening the campaign…</p>
    </div>
  );
}

/** Another tab has this campaign at the table: only one tab may play (and save) it at a time. */
function OpenElsewhere({ taken, onTakeOver }: { taken: boolean; onTakeOver: () => void }) {
  return (
    <main className="flex h-dvh items-center justify-center bg-bg px-4">
      <div className="flex max-w-md flex-col items-center gap-3 px-6 py-10 text-center">
        <AppWindow className="size-9 text-faint" aria-hidden />
        <h1 className="font-display text-base font-semibold">
          {taken ? 'This campaign moved to another tab' : 'This campaign is open in another tab'}
        </h1>
        <p role={taken ? 'alert' : undefined} className="max-w-sm text-sm text-muted">
          {taken
            ? 'You opened it in another tab, so this one stepped back.'
            : 'A campaign can be played in one tab at a time, so your saves never overwrite each other.'}{' '}
          Using this tab instead closes the table in the other one.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button variant="primary" onClick={onTakeOver}>
            Use this tab instead
          </Button>
          <Link
            to="/"
            className="inline-flex h-10 items-center rounded-xl px-4 text-sm font-medium text-muted hover:bg-surface-2 hover:text-text"
          >
            Back to campaigns
          </Link>
        </div>
      </div>
    </main>
  );
}

function LoadFailed({ message }: { message: string }) {
  return (
    <div className="flex h-dvh items-center justify-center bg-bg px-4">
      <EmptyState
        icon={<BookX className="size-9" aria-hidden />}
        title="This campaign couldn't be opened"
        action={
          <Link
            to="/"
            className="inline-flex h-10 items-center rounded-xl bg-accent px-4 text-sm font-medium text-accent-ink hover:bg-accent-hover"
          >
            Back to campaigns
          </Link>
        }
      >
        <p role="alert">{message}</p>
      </EmptyState>
    </div>
  );
}
