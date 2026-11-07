/**
 * Settings: optional cloud saves in the player's own PRIVATE GitHub repository (fine-grained token,
 * test connection, two-way sync with conflict resolution).
 */
import { useId, useState } from 'react';
import { CheckCircle2, ExternalLink, Loader2, RefreshCw, TriangleAlert } from 'lucide-react';
import {
  listRemoteSaves,
  pullCampaignFromGithub,
  pushCampaignToGithub,
  syncWithGithub,
  testGithubConnection,
  useCampaignList,
  type SyncReport,
} from '@/storage';
import { useGame } from '@/state/gameStore';
import { useSettings } from '@/state/settingsStore';
import type { GithubSyncSettings } from '@/types';
import { Button, Field, Input, Switch } from '@/ui/components/ui';
import { SecretInput } from '@/ui/components/SecretInput';
import { toast } from '@/ui/components/toast';
import { errorMessage, formatRelativeTime, plural } from '../format';
import { StatusLine } from './SettingsSection';

type ConnectionTest =
  | { status: 'idle' }
  | { status: 'testing' }
  | { status: 'done'; ok: boolean; isPrivate?: boolean; error?: string };

type SyncRun =
  | { status: 'idle' }
  | { status: 'syncing' }
  | { status: 'done'; report: SyncReport; at: number }
  | { status: 'failed'; error: string };

type Conflict = SyncReport['conflicts'][number];

const NEW_REPO_URL = 'https://github.com/new';
const NEW_TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new';

/** Accept "repo", "owner/repo" or a github.com URL in the repository field. */
export function parseRepoInput(input: string): { owner?: string; repo: string } {
  const cleaned = input
    .trim()
    .replace(/^(https?:\/\/)?(www\.)?github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  const parts = cleaned.split('/').filter(Boolean);
  if (parts.length >= 2) return { owner: parts[0], repo: parts[1] };
  return { repo: cleaned };
}

function isConfigured(gh: GithubSyncSettings): boolean {
  return Boolean(gh.token.trim() && gh.owner.trim() && gh.repo.trim());
}

/** After a pull, refresh the campaign loaded in memory so the table shows the new save. */
async function reloadIfLoaded(campaignIds: readonly string[]): Promise<void> {
  try {
    const game = useGame.getState();
    if (game.campaignId && campaignIds.includes(game.campaignId)) await game.reload();
  } catch {
    // Nothing loaded (or the game store is unavailable): the next visit loads fresh data.
  }
}

export function GithubSettings() {
  const gh = useSettings((s) => s.githubSync);
  const updateGithubSync = useSettings((s) => s.updateGithubSync);
  const [test, setTest] = useState<ConnectionTest>({ status: 'idle' });
  const [sync, setSync] = useState<SyncRun>({ status: 'idle' });

  const edit = (patch: Partial<GithubSyncSettings>) => {
    updateGithubSync(patch);
    setTest({ status: 'idle' });
  };

  const runTest = async () => {
    setTest({ status: 'testing' });
    try {
      const result = await testGithubConnection(gh);
      setTest({ status: 'done', ok: result.ok, isPrivate: result.private, error: result.error });
    } catch (error) {
      setTest({ status: 'done', ok: false, error: errorMessage(error, 'Could not reach GitHub.') });
    }
  };

  const runSync = async () => {
    setSync({ status: 'syncing' });
    try {
      const report = await syncWithGithub(gh);
      const at = Date.now();
      updateGithubSync({ lastSyncedAt: at });
      setSync({ status: 'done', report, at });
      if (report.pulled.length > 0) await reloadIfLoaded(report.pulled);
    } catch (error) {
      setSync({ status: 'failed', error: errorMessage(error, 'Sync failed.') });
    }
  };

  const dropConflict = (campaignId: string) =>
    setSync((prev) =>
      prev.status === 'done'
        ? { ...prev, report: { ...prev.report, conflicts: prev.report.conflicts.filter((c) => c.campaignId !== campaignId) } }
        : prev,
    );

  const configured = isConfigured(gh);
  const publicRepo = test.status === 'done' && test.isPrivate === false;

  return (
    <>
      <p className="text-sm text-muted">
        Keep your campaigns in a private GitHub repository you own, so the same saves open on any device. Optional:
        without it, everything stays in this browser.
      </p>
      <Switch
        checked={gh.enabled}
        onChange={(enabled) => edit({ enabled })}
        label="Sync saves to GitHub"
        description="Saves are only ever written to a private repository."
      />

      {gh.enabled && (
        <>
          <SetupSteps />
          <ConnectionFields gh={gh} onEdit={edit} />

          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void runTest()} loading={test.status === 'testing'} disabled={!configured}>
                Test connection
              </Button>
              <Button
                variant="primary"
                icon={<RefreshCw className="size-4" aria-hidden />}
                onClick={() => void runSync()}
                loading={sync.status === 'syncing'}
                disabled={!configured || publicRepo}
              >
                Sync now
              </Button>
            </div>
            {!configured && <p className="text-xs text-muted">Fill in the token, owner and repository first.</p>}
            <div role="status" aria-live="polite" className="flex flex-col gap-3">
              <ConnectionResult test={test} gh={gh} />
              {sync.status === 'failed' && (
                <StatusLine tone="danger" icon={<TriangleAlert className="size-4" aria-hidden />}>
                  {sync.error}
                </StatusLine>
              )}
            </div>
            {sync.status === 'done' && <SyncSummary report={sync.report} at={sync.at} gh={gh} onResolved={dropConflict} />}
            {gh.lastSyncedAt && sync.status !== 'done' && (
              <p className="text-xs text-muted">Last synced {formatRelativeTime(gh.lastSyncedAt)}.</p>
            )}
          </div>
        </>
      )}
    </>
  );
}

