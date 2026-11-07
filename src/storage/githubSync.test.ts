import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GithubSyncSettings } from '@/types';
import { DEFAULT_SETTINGS } from '@/types';
import {
  INTERNAL_REPO_ERROR,
  PUBLIC_REPO_ERROR,
  deleteCampaign,
  exportCampaignBundle,
  getCampaign,
  getImage,
  listRemoteSaves,
  pullCampaignFromGithub,
  pushCampaignToGithub,
  saveImage,
  syncWithGithub,
  testGithubConnection,
} from '@/storage';
import { wrapImported } from '@/lib/importedContent';
import { db } from './db';
import { serializeBundle } from './backup';
import { base64ToUtf8, decideSync, utf8ToBase64 } from './githubSync';
import { SYNC_STATE_KEY } from './syncState';
import { campaignGraph, resetDatabase, seedCampaign } from './testData';

const RAW = 'application/vnd.github.raw+json';

// Independent of the implementation under test.
function encodeBase64(text: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function decodeBase64(base64: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));
}
const byteLength = (text: string) => new TextEncoder().encode(text).length;

interface Call {
  method: string;
  path: string;
  search: string;
  headers: Headers;
  body?: Record<string, unknown>;
}

/** Just enough of the GitHub REST API (repos, branches, contents) for these tests. */
class FakeGithub {
  repo: Record<string, unknown> = { private: true, default_branch: 'main', permissions: { push: true } };
  branches = new Set(['main']);
  files = new Map<string, { text: string; sha: string }>();
  calls: Call[] = [];
  /** Respond to matching requests with this status instead. */
  failures: { method: string; path: RegExp; status: number }[] = [];
  private shaCounter = 0;

  nextSha(): string {
    this.shaCounter += 1;
    return `sha-${this.shaCounter}`;
  }

  /** Put a file as another device would. */
  setFile(path: string, text: string): string {
    const sha = this.nextSha();
    this.files.set(path, { text, sha });
    return sha;
  }

  callsTo(method: string, pathPart = ''): Call[] {
    return this.calls.filter((c) => c.method === method && c.path.includes(pathPart));
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    this.calls.push({ method, path: url.pathname, search: url.search, headers, body });
    const json = (status: number, payload: unknown) =>
      new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

    const failure = this.failures.find((f) => f.method === method && f.path.test(decodeURIComponent(url.pathname)));
    if (failure) return json(failure.status, { message: `Simulated ${failure.status}` });
    if (url.origin !== 'https://api.github.com') return json(404, { message: 'Not Found' });
    if (headers.get('authorization') !== 'Bearer good-token') return json(401, { message: 'Bad credentials' });
    const match = /^\/repos\/mira\/saves(\/.*)?$/.exec(url.pathname);
    if (!match) return json(404, { message: 'Not Found' });
    const rest = match[1] ?? '';
    if (rest === '') return json(200, this.repo);
    if (rest.startsWith('/branches/')) {
      return this.branches.has(decodeURIComponent(rest.slice('/branches/'.length)))
        ? json(200, { name: 'x' })
        : json(404, { message: 'Branch not found' });
    }
    if (!rest.startsWith('/contents')) return json(404, { message: 'Not Found' });
    const path = rest
      .slice('/contents'.length)
      .split('/')
      .filter(Boolean)
      .map(decodeURIComponent)
      .join('/');

    if (method === 'GET') {
      const file = this.files.get(path);
      if (file) {
        if (headers.get('accept') === RAW) return new Response(file.text, { status: 200 });
        const large = byteLength(file.text) > 1_000_000;
        const content = large ? '' : (encodeBase64(file.text).match(/.{1,60}/g) ?? []).join('\n');
        return json(200, {
          type: 'file',
          name: path.split('/').pop(),
          path,
          sha: file.sha,
          size: byteLength(file.text),
          encoding: large ? 'none' : 'base64',
          content,
        });
      }
      const children = [...this.files.entries()].filter(([p]) => p.split('/').slice(0, -1).join('/') === path);
      const subdirs = [...this.files.keys()].some((p) => p.startsWith(`${path}/`) && p.split('/').length > path.split('/').length + 1);
      if (children.length === 0 && !subdirs) return json(404, { message: 'Not Found' });
      return json(200, [
        ...children.map(([p, f]) => ({ type: 'file', name: p.split('/').pop(), path: p, sha: f.sha, size: byteLength(f.text) })),
        ...(subdirs ? [{ type: 'dir', name: 'old', path: `${path}/old`, sha: 'tree-sha', size: 0 }] : []),
      ]);
    }

    if (method === 'PUT' && body) {
      const existing = this.files.get(path);
      if (existing && body.sha === undefined) return json(422, { message: 'Invalid request. "sha" wasn\'t supplied.' });
      if ((existing && body.sha !== existing.sha) || (!existing && body.sha !== undefined)) {
        return json(409, { message: 'does not match' });
      }
      const sha = this.nextSha();
      this.files.set(path, { text: decodeBase64(String(body.content)), sha });
      return json(existing ? 200 : 201, { content: { path, sha }, commit: { sha: `commit-${sha}` } });
    }
    return json(404, { message: 'Not Found' });
  };
}

