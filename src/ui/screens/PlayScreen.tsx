/**
 * Route #/play/:id — the table. Loads the campaign (and unloads it on the way out), sends players
 * without a character to the builder, and asks the DM to begin or resume the session once.
 */
import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router';
import { BookX } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { dm } from '@/dm';
import { useGame } from '@/state/gameStore';
import { EmptyState, Spinner } from '@/ui/components/ui';
import { runDm, waitForDmIdle } from '@/ui/play/dmStatus';
import { errorMessage } from '@/ui/play/format';
import { PlayTable } from '@/ui/play/PlayTable';

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

/** Call dm.beginOrResume() once per loaded campaign (StrictMode-safe), after any in-flight DM work. */
function useBeginOrResume(campaignId: string | null): void {
  const begunFor = useRef<string | null>(null);
  useEffect(() => {
    if (!campaignId || begunFor.current === campaignId) return;
    let cancelled = false;
    void (async () => {
      if (!(await whenDmIdle(30_000, () => cancelled)) || begunFor.current === campaignId) return;
      // Marked only when the call is made, so a cancelled wait (unmount, reload) can try again.
      begunFor.current = campaignId;
      try {
        await dm.beginOrResume();
      } catch (err) {
        // Let a later render try again (e.g. the campaign was mid-reload), unless we've left.
        if (begunFor.current === campaignId) begunFor.current = null;
        if (!cancelled) await runDm(() => Promise.reject(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [campaignId]);
}

export function PlayScreen() {
  const { id } = useParams<{ id: string }>();
  const { storeCampaignId, loadedId, hasCharacter, loading, loadError } = useGame(
    useShallow((s) => ({
      storeCampaignId: s.campaignId,
      loadedId: s.campaign?.id ?? null,
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

  useEffect(() => {
    if (!id) return;
    let active = true;
    useGame
      .getState()
      .loadCampaign(id)
      .then(() => {
        if (active) setReadyId(id);
      })
      .catch((err: unknown) => setFailure({ id, message: errorMessage(err) }));
    return () => {
      active = false;
      setReadyId(null);
      stopDm();
      useGame.getState().unloadCampaign();
    };
  }, [id]);

  const loaded = Boolean(id) && readyId === id && loadedId === id && !loading;
  useBeginOrResume(loaded && hasCharacter ? (id ?? null) : null);

  if (!id) return <Navigate to="/" replace />;

  const error = failure?.id === id ? failure.message : storeCampaignId === id && !loading ? loadError : null;
  if (error) return <LoadFailed message={error} />;
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
