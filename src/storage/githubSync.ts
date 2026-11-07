/**
 * Optional cloud saves in the player's own PRIVATE GitHub repository (REST contents API).
 * Each campaign is one file, {path}/{campaignId}.solodm.json. Public repositories are refused by
 * every operation, because save files contain the player's story and notes.
 */
import type { Campaign, GithubSyncSettings } from '@/types';
import {
  BUNDLE_EXTENSION,
  BUNDLE_FORMAT,
  exportCampaignBundle,
  importBundle,
  parseCampaignBundle,
  serializeBundle,
} from './backup';
import { db } from './db';
import {
  loadTargetState,
  saveTargetState,
  syncTargetKey,
  type CampaignSyncEntry,
  type RemoteSaveMeta,
  type TargetSyncState,
} from './syncState';
import type { RemoteSave, SyncReport } from './types';

const API_ROOT = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const JSON_MEDIA = 'application/vnd.github+json';
const RAW_MEDIA = 'application/vnd.github.raw+json';
/** The contents API inlines file content only for files up to 1 MB; larger ones are fetched raw. */
const INLINE_CONTENT_LIMIT = 1_000_000;

export const PUBLIC_REPO_ERROR =
  'Saves can only sync to a PRIVATE repository. Make this repository private on GitHub, or choose a private one.';

export class GithubSyncError extends Error {
  readonly status: number;