const settings = (overrides: Partial<GithubSyncSettings> = {}): GithubSyncSettings => ({
  ...DEFAULT_SETTINGS.githubSync,
  enabled: true,
  token: 'good-token',
  owner: 'mira',
  repo: 'saves',
  ...overrides,
});

let github: FakeGithub;

beforeEach(async () => {
  await resetDatabase();
  github = new FakeGithub();
  vi.stubGlobal('fetch', vi.fn(github.fetch));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The bundle text of a local campaign, as another device would have pushed it. */
async function bundleText(campaignId: string, edit?: (b: Record<string, unknown>) => void): Promise<string> {
  const bundle = JSON.parse(serializeBundle(await exportCampaignBundle(campaignId))) as Record<string, unknown>;
  edit?.(bundle);
  return JSON.stringify(bundle);
}

function remoteCampaign(path: string): { id: string; name: string; updatedAt: number } {
  const file = github.files.get(path);
  if (!file) throw new Error(`no remote file ${path}`);
  return (JSON.parse(file.text) as { campaign: { id: string; name: string; updatedAt: number } }).campaign;
}

describe('base64 helpers', () => {
  it('round-trip UTF-8 text that btoa alone cannot encode', () => {
    const text = 'Mira 🧝‍♀️ — Ærendil, 龍の灯台, "quotes"';
    expect(base64ToUtf8(utf8ToBase64(text))).toBe(text);
    expect(utf8ToBase64(text)).toBe(encodeBase64(text));
    const big = 'é'.repeat(100_000);
    expect(base64ToUtf8(utf8ToBase64(big))).toBe(big);
  });
});

describe('testGithubConnection', () => {
  it('accepts a private repository and sends the GitHub API headers', async () => {
    expect(await testGithubConnection(settings())).toEqual({ ok: true, private: true });
    const [call] = github.calls;
    expect(call.path).toBe('/repos/mira/saves');
    expect(call.headers.get('authorization')).toBe('Bearer good-token');
    expect(call.headers.get('accept')).toBe('application/vnd.github+json');
    expect(call.headers.get('x-github-api-version')).toBe('2022-11-28');
  });

  it('refuses public repositories', async () => {
    github.repo.private = false;
    const result = await testGithubConnection(settings());
    expect(result).toEqual({ ok: false, private: false, error: PUBLIC_REPO_ERROR });
    expect(result.error).toMatch(/Saves can only sync to a PRIVATE repository/);
  });

  it('refuses internal repositories, which GitHub also reports as private (visibility decides)', async () => {
    github.repo = { ...github.repo, private: true, visibility: 'internal' };
    expect(await testGithubConnection(settings())).toEqual({ ok: false, error: INTERNAL_REPO_ERROR });
    await expect(listRemoteSaves(settings())).rejects.toThrow(INTERNAL_REPO_ERROR);
    await seedCampaign('a');
    await expect(pushCampaignToGithub('a-camp', settings())).rejects.toThrow(INTERNAL_REPO_ERROR);
    await expect(syncWithGithub(settings())).rejects.toThrow(INTERNAL_REPO_ERROR);
    expect(github.callsTo('PUT')).toHaveLength(0);

    github.repo = { ...github.repo, private: false, visibility: 'public' };
    expect(await testGithubConnection(settings())).toEqual({ ok: false, private: false, error: PUBLIC_REPO_ERROR });
    github.repo = { ...github.repo, private: true, visibility: 'private' };
    expect(await testGithubConnection(settings())).toEqual({ ok: true, private: true });
  });

  it.each([
    [401, /rejected the token/],
    [403, /denied access.*Contents/],
    [404, /not found.*owner, repository name/],
  ])('maps HTTP %i to a friendly message', async (status, message) => {
    github.failures.push({ method: 'GET', path: /^\/repos\/mira\/saves$/, status });
    const result = await testGithubConnection(settings());
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(message);
  });

  it('reports a bad token, a missing branch, a read-only token and an unreachable network', async () => {
    expect((await testGithubConnection(settings({ token: 'bad' }))).error).toMatch(/rejected the token/);
    expect((await testGithubConnection(settings({ branch: 'saves-branch' }))).error).toMatch(/default branch is "main"/);
    github.branches.add('saves-branch');
    expect(await testGithubConnection(settings({ branch: 'saves-branch' }))).toEqual({ ok: true, private: true });
    github.repo.permissions = { push: false };
    expect((await testGithubConnection(settings())).error).toMatch(/not write/);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    expect((await testGithubConnection(settings())).error).toMatch(/Could not reach GitHub/);
  });

  it('asks for a token and a repository before calling GitHub', async () => {
    expect((await testGithubConnection(settings({ token: ' ' }))).error).toMatch(/token/);
    expect((await testGithubConnection(settings({ repo: '' }))).error).toMatch(/owner and name/);
    expect(github.calls).toHaveLength(0);
  });
});

describe('pushCampaignToGithub', () => {
  it("never uploads the player's imported-book text from the DM's rules lookups", async () => {
    await seedCampaign('a');
    await db.transcript.put({
      id: 'a-t6',
      sessionId: 'a-sess-2',
      seq: 4,
      createdAt: 6,
      param: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: wrapImported('My Book', 'COPYRIGHTED TEXT') }] },
    });

    await pushCampaignToGithub('a-camp', settings());

    const uploaded = github.files.get('saves/a-camp.solodm.json')?.text ?? '';
    expect(uploaded).toContain('toolu_1');
    expect(uploaded).not.toContain('COPYRIGHTED TEXT');
    expect(uploaded).toContain('was left out of this copy');
  });
});