function SetupSteps() {
  const link = 'inline-flex items-center gap-1 font-medium text-accent underline-offset-2 hover:underline';
  return (
    <div className="rounded-xl bg-surface-2 px-4 py-3.5 text-sm">
      <p className="font-medium">One-time setup</p>
      <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-muted marker:text-faint">
        <li>
          <a href={NEW_REPO_URL} target="_blank" rel="noreferrer noopener" className={link}>
            Create a <strong className="text-text">private</strong> repository
            <ExternalLink className="size-3" aria-hidden />
          </a>{' '}
          for your saves, for example “solo-dm-saves”.
        </li>
        <li>
          <a href={NEW_TOKEN_URL} target="_blank" rel="noreferrer noopener" className={link}>
            Create a fine-grained token
            <ExternalLink className="size-3" aria-hidden />
          </a>{' '}
          with access to <em>only that repository</em> and the permission <strong className="text-text">Contents: Read and write</strong>.
        </li>
        <li>Paste the token below with your username and the repository name, then test the connection.</li>
      </ol>
      <p className="mt-2 text-xs text-muted">The token is stored in this browser, like your API key.</p>
    </div>
  );
}

function ConnectionFields({ gh, onEdit }: { gh: GithubSyncSettings; onEdit: (patch: Partial<GithubSyncSettings>) => void }) {
  const id = useId();
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <Field className="sm:col-span-2" label="Fine-grained token" htmlFor={`${id}-token`}>
        <SecretInput
          id={`${id}-token`}
          noun="token"
          value={gh.token}
          placeholder="github_pat_…"
          onChange={(e) => onEdit({ token: e.target.value.trim() })}
        />
      </Field>
      <Field label="Owner" htmlFor={`${id}-owner`} hint="Your GitHub username or organization.">
        <Input
          id={`${id}-owner`}
          value={gh.owner}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder="your-username"
          onChange={(e) => onEdit({ owner: e.target.value.trim() })}
        />
      </Field>
      <Field label="Repository" htmlFor={`${id}-repo`} hint="Must be private.">
        <Input
          id={`${id}-repo`}
          value={gh.repo}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder="solo-dm-saves"
          onChange={(e) => onEdit({ repo: e.target.value.trim() })}
          onBlur={(e) => {
            // Accept "owner/repo" or a github.com URL; split it once the player is done typing.
            if (!e.target.value.includes('/')) return;
            const parsed = parseRepoInput(e.target.value);
            onEdit(parsed.owner ? { owner: parsed.owner, repo: parsed.repo } : { repo: parsed.repo });
          }}
        />
      </Field>
      <Field label="Branch" htmlFor={`${id}-branch`}>
        <Input
          id={`${id}-branch`}
          value={gh.branch}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder="main"
          onChange={(e) => onEdit({ branch: e.target.value.trim() })}
        />
      </Field>
      <Field label="Folder" htmlFor={`${id}-path`} hint="Where save files go inside the repository.">
        <Input
          id={`${id}-path`}
          value={gh.path}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder="saves"
          onChange={(e) => onEdit({ path: e.target.value.trim() })}
        />
      </Field>
    </div>
  );
}