  constructor(message: string, status = 0) {
    super(message);
    this.name = 'GithubSyncError';
    this.status = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// UTF-8 safe base64 (btoa/atob only handle Latin-1)
// ---------------------------------------------------------------------------

export function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToUtf8(base64: string): string {
  const binary = atob(base64.replace(/\s/g, ''));
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

interface Credentials {
  token: string;
  owner: string;
  repo: string;
  /** May be empty: the repository's default branch is used. */
  branch: string;
  /** Saves folder without leading/trailing slashes ('' = repository root). */
  dir: string;
}

interface RepoContext extends Credentials {
  branch: string;
  stateKey: string;
}

function readSettings(settings: GithubSyncSettings): Credentials {
  const token = settings.token.trim();
  const owner = settings.owner.trim();
  const repo = settings.repo.trim().replace(/\.git$/i, '');
  if (!token) throw new GithubSyncError('Add a GitHub personal access token first.');
  if (!owner || !repo) throw new GithubSyncError('Enter the owner and name of your private saves repository.');
  return { token, owner, repo, branch: settings.branch.trim(), dir: settings.path.trim().replace(/^\/+|\/+$/g, '') };
}

const enc = encodeURIComponent;

function repoPath(c: Credentials): string {
  return `/repos/${enc(c.owner)}/${enc(c.repo)}`;
}

function contentsPath(c: RepoContext, filePath: string, withRef = true): string {
  const encoded = filePath.split('/').filter(Boolean).map(enc).join('/');
  return `${repoPath(c)}/contents${encoded ? `/${encoded}` : ''}${withRef ? `?ref=${enc(c.branch)}` : ''}`;
}

async function request(
  c: Credentials,
  path: string,
  init: { method?: 'GET' | 'PUT'; body?: unknown; accept?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${c.token}`,
    Accept: init.accept ?? JSON_MEDIA,
    'X-GitHub-Api-Version': API_VERSION,
  };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  try {
    return await fetch(`${API_ROOT}${path}`, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      // GitHub marks API responses cacheable; a cached listing would hide a save pushed seconds ago.
      cache: 'no-store',
    });
  } catch {
    throw new GithubSyncError('Could not reach GitHub. Check your internet connection and try again.');
  }
}

async function failure(res: Response, subject: string): Promise<GithubSyncError> {
  let detail = '';
  try {
    const body: unknown = await res.json();
    if (isRecord(body) && typeof body.message === 'string') detail = body.message;
  } catch {
    // No JSON body.
  }
  const suffix = detail ? `: ${detail}` : '';
  switch (res.status) {
    case 401:
      return new GithubSyncError('GitHub rejected the token (401). Check that it is correct and has not expired.', 401);
    case 403:
    case 429:
      if (res.status === 429 || res.headers.get('x-ratelimit-remaining') === '0' || /rate limit/i.test(detail)) {
        return new GithubSyncError('GitHub rate limit reached. Wait a few minutes, then try again.', res.status);
      }
      return new GithubSyncError(
        'GitHub denied access (403). The token needs "Contents: Read and write" permission on this repository.',
        403,
      );
    case 404:
      return new GithubSyncError(
        `${subject} was not found on GitHub (404). Check the owner, repository name and branch, and that the token can access the repository.`,
        404,
      );
    case 409:
      return new GithubSyncError('The save changed on GitHub during the sync (409). Sync again.', 409);
    default:
      return new GithubSyncError(`GitHub error ${res.status}${suffix}.`, res.status);
  }
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return (await res.json()) as unknown;
  } catch {
    throw new GithubSyncError('GitHub sent a response Solo DM could not read.');
  }
}

// ---------------------------------------------------------------------------
// Repository access
// ---------------------------------------------------------------------------

interface RepoInfo {
  isPrivate: boolean;
  defaultBranch: string;
  /** Whether the token's user may push (null when GitHub doesn't say). */
  canPush: boolean | null;
}

async function fetchRepo(c: Credentials): Promise<RepoInfo> {
  const res = await request(c, repoPath(c));
  if (!res.ok) throw await failure(res, `The repository ${c.owner}/${c.repo}`);
  const body = await readJson(res);
  if (!isRecord(body)) throw new GithubSyncError('GitHub sent a response Solo DM could not read.');
  const permissions = isRecord(body.permissions) ? body.permissions : null;
  return {
    isPrivate: body.private === true,
    defaultBranch: typeof body.default_branch === 'string' && body.default_branch ? body.default_branch : 'main',
    canPush: typeof permissions?.push === 'boolean' ? permissions.push : null,
  };
}

/** Resolve the settings to a repository context, refusing anything that isn't private. */
async function openRepo(settings: GithubSyncSettings): Promise<RepoContext> {
  const c = readSettings(settings);
  const info = await fetchRepo(c);
  if (!info.isPrivate) throw new GithubSyncError(PUBLIC_REPO_ERROR);
  const branch = c.branch || info.defaultBranch;
  return { ...c, branch, stateKey: syncTargetKey(c.owner, c.repo, branch, c.dir) };
}

interface RemoteFile {
  name: string;
  path: string;
  sha: string;
  size: number;
}

async function listSaveFiles(ctx: RepoContext): Promise<RemoteFile[]> {
  const res = await request(ctx, contentsPath(ctx, ctx.dir));
  // A missing folder (or an empty repository) simply has no saves yet.
  if (res.status === 404) return [];
  if (!res.ok) throw await failure(res, `The saves folder "${ctx.dir || '/'}"`);
  const body = await readJson(res);
  if (!Array.isArray(body)) {
    throw new GithubSyncError(`"${ctx.dir}" in the repository is a file, not a folder. Choose a folder for your saves.`);
  }
  return body.flatMap((item: unknown): RemoteFile[] =>
    isRecord(item) &&
    item.type === 'file' &&
    typeof item.name === 'string' &&
    item.name.endsWith(BUNDLE_EXTENSION) &&
    typeof item.path === 'string' &&
    typeof item.sha === 'string'
      ? [{ name: item.name, path: item.path, sha: item.sha, size: typeof item.size === 'number' ? item.size : 0 }]
      : [],
  );
}

/** Download a file's text: inline base64 for small files, the raw media type for large ones. */
async function readFileText(ctx: RepoContext, file: { path: string; size?: number }): Promise<{ text: string; sha?: string }> {
  const subject = `The save file ${file.path}`;
  if ((file.size ?? 0) <= INLINE_CONTENT_LIMIT) {
    const res = await request(ctx, contentsPath(ctx, file.path));
    if (!res.ok) throw await failure(res, subject);
    const body = await readJson(res);
    if (isRecord(body) && body.encoding === 'base64' && typeof body.content === 'string') {
      return { text: base64ToUtf8(body.content), sha: typeof body.sha === 'string' ? body.sha : undefined };
    }
  }
  const raw = await request(ctx, contentsPath(ctx, file.path), { accept: RAW_MEDIA });
  if (!raw.ok) throw await failure(raw, subject);
  return { text: await raw.text() };
}

function readSaveMeta(text: string, path: string): RemoteSaveMeta {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new GithubSyncError(`${path} is not valid JSON.`);
  }
  const campaign = isRecord(value) && value.format === BUNDLE_FORMAT && isRecord(value.campaign) ? value.campaign : null;
  if (!campaign || typeof campaign.id !== 'string' || !campaign.id || typeof campaign.name !== 'string' || typeof campaign.updatedAt !== 'number') {
    throw new GithubSyncError(`${path} is not a Solo DM save file.`);
  }
  return { campaignId: campaign.id, name: campaign.name, updatedAt: campaign.updatedAt };
}

/**
 * List the saves in the folder, reading each one's campaign name and updatedAt. Metadata is cached
 * by blob sha (in the sync state), so unchanged saves are never downloaded twice. Texts downloaded
 * here are kept in `downloaded` for a pull in the same run.
 */
async function listSaves(
  ctx: RepoContext,
  state: TargetSyncState,
  downloaded: Map<string, string>,
): Promise<{ saves: RemoteSave[]; errors: string[] }> {
  const files = await listSaveFiles(ctx);
  const saves: RemoteSave[] = [];
  const errors: string[] = [];
  const meta: Record<string, RemoteSaveMeta> = {};
  for (const file of files) {
    try {
      let sha = file.sha;
      let info = state.remoteMeta[sha];
      if (!info) {
        const read = await readFileText(ctx, file);
        sha = read.sha ?? sha;
        info = readSaveMeta(read.text, file.path);
        downloaded.set(sha, read.text);
      }
      meta[sha] = info;
      saves.push({ ...info, path: file.path, sha });
    } catch (error) {
      errors.push(`${file.name}: ${errorMessage(error)}`);
    }
  }
  state.remoteMeta = meta;
  return { saves, errors };
}

/** One save per campaign; when a campaign has several files, the canonical file name wins. */
function savesByCampaign(saves: RemoteSave[]): Map<string, RemoteSave> {
  const byId = new Map<string, RemoteSave>();
  for (const save of saves) {
    const current = byId.get(save.campaignId);
    const canonical = save.path.endsWith(`/${save.campaignId}${BUNDLE_EXTENSION}`) || save.path === `${save.campaignId}${BUNDLE_EXTENSION}`;
    if (!current || canonical) byId.set(save.campaignId, save);
  }
  return byId;
}

async function pushOne(
  ctx: RepoContext,
  state: TargetSyncState,
  campaignId: string,
  existing?: { path: string; sha: string },
): Promise<void> {
  const bundle = await exportCampaignBundle(campaignId);
  const path = existing?.path ?? [ctx.dir, `${campaignId}${BUNDLE_EXTENSION}`].filter(Boolean).join('/');
  const res = await request(ctx, contentsPath(ctx, path, false), {
    method: 'PUT',
    body: {
      message: `${existing ? 'Update' : 'Add'} save: ${bundle.campaign.name}`,
      content: utf8ToBase64(serializeBundle(bundle)),
      branch: ctx.branch,
      ...(existing && { sha: existing.sha }),
    },
  });
  if (!res.ok) throw await failure(res, 'The save file');
  const body = await readJson(res);
  const sha = isRecord(body) && isRecord(body.content) && typeof body.content.sha === 'string' ? body.content.sha : null;
  if (!sha) throw new GithubSyncError('GitHub did not confirm the upload. Sync again.');
  const { name, updatedAt } = bundle.campaign;
  state.campaigns[campaignId] = { remoteSha: sha, localUpdatedAt: updatedAt, syncedAt: Date.now() };
  state.remoteMeta[sha] = { campaignId, name, updatedAt };
}

async function pullOne(ctx: RepoContext, state: TargetSyncState, save: RemoteSave, text?: string): Promise<Campaign> {
  const content = text ?? (await readFileText(ctx, save)).text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    throw new GithubSyncError(`${save.path} is not valid JSON.`);
  }
  // Pulls keep the save's ids so this device and GitHub keep matching; a clash is an error, not a copy.
  const campaign = await importBundle(parseCampaignBundle(parsed), 'replace', 'fail');
  state.campaigns[campaign.id] = { remoteSha: save.sha, localUpdatedAt: campaign.updatedAt, syncedAt: Date.now() };
  return campaign;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function testGithubConnection(
  settings: GithubSyncSettings,
): Promise<{ ok: boolean; private?: boolean; error?: string }> {
  try {
    const c = readSettings(settings);
    const info = await fetchRepo(c);
    if (!info.isPrivate) return { ok: false, private: false, error: PUBLIC_REPO_ERROR };
    if (info.canPush === false) {
      return {
        ok: false,
        private: true,
        error: 'This token can read the repository but not write to it. Give it "Contents: Read and write" permission.',
      };
    }
    if (c.branch && c.branch !== info.defaultBranch) {
      const res = await request(c, `${repoPath(c)}/branches/${enc(c.branch)}`);
      if (res.status === 404) {
        return {
          ok: false,
          private: true,
          error: `Branch "${c.branch}" doesn't exist in this repository (its default branch is "${info.defaultBranch}").`,
        };
      }
      if (!res.ok) throw await failure(res, `Branch "${c.branch}"`);
    }
    return { ok: true, private: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

/** Saves in the repository folder, most recently updated first. Unreadable files are skipped (and logged). */
export async function listRemoteSaves(settings: GithubSyncSettings): Promise<RemoteSave[]> {
  const ctx = await openRepo(settings);
  const state = loadTargetState(ctx.stateKey);
  const { saves, errors } = await listSaves(ctx, state, new Map());
  saveTargetState(ctx.stateKey, state);
  for (const error of errors) console.warn('[storage] Skipped a GitHub save:', error);
  return saves.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Upload the campaign, replacing its save on GitHub. */
export async function pushCampaignToGithub(campaignId: string, settings: GithubSyncSettings): Promise<void> {
  const ctx = await openRepo(settings);
  const state = loadTargetState(ctx.stateKey);
  const fileName = `${campaignId}${BUNDLE_EXTENSION}`;
  const existing = (await listSaveFiles(ctx)).find((f) => f.name === fileName);
  await pushOne(ctx, state, campaignId, existing);
  saveTargetState(ctx.stateKey, state);
}

/** Download a save, replacing the local campaign with the same id (if any). */
export async function pullCampaignFromGithub(save: RemoteSave, settings: GithubSyncSettings): Promise<Campaign> {
  const ctx = await openRepo(settings);
  const state = loadTargetState(ctx.stateKey);
  const campaign = await pullOne(ctx, state, save);
  saveTargetState(ctx.stateKey, state);
  return campaign;
}

export type SyncDecision = 'push' | 'pull' | 'conflict' | 'in-sync' | 'skip';

/**
 * What to do with one campaign. Without a record of an earlier sync the newer side wins;
 * with one, a side changed if its updatedAt (local) or blob sha (remote) moved since then.
 */
export function decideSync(
  local: Pick<Campaign, 'updatedAt'> | undefined,
  remote: Pick<RemoteSave, 'sha' | 'updatedAt'> | undefined,
  last: CampaignSyncEntry | undefined,
): SyncDecision {
  if (local && !remote) return 'push';
  if (!local && remote) {
    const deletedHere = last?.deletedAt !== undefined && last.remoteSha === remote.sha;
    return deletedHere ? 'skip' : 'pull';
  }
  if (!local || !remote) return 'skip';
  if (!last || last.deletedAt !== undefined) {
    if (local.updatedAt === remote.updatedAt) return 'in-sync';
    return local.updatedAt > remote.updatedAt ? 'push' : 'pull';
  }
  const localChanged = local.updatedAt !== last.localUpdatedAt;
  const remoteChanged = remote.sha !== last.remoteSha;
  if (localChanged && remoteChanged) return local.updatedAt === remote.updatedAt ? 'in-sync' : 'conflict';
  if (localChanged) return 'push';
  if (remoteChanged) return 'pull';
  return 'skip';
}

/**
 * Two-way sync. Pushes local-only and locally changed campaigns, pulls remote-only and remotely
 * changed ones, and reports campaigns changed on both sides since the last sync as conflicts
 * (neither side is overwritten). Per-campaign failures are collected in `errors`; problems with
 * the repository itself (bad token, public repo...) throw.
 */
export async function syncWithGithub(settings: GithubSyncSettings): Promise<SyncReport> {
  const ctx = await openRepo(settings);
  const state = loadTargetState(ctx.stateKey);
  const downloaded = new Map<string, string>();
  const report: SyncReport = { pushed: [], pulled: [], skipped: [], conflicts: [], errors: [] };
  try {
    const listing = await listSaves(ctx, state, downloaded);
    report.errors.push(...listing.errors);
    const remoteById = savesByCampaign(listing.saves);
    const localById = new Map((await db.campaigns.toArray()).map((c) => [c.id, c]));
    // Forget campaigns that are gone from both sides (old tombstones included).
    for (const id of Object.keys(state.campaigns)) {
      if (!localById.has(id) && !remoteById.has(id)) delete state.campaigns[id];
    }
    for (const id of new Set([...localById.keys(), ...remoteById.keys()])) {
      const local = localById.get(id);
      const remote = remoteById.get(id);
      try {
        switch (decideSync(local, remote, state.campaigns[id])) {
          case 'push':
            await pushOne(ctx, state, id, remote);
            report.pushed.push(id);
            break;
          case 'pull':
            if (remote) await pullOne(ctx, state, remote, downloaded.get(remote.sha));
            report.pulled.push(id);
            break;
          case 'conflict':
            report.conflicts.push({
              campaignId: id,
              name: local?.name ?? remote?.name ?? id,
              localUpdatedAt: local?.updatedAt ?? 0,
              remoteUpdatedAt: remote?.updatedAt ?? 0,
            });
            break;
          case 'in-sync':
            if (local && remote) {
              state.campaigns[id] = { remoteSha: remote.sha, localUpdatedAt: local.updatedAt, syncedAt: Date.now() };
            }
            report.skipped.push(id);
            break;
          case 'skip':
            report.skipped.push(id);
            break;
        }
      } catch (error) {
        report.errors.push(`${local?.name ?? remote?.name ?? id}: ${errorMessage(error)}`);
      }
    }
  } finally {
    saveTargetState(ctx.stateKey, state);
  }
  return report;
}