describe('GitHub saves and illustrations', () => {
  it('never uploads pictures or their prompts, and a pull keeps the pictures on this device', async () => {
    await seedCampaign('a');
    await db.log.put({
      id: 'a-log-img',
      campaignId: 'a-camp',
      sessionId: 'a-sess-2',
      seq: 100,
      createdAt: 7,
      kind: 'image',
      imageId: 'img-1',
      title: 'The lighthouse',
      subject: 'scene',
      status: 'ready',
    });
    await saveImage({
      id: 'img-1',
      campaignId: 'a-camp',
      sessionId: 'a-sess-2',
      title: 'The lighthouse',
      subject: 'scene',
      prompt: 'SECRET PAINTING PROMPT',
      model: 'gpt-image-2.5-flare',
      mime: 'image/webp',
      blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/webp' }),
      createdAt: 7,
    });

    await pushCampaignToGithub('a-camp', settings());
    const uploaded = github.files.get('saves/a-camp.solodm.json')?.text ?? '';
    expect(uploaded).toContain('"imageId": "img-1"');
    expect(uploaded).not.toContain('SECRET PAINTING PROMPT');
    expect(uploaded).not.toContain('"images"');

    const [save] = await listRemoteSaves(settings());
    await pullCampaignFromGithub(save, settings());
    expect(await getImage('img-1')).toBeDefined();
  });
});