function ConnectionResult({ test, gh }: { test: ConnectionTest; gh: GithubSyncSettings }) {
  if (test.status === 'testing') {
    return (
      <StatusLine tone="muted" icon={<Loader2 className="size-4 animate-spin" aria-hidden />}>
        Checking {gh.owner}/{gh.repo}…
      </StatusLine>
    );
  }
  if (test.status !== 'done') return null;
  if (test.ok) {
    return (
      <StatusLine tone="success" icon={<CheckCircle2 className="size-4" aria-hidden />}>
        Connected to {gh.owner}/{gh.repo}. The repository is private, so saves can sync.
      </StatusLine>
    );
  }
  if (test.isPrivate === false) {
    return (
      <StatusLine tone="danger" icon={<TriangleAlert className="size-4" aria-hidden />}>
        {gh.owner}/{gh.repo} is public, so Solo DM won’t sync to it. Make the repository private on GitHub, or choose a
        private one.
      </StatusLine>
    );
  }
  return (
    <StatusLine tone="danger" icon={<TriangleAlert className="size-4" aria-hidden />}>
      {test.error ?? 'Could not connect.'}
    </StatusLine>
  );
}

function SyncSummary({
  report,
  at,
  gh,
  onResolved,
}: {
  report: SyncReport;
  at: number;
  gh: GithubSyncSettings;
  onResolved: (campaignId: string) => void;
}) {
  const campaigns = useCampaignList();
  const nameOf = (campaignId: string) =>
    campaigns?.find((s) => s.campaign.id === campaignId)?.campaign.name ?? 'A campaign';
  const names = (ids: string[]) => ids.map(nameOf).join(', ');

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface-2 p-4 text-sm">
      <div>
        <p className="font-medium">Synced {formatRelativeTime(at)}</p>
        <p className="text-muted">
          {report.pushed.length} uploaded · {report.pulled.length} downloaded · {report.skipped.length} already up to date
        </p>
      </div>
      {report.pushed.length > 0 && <p className="text-muted">Uploaded: {names(report.pushed)}</p>}
      {report.pulled.length > 0 && <p className="text-muted">Downloaded: {names(report.pulled)}</p>}
      {report.conflicts.length > 0 && (
        <div className="flex flex-col gap-2">
          <StatusLine tone="gold" icon={<TriangleAlert className="size-4" aria-hidden />}>
            <span className="font-medium">
              {plural(report.conflicts.length, 'campaign')} changed both here and on GitHub. Choose which copy to keep:
            </span>
          </StatusLine>
          <ul className="flex flex-col gap-2">
            {report.conflicts.map((conflict) => (
              <ConflictRow key={conflict.campaignId} conflict={conflict} gh={gh} onResolved={onResolved} />
            ))}
          </ul>
        </div>
      )}
      {report.errors.length > 0 && (
        <div>
          <p className="font-medium text-danger">Some saves didn’t sync:</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted">
            {report.errors.map((error, i) => (
              <li key={i} className="[overflow-wrap:anywhere]">
                {error}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ConflictRow({
  conflict,
  gh,
  onResolved,
}: {
  conflict: Conflict;
  gh: GithubSyncSettings;
  onResolved: (campaignId: string) => void;
}) {
  const [busy, setBusy] = useState<'local' | 'remote' | null>(null);

  const keep = async (side: 'local' | 'remote') => {
    setBusy(side);
    try {
      if (side === 'local') {
        await pushCampaignToGithub(conflict.campaignId, gh);
        toast.success(`Uploaded this device’s “${conflict.name}” to GitHub.`);
      } else {
        const save = (await listRemoteSaves(gh)).find((s) => s.campaignId === conflict.campaignId);
        if (!save) throw new Error('That save is no longer on GitHub.');
        await pullCampaignFromGithub(save, gh);
        await reloadIfLoaded([conflict.campaignId]);
        toast.success(`Downloaded “${conflict.name}” from GitHub.`);
      }
      onResolved(conflict.campaignId);
    } catch (error) {
      toast.error(errorMessage(error, 'Could not resolve the conflict.'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <li className="flex flex-col gap-2 rounded-lg border border-border bg-surface px-3 py-2.5 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <p className="font-medium [overflow-wrap:anywhere]">{conflict.name}</p>
        <p className="text-xs text-muted">
          This device: {formatRelativeTime(conflict.localUpdatedAt)} · GitHub: {formatRelativeTime(conflict.remoteUpdatedAt)}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" loading={busy === 'local'} disabled={busy !== null} onClick={() => void keep('local')}>
          Keep this device’s
        </Button>
        <Button size="sm" loading={busy === 'remote'} disabled={busy !== null} onClick={() => void keep('remote')}>
          Use GitHub’s
        </Button>
      </div>
    </li>
  );
}