describe('listRemoteSaves', () => {
  it('is empty when the saves folder does not exist yet', async () => {
    expect(await listRemoteSaves(settings())).toEqual([]);
  });

  it('reads each save’s name and updatedAt, caching them by sha', async () => {
    await seedCampaign('a', { campaign: { updatedAt: 111 } });
    await seedCampaign('b', { campaign: { updatedAt: 222 } });
    const shaA = github.setFile('saves/a-camp.solodm.json', await bundleText('a-camp'));
    github.setFile('saves/b-camp.solodm.json', await bundleText('b-camp'));
    github.setFile('saves/README.md', '# not a save');
    github.setFile('saves/old/x.solodm.json', '{}');

    const saves = await listRemoteSaves(settings());

    expect(saves).toEqual([
      { campaignId: 'b-camp', name: 'Campaign b', updatedAt: 222, path: 'saves/b-camp.solodm.json', sha: 'sha-2' },
      { campaignId: 'a-camp', name: 'Campaign a', updatedAt: 111, path: 'saves/a-camp.solodm.json', sha: shaA },
    ]);
    expect(github.callsTo('GET', '.solodm.json')).toHaveLength(2);

    // Unchanged files are not downloaded again; a changed one is.
    github.setFile('saves/b-camp.solodm.json', await bundleText('b-camp', (b) => {
      (b.campaign as Record<string, unknown>).name = 'Renamed elsewhere';
    }));
    github.calls = [];
    const again = await listRemoteSaves(settings());
    expect(github.callsTo('GET', '.solodm.json').map((c) => c.path)).toEqual(['/repos/mira/saves/contents/saves/b-camp.solodm.json']);
    expect(again.find((s) => s.campaignId === 'b-camp')?.name).toBe('Renamed elsewhere');
  });

  it('downloads saves over 1 MB with the raw media type', async () => {
    await seedCampaign('a', { campaign: { premise: 'x'.repeat(1_100_000) } });
    github.setFile('saves/a-camp.solodm.json', await bundleText('a-camp'));

    const [save] = await listRemoteSaves(settings());

    expect(save.campaignId).toBe('a-camp');
    const fileCalls = github.callsTo('GET', '.solodm.json');
    expect(fileCalls.map((c) => c.headers.get('accept'))).toEqual([RAW]);
  });

  it('skips unreadable files', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    github.setFile('saves/broken.solodm.json', '{ not json');
    expect(await listRemoteSaves(settings())).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it('refuses public repositories without reading anything', async () => {
    github.repo.private = false;
    await expect(listRemoteSaves(settings())).rejects.toThrow(PUBLIC_REPO_ERROR);
    expect(github.callsTo('GET', '/contents')).toHaveLength(0);
  });
});

describe('pushCampaignToGithub', () => {
  it('creates {path}/{campaignId}.solodm.json, then updates it with the current sha', async () => {
    await seedCampaign('a', { campaign: { name: 'Mira’s Lantern 🏮 — Ærendil' } });

    await pushCampaignToGithub('a-camp', settings());

    const [create] = github.callsTo('PUT');
    expect(create.path).toBe('/repos/mira/saves/contents/saves/a-camp.solodm.json');
    expect(create.body).toMatchObject({ branch: 'main', message: 'Add save: Mira’s Lantern 🏮 — Ærendil' });
    expect(create.body).not.toHaveProperty('sha');
    const pushed = JSON.parse(decodeBase64(String(create.body?.content))) as { format: string; campaign: { name: string } };
    expect(pushed.format).toBe('solo-dm-campaign');
    expect(pushed.campaign.name).toBe('Mira’s Lantern 🏮 — Ærendil');

    const firstSha = github.files.get('saves/a-camp.solodm.json')?.sha;
    await pushCampaignToGithub('a-camp', settings());
    const update = github.callsTo('PUT')[1];
    expect(update.body).toMatchObject({ sha: firstSha, branch: 'main', message: 'Update save: Mira’s Lantern 🏮 — Ærendil' });

    const state = JSON.parse(localStorage.getItem(SYNC_STATE_KEY) ?? '{}') as {
      targets: Record<string, { campaigns: Record<string, { remoteSha: string }> }>;
    };
    expect(state.targets['mira/saves#main:saves'].campaigns['a-camp'].remoteSha).toBe(
      github.files.get('saves/a-camp.solodm.json')?.sha,
    );
  });

  it('uses the configured folder and branch', async () => {
    await seedCampaign('a');
    github.branches.add('game');
    await pushCampaignToGithub('a-camp', settings({ path: '/solo/dm/', branch: 'game' }));
    expect(github.callsTo('PUT')[0].path).toBe('/repos/mira/saves/contents/solo/dm/a-camp.solodm.json');
    expect(github.callsTo('PUT')[0].body?.branch).toBe('game');
    expect(github.callsTo('GET', '/contents')[0].search).toBe('?ref=game');
  });

  it('refuses public repositories', async () => {
    await seedCampaign('a');
    github.repo.private = false;
    await expect(pushCampaignToGithub('a-camp', settings())).rejects.toThrow(/PRIVATE repository/);
    expect(github.callsTo('PUT')).toHaveLength(0);
  });
});

describe('pullCampaignFromGithub', () => {
  it('imports the remote save under its own ids', async () => {
    await seedCampaign('a');
    const text = await bundleText('a-camp');
    await deleteCampaign('a-camp');
    const sha = github.setFile('saves/a-camp.solodm.json', text);
    const [save] = await listRemoteSaves(settings());

    const campaign = await pullCampaignFromGithub(save, settings());

    expect(campaign.id).toBe('a-camp');
    expect(save.sha).toBe(sha);
    const { exportedAt: _e, format: _f, version: _v, ...data } = await exportCampaignBundle('a-camp');
    expect(data).toEqual(campaignGraph('a'));
  });
});

describe('syncWithGithub', () => {
  it('pushes local-only campaigns, pulls remote-only ones, then has nothing to do', async () => {
    await seedCampaign('local');
    await seedCampaign('remote');
    // A campaign that only exists on GitHub (never synced from this device).
    const remoteText = await bundleText('remote-camp');
    await deleteCampaign('remote-camp');
    github.setFile('saves/remote-camp.solodm.json', remoteText);

    const report = await syncWithGithub(settings());

    expect(report).toEqual({ pushed: ['local-camp'], pulled: ['remote-camp'], skipped: [], conflicts: [], errors: [] });
    expect(remoteCampaign('saves/local-camp.solodm.json').id).toBe('local-camp');
    expect((await getCampaign('remote-camp'))?.name).toBe('Campaign remote');

    github.calls = [];
    const second = await syncWithGithub(settings());
    expect(second).toEqual({ pushed: [], pulled: [], skipped: ['local-camp', 'remote-camp'], conflicts: [], errors: [] });
    expect(github.callsTo('PUT')).toHaveLength(0);
    // Both saves' metadata is cached, so nothing was downloaded either.
    expect(github.callsTo('GET', '.solodm.json')).toHaveLength(0);
  });

  it('pushes local changes (with the remote sha) and pulls remote changes', async () => {
    await seedCampaign('a');
    await seedCampaign('b');
    await syncWithGithub(settings());
    const shaA = github.files.get('saves/a-camp.solodm.json')?.sha;

    // Local edit to a; another device edits b.
    await db.campaigns.update('a-camp', { name: 'Edited here', updatedAt: Date.now() + 1000 });
    github.setFile(
      'saves/b-camp.solodm.json',
      await bundleText('b-camp', (bundle) => {
        const campaign = bundle.campaign as Record<string, unknown>;
        campaign.name = 'Edited elsewhere';
        campaign.updatedAt = Date.now() + 2000;
      }),
    );
    github.calls = [];

    const report = await syncWithGithub(settings());

    expect(report).toMatchObject({ pushed: ['a-camp'], pulled: ['b-camp'], conflicts: [], errors: [] });
    expect(github.callsTo('PUT')[0].body?.sha).toBe(shaA);
    expect(remoteCampaign('saves/a-camp.solodm.json').name).toBe('Edited here');
    expect((await getCampaign('b-camp'))?.name).toBe('Edited elsewhere');
  });

  it('reports campaigns changed on both sides as conflicts and overwrites neither', async () => {
    await seedCampaign('a');
    await syncWithGithub(settings());
    await db.campaigns.update('a-camp', { name: 'Local edit', updatedAt: Date.now() + 1000 });
    const remoteUpdatedAt = Date.now() + 5000;
    const remoteText = await bundleText('a-camp', (bundle) => {
      const campaign = bundle.campaign as Record<string, unknown>;
      campaign.name = 'Remote edit';
      campaign.updatedAt = remoteUpdatedAt;
    });
    github.setFile('saves/a-camp.solodm.json', remoteText);
    const localUpdatedAt = (await getCampaign('a-camp'))?.updatedAt;
    github.calls = [];

    const report = await syncWithGithub(settings());

    expect(report.conflicts).toEqual([{ campaignId: 'a-camp', name: 'Local edit', localUpdatedAt, remoteUpdatedAt }]);
    expect(report.pushed).toEqual([]);
    expect(report.pulled).toEqual([]);
    expect(github.callsTo('PUT')).toHaveLength(0);
    expect(github.files.get('saves/a-camp.solodm.json')?.text).toBe(remoteText);
    expect((await getCampaign('a-camp'))?.name).toBe('Local edit');
    // Still a conflict next time: nothing was recorded as synced.
    expect((await syncWithGithub(settings())).conflicts).toHaveLength(1);
  });

  it('a conflict is resolved by pushing (keep this device) or pulling (keep GitHub)', async () => {
    await seedCampaign('a');
    await seedCampaign('b');
    await syncWithGithub(settings());
    for (const id of ['a-camp', 'b-camp']) {
      await db.campaigns.update(id, { name: 'Local edit', updatedAt: Date.now() + 1000 });
      github.setFile(`saves/${id}.solodm.json`, await bundleText(id, (bundle) => {
        const campaign = bundle.campaign as Record<string, unknown>;
        campaign.name = 'Remote edit';
        campaign.updatedAt = Date.now() + 5000;
      }));
    }
    expect((await syncWithGithub(settings())).conflicts.map((c) => c.campaignId)).toEqual(['a-camp', 'b-camp']);

    await pushCampaignToGithub('a-camp', settings());
    const remoteB = (await listRemoteSaves(settings())).find((s) => s.campaignId === 'b-camp');
    if (!remoteB) throw new Error('missing remote save');
    await pullCampaignFromGithub(remoteB, settings());

    const report = await syncWithGithub(settings());
    expect(report).toMatchObject({ conflicts: [], pushed: [], pulled: [], skipped: ['a-camp', 'b-camp'] });
    expect(remoteCampaign('saves/a-camp.solodm.json').name).toBe('Local edit');
    expect((await getCampaign('b-camp'))?.name).toBe('Remote edit');
  });

  it('lets the newer side win when this device has never synced the campaign', async () => {
    await seedCampaign('older-here', { campaign: { updatedAt: 1000 } });
    await seedCampaign('newer-here', { campaign: { updatedAt: 9000 } });
    github.setFile('saves/older-here-camp.solodm.json', await bundleText('older-here-camp', (b) => {
      (b.campaign as Record<string, unknown>).updatedAt = 5000;
      (b.campaign as Record<string, unknown>).name = 'Remote is newer';
    }));
    github.setFile('saves/newer-here-camp.solodm.json', await bundleText('newer-here-camp', (b) => {
      (b.campaign as Record<string, unknown>).updatedAt = 5000;
    }));

    const report = await syncWithGithub(settings());

    expect(report).toMatchObject({ pushed: ['newer-here-camp'], pulled: ['older-here-camp'], conflicts: [] });
    expect((await getCampaign('older-here-camp'))?.name).toBe('Remote is newer');
    expect(remoteCampaign('saves/newer-here-camp.solodm.json').updatedAt).toBe(9000);
  });

  it('collects per-campaign errors without stopping the rest of the sync', async () => {
    await seedCampaign('a');
    await seedCampaign('b');
    github.failures.push({ method: 'PUT', path: /a-camp/, status: 500 });
    github.setFile('saves/broken.solodm.json', 'not json');

    const report = await syncWithGithub(settings());

    expect(report.pushed).toEqual(['b-camp']);
    expect(report.errors).toHaveLength(2);
    expect(report.errors.join('\n')).toMatch(/broken\.solodm\.json: .*not valid JSON/);
    expect(report.errors.join('\n')).toMatch(/Campaign a: GitHub error 500/);
    // The failed campaign is retried next time.
    github.failures = [];
    expect((await syncWithGithub(settings())).pushed).toEqual(['a-camp']);
  });

  it('does not resurrect a campaign deleted here after syncing, unless it changes on GitHub', async () => {
    await seedCampaign('a');
    await syncWithGithub(settings());

    await deleteCampaign('a-camp');
    const report = await syncWithGithub(settings());
    expect(report).toMatchObject({ pulled: [], skipped: ['a-camp'] });
    expect(await getCampaign('a-camp')).toBeUndefined();

    github.setFile('saves/a-camp.solodm.json', github.files.get('saves/a-camp.solodm.json')?.text ?? '');
    expect((await syncWithGithub(settings())).pulled).toEqual(['a-camp']);
    expect(await getCampaign('a-camp')).toBeDefined();
  });

  it('throws for repository problems instead of returning a report', async () => {
    github.repo.private = false;
    await expect(syncWithGithub(settings())).rejects.toThrow(PUBLIC_REPO_ERROR);
    await expect(syncWithGithub(settings({ token: 'bad' }))).rejects.toThrow(/rejected the token/);
    expect(github.callsTo('PUT')).toHaveLength(0);
  });
});

describe('decideSync', () => {
  const last = { remoteSha: 's1', localUpdatedAt: 100, syncedAt: 1 };
  it.each([
    ['local only', { updatedAt: 1 }, undefined, undefined, 'push'],
    ['remote only', undefined, { sha: 's1', updatedAt: 1 }, undefined, 'pull'],
    ['deleted here, unchanged there', undefined, { sha: 's1', updatedAt: 1 }, { ...last, deletedAt: 5 }, 'skip'],
    ['deleted here, changed there', undefined, { sha: 's2', updatedAt: 1 }, { ...last, deletedAt: 5 }, 'pull'],
    ['never synced, same updatedAt', { updatedAt: 7 }, { sha: 's9', updatedAt: 7 }, undefined, 'in-sync'],
    ['never synced, local newer', { updatedAt: 8 }, { sha: 's9', updatedAt: 7 }, undefined, 'push'],
    ['never synced, remote newer', { updatedAt: 6 }, { sha: 's9', updatedAt: 7 }, undefined, 'pull'],
    ['unchanged', { updatedAt: 100 }, { sha: 's1', updatedAt: 100 }, last, 'skip'],
    ['local changed', { updatedAt: 150 }, { sha: 's1', updatedAt: 100 }, last, 'push'],
    ['remote changed', { updatedAt: 100 }, { sha: 's2', updatedAt: 120 }, last, 'pull'],
    ['both changed', { updatedAt: 150 }, { sha: 's2', updatedAt: 120 }, last, 'conflict'],
  ] as const)('%s → %s', (_label, local, remote, entry, expected) => {
    expect(decideSync(local, remote, entry)).toBe(expected);
  });
});
