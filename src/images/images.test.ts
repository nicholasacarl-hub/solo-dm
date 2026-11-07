import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { ImageLogEntry, LogEntry } from '@/types';
import { useGame, whenPersisted } from '@/state/gameStore';
import { useSettings } from '@/state/settingsStore';
import { deleteCampaign, getCampaign, getImage, listImages } from '@/storage';
import { db } from '@/storage/db';
import { resetDatabase, seedCampaign } from '@/storage/testData';
import {
  IMAGE_DECLINED,
  NOT_AT_TABLE,
  OPENAI_UNREACHABLE,
  canRetryIllustration,
  generatePortrait,
  imagesAvailable,
  isPainting,
  requestIllustration,
  retryIllustration,
  testOpenAiKey,
  usePicture,
} from '@/images';
import { portraitThumbnail } from './thumbnail';

const sdk = vi.hoisted(() => {
  class APIError extends Error {
    constructor(
      readonly status: number | undefined,
      readonly error: { message?: string; code?: string } | undefined,
      readonly code: string | null | undefined = error?.code,
    ) {
      super(`${status ?? ''} ${error?.message ?? 'Connection error.'}`.trim());
    }
  }
  class APIConnectionError extends APIError {
    constructor() {
      super(undefined, undefined);
    }
  }
  class APIConnectionTimeoutError extends APIConnectionError {}
  class APIUserAbortError extends APIError {
    constructor() {
      super(undefined, { message: 'Request was aborted.' });
    }
  }
  return {
    generate: vi.fn(),
    list: vi.fn(),
    options: [] as Record<string, unknown>[],
    APIError,
    APIConnectionError,
    APIConnectionTimeoutError,
    APIUserAbortError,
  };
});

vi.mock('openai', () => {
  class OpenAI {
    images = { generate: (...args: unknown[]) => sdk.generate(...args) };
    models = { list: (...args: unknown[]) => sdk.list(...args) };
    constructor(options: Record<string, unknown>) {
      sdk.options.push(options);
    }
  }
  const { APIError, APIConnectionError, APIConnectionTimeoutError, APIUserAbortError } = sdk;
  return { default: OpenAI, OpenAI, APIError, APIConnectionError, APIConnectionTimeoutError, APIUserAbortError };
});

vi.mock('./thumbnail', () => ({ portraitThumbnail: vi.fn(async () => 'data:image/jpeg;base64,THUMB') }));

const game = () => useGame.getState();
const KEY = 'sk-proj-test';

/** A successful images.generate response holding these bytes. */
function painted(bytes: number[] = [1, 2, 3], format = 'webp') {
  return { created: 1, data: [{ b64_json: btoa(String.fromCharCode(...bytes)) }], output_format: format };
}

/** images.generate calls that resolve or reject when the test says so. */
function heldGenerations() {
  const held: { resolve: (value: unknown) => void; reject: (error: unknown) => void }[] = [];
  sdk.generate.mockImplementation(
    () =>
      new Promise((resolve, reject) => {
        held.push({ resolve, reject });
      }),
  );
  return held;
}

const entryOf = (id: string) => game().log.find((e) => e.id === id) as ImageLogEntry | undefined;
const storedEntry = async (id: string) => (await db.log.get(id)) as LogEntry | undefined;

async function bytesOf(blob: Blob): Promise<number[]> {
  return [...new Uint8Array(await blob.arrayBuffer())];
}

const request = (overrides: Partial<Parameters<typeof requestIllustration>[0]> = {}) =>
  requestIllustration({
    campaignId: 'a-camp',
    title: 'The drowned lighthouse',
    subject: 'scene',
    prompt: 'A lighthouse on a black cliff, its lantern burning green through the fog',
    aspect: 'landscape',
    ...overrides,
  });

async function started(overrides: Parameters<typeof request>[0] = {}) {
  const start = await request(overrides);
  if (!start.ok) throw new Error(start.reason);
  return start;
}

beforeEach(async () => {
  game().unloadCampaign();
  await whenPersisted();
  await resetDatabase();
  sessionStorage.clear();
  useSettings.getState().reset();
  useSettings.getState().setOpenAiKey(KEY);
  sdk.generate.mockReset();
  sdk.list.mockReset();
  sdk.options.length = 0;
  await seedCampaign('a');
  await game().loadCampaign('a-camp');
});

afterEach(async () => {
  // Let background paintings settle before the next test resets the database.
  await vi.waitFor(() => expect(game().log.some((e) => e.kind === 'image' && isPainting(e.imageId))).toBe(false));
  await whenPersisted();
});

describe('imagesAvailable', () => {
  it('needs a key and a frequency other than off', () => {
    expect(imagesAvailable()).toEqual({ ok: true });
    useSettings.getState().updateImages({ frequency: 'off' });
    expect(imagesAvailable()).toEqual({ ok: false, reason: expect.stringMatching(/turned off/) });
    useSettings.getState().updateImages({ frequency: 'moments', openaiApiKey: '  ' });
    expect(imagesAvailable()).toEqual({ ok: false, reason: expect.stringMatching(/OpenAI API key/) });
    expect(imagesAvailable({ ...useSettings.getState(), images: { ...useSettings.getState().images, openaiApiKey: 'k' } })).toEqual({ ok: true });
  });
});

describe('requestIllustration', () => {
  it('adds a pending card at once, then paints, stores and marks it ready', async () => {
    const held = heldGenerations();
    const start = await started();

    expect(entryOf(start.logEntryId)).toMatchObject({
      kind: 'image',
      imageId: start.imageId,
      title: 'The drowned lighthouse',
      subject: 'scene',
      status: 'pending',
      sessionId: 'a-sess-2',
    });
    expect(await storedEntry(start.logEntryId)).toMatchObject({ status: 'pending' });
    expect(isPainting(start.imageId)).toBe(true);

    await vi.waitFor(() => expect(sdk.generate).toHaveBeenCalledTimes(1));
    const [params, options] = sdk.generate.mock.calls[0] as [Record<string, unknown>, unknown];
    expect(params).toMatchObject({ model: 'gpt-image-2.5-flare', size: '1536x1024', quality: 'medium', output_format: 'webp', n: 1 });
    expect(params).not.toHaveProperty('response_format');
    expect(options).toMatchObject({ signal: undefined });
    expect(sdk.options.at(-1)).toMatchObject({ apiKey: KEY, dangerouslyAllowBrowser: true });

    held[0].resolve(painted([9, 8, 7]));
    await vi.waitFor(() => expect(entryOf(start.logEntryId)?.status).toBe('ready'));
    expect(isPainting(start.imageId)).toBe(false);
    expect(await storedEntry(start.logEntryId)).toMatchObject({ status: 'ready' });

    const image = await getImage(start.imageId);
    expect(image).toMatchObject({
      campaignId: 'a-camp',
      sessionId: 'a-sess-2',
      title: 'The drowned lighthouse',
      subject: 'scene',
      mime: 'image/webp',
      model: 'gpt-image-2.5-flare',
    });
    expect(await bytesOf(image!.blob)).toEqual([9, 8, 7]);
    // The full prompt: the campaign's art style, the framing, the description, its lines and veils.
    expect(image!.prompt).toMatch(/^Art style: heroic fantasy oil painting/);
    expect(image!.prompt).toContain('wide establishing shot');
    expect(image!.prompt).toContain('its lantern burning green through the fog.');
    expect(image!.prompt).toContain('Never show: Harm to children, Torture.');
    expect(image!.prompt).not.toContain('Mira');
  });

  it("adds the hero's look when the hero is in the picture, and picks sizes by subject", async () => {
    sdk.generate.mockResolvedValue(painted());
    const portrait = await started({ subject: 'character', title: 'Mira', aspect: undefined, prompt: 'Mira on the cliff path' });
    const item = await started({ subject: 'item', title: 'The lantern', aspect: undefined, prompt: 'The green lantern' });
    await vi.waitFor(async () => expect(await getImage(item.imageId)).toBeDefined());
    await vi.waitFor(async () => expect(await getImage(portrait.imageId)).toBeDefined());

    const sizes = sdk.generate.mock.calls.map(([p]) => (p as { size: string }).size);
    expect(sizes).toEqual(['1024x1536', '1024x1024']);
    const prompt = (await getImage(portrait.imageId))!.prompt;
    expect(prompt).toContain('The hero in this picture: Mira Voss (she/her), an elf (High Elf lineage) wizard (Evoker).');
    expect(prompt).toContain('Appearance: Ink-stained fingers, sea-glass earrings.');
    expect((await getImage(item.imageId))!.prompt).not.toContain('The hero in this picture');
  });

  it('marks the card failed with a friendly reason, and stores nothing', async () => {
    sdk.generate.mockRejectedValueOnce(new sdk.APIError(400, { message: 'Rejected by the safety system', code: 'moderation_blocked' }));
    const declined = await started();
    await vi.waitFor(() => expect(entryOf(declined.logEntryId)).toMatchObject({ status: 'failed', error: IMAGE_DECLINED }));
    expect(await storedEntry(declined.logEntryId)).toMatchObject({ status: 'failed', error: IMAGE_DECLINED });
    expect(canRetryIllustration(declined.imageId)).toBe(false);

    sdk.generate.mockRejectedValueOnce(new sdk.APIConnectionError());
    const offline = await started();
    await vi.waitFor(() => expect(entryOf(offline.logEntryId)?.error).toMatch(new RegExp(`^${OPENAI_UNREACHABLE}`)));

    sdk.generate.mockRejectedValueOnce(new sdk.APIError(401, { message: 'Incorrect API key provided' }));
    const badKey = await started();
    await vi.waitFor(() => expect(entryOf(badKey.logEntryId)?.error).toMatch(/didn't accept your API key/));

    sdk.generate.mockResolvedValueOnce({ created: 1, data: [] });
    const empty = await started();
    await vi.waitFor(() => expect(entryOf(empty.logEntryId)?.error).toMatch(/sent back no picture/));

    expect(await listImages('a-camp')).toEqual([]);
  });

  it('paints at most two pictures at a time and queues the rest', async () => {
    const held = heldGenerations();
    const starts = [await started(), await started(), await started()];
    await vi.waitFor(() => expect(sdk.generate).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sdk.generate).toHaveBeenCalledTimes(2);
    expect(starts.every((s) => isPainting(s.imageId))).toBe(true);

    held[1].resolve(painted());
    await vi.waitFor(() => expect(sdk.generate).toHaveBeenCalledTimes(3));
    held[0].resolve(painted());
    held[2].resolve(painted());
    await vi.waitFor(() => expect(starts.map((s) => entryOf(s.logEntryId)?.status)).toEqual(['ready', 'ready', 'ready']));
  });

  it('still saves the picture and marks the card through storage when the player left the table', async () => {
    const held = heldGenerations();
    const start = await started();
    const before = (await getCampaign('a-camp'))!.updatedAt;
    await vi.waitFor(() => expect(sdk.generate).toHaveBeenCalledTimes(1));
    game().unloadCampaign();

    held[0].resolve(painted());
    await vi.waitFor(async () => expect(await storedEntry(start.logEntryId)).toMatchObject({ status: 'ready' }));
    expect(await getImage(start.imageId)).toBeDefined();
    expect((await getCampaign('a-camp'))!.updatedAt).toBeGreaterThan(before);

    // Next time the campaign is opened, the card shows the picture.
    await game().loadCampaign('a-camp');
    expect(entryOf(start.logEntryId)?.status).toBe('ready');
  });

  it('leaves no orphan picture when the campaign is deleted mid-painting', async () => {
    const held = heldGenerations();
    const start = await started();
    await vi.waitFor(() => expect(sdk.generate).toHaveBeenCalledTimes(1));
    await deleteCampaign('a-camp');

    held[0].resolve(painted());
    await vi.waitFor(() => expect(isPainting(start.imageId)).toBe(false));
    expect(await db.images.count()).toBe(0);
    expect(await db.imageData.count()).toBe(0);
  });

  it('refuses without a key, when turned off, away from the table, or with nothing to paint', async () => {
    const before = game().log.length;
    useSettings.getState().setOpenAiKey('');
    expect(await request()).toEqual({ ok: false, reason: expect.stringMatching(/OpenAI API key/) });
    useSettings.getState().setOpenAiKey(KEY);
    useSettings.getState().updateImages({ frequency: 'off' });
    expect(await request()).toEqual({ ok: false, reason: expect.stringMatching(/turned off/) });
    useSettings.getState().updateImages({ frequency: 'request' });
    expect(await request({ campaignId: 'b-camp' })).toEqual({ ok: false, reason: NOT_AT_TABLE });
    expect(await request({ prompt: '   ' })).toEqual({ ok: false, reason: expect.stringMatching(/description was empty/) });
    expect(game().log).toHaveLength(before);
    expect(sdk.generate).not.toHaveBeenCalled();
  });

  it('can paint a failed picture again from the same card', async () => {
    sdk.generate.mockRejectedValueOnce(new sdk.APIError(429, { message: 'Rate limit reached' }));
    const start = await started();
    await vi.waitFor(() => expect(entryOf(start.logEntryId)?.status).toBe('failed'));
    expect(canRetryIllustration(start.imageId)).toBe(true);

    sdk.generate.mockResolvedValueOnce(painted());
    expect(await retryIllustration(start.imageId)).toEqual({ ok: true });
    expect(entryOf(start.logEntryId)?.status).toBe('pending');
    await vi.waitFor(() => expect(entryOf(start.logEntryId)?.status).toBe('ready'));
    expect(entryOf(start.logEntryId)?.error).toBeUndefined();
    expect(await getImage(start.imageId)).toBeDefined();
    expect(game().log.filter((e) => e.kind === 'image')).toHaveLength(1);
    expect(await retryIllustration(start.imageId)).toEqual({ ok: false, reason: expect.any(String) });
  });
});

describe('testOpenAiKey', () => {
  it('checks the key with the model list and paints nothing', async () => {
    sdk.list.mockResolvedValue({ data: [] });
    expect(await testOpenAiKey('  sk-proj-new  ')).toEqual({ ok: true });
    expect(sdk.options.at(-1)).toMatchObject({ apiKey: 'sk-proj-new', dangerouslyAllowBrowser: true });
    expect(sdk.generate).not.toHaveBeenCalled();

    sdk.list.mockRejectedValue(new sdk.APIError(401, { message: 'Incorrect API key provided' }));
    expect(await testOpenAiKey('sk-bad')).toEqual({ ok: false, error: expect.stringMatching(/rejected this key/) });
    sdk.list.mockRejectedValue(new sdk.APIConnectionError());
    expect(await testOpenAiKey('sk-bad')).toEqual({ ok: false, error: expect.stringMatching(/couldn't reach OpenAI/) });
    expect(await testOpenAiKey('  ')).toEqual({ ok: false, error: expect.stringMatching(/Enter your OpenAI API key/) });
  });
});

describe('generatePortrait', () => {
  it('paints a portrait from the sheet, keeps it in the gallery and returns a small copy', async () => {
    sdk.generate.mockResolvedValue(painted([5, 5]));
    const { character, campaign } = game();

    const result = await generatePortrait(character!, campaign!);

    expect(result.portrait).toBe('data:image/jpeg;base64,THUMB');
    expect(vi.mocked(portraitThumbnail)).toHaveBeenCalledTimes(1);
    const [params] = sdk.generate.mock.calls[0] as [Record<string, unknown>];
    expect(params).toMatchObject({ size: '1024x1536', n: 1 });
    expect(params.prompt).toMatch(/^Art style: /);
    expect(params.prompt).toContain('A portrait of Mira Voss (she/her), an elf (High Elf lineage) wizard (Evoker).');
    expect(params.prompt).toContain('Carrying or wearing: Dagger.');
    const image = await getImage(result.imageId);
    expect(image).toMatchObject({ campaignId: 'a-camp', subject: 'character', title: 'Portrait of Mira Voss' });
    expect(await bytesOf(image!.blob)).toEqual([5, 5]);
  });

  it('rejects with a readable reason, or as cancelled', async () => {
    const { character, campaign } = game();
    sdk.generate.mockRejectedValueOnce(new sdk.APIError(403, { message: 'Organization must be verified' }));
    await expect(generatePortrait(character!, campaign!)).rejects.toThrow(/can't use GPT Image 2\.5 Flare yet/);

    const controller = new AbortController();
    sdk.generate.mockImplementationOnce(
      (_params: unknown, options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new sdk.APIUserAbortError()))),
    );
    const portrait = generatePortrait(character!, campaign!, controller.signal);
    await vi.waitFor(() => expect(sdk.generate).toHaveBeenCalledTimes(2));
    controller.abort();
    await expect(portrait).rejects.toMatchObject({ name: 'AbortError' });

    useSettings.getState().setOpenAiKey('');
    await expect(generatePortrait(character!, campaign!)).rejects.toThrow(/OpenAI API key/);
    expect(await listImages('a-camp')).toEqual([]);
  });
});

describe('usePicture', () => {
  beforeEach(() => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:picture');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('shows painting, then the picture', async () => {
    const held = heldGenerations();
    const start = await started();
    const { result } = renderHook(() => usePicture(entryOf(start.logEntryId)!));
    expect(result.current).toEqual({ status: 'painting' });
    await vi.waitFor(() => expect(sdk.generate).toHaveBeenCalled());
    await act(async () => held[0].resolve(painted()));
    await vi.waitFor(() => expect(result.current).toEqual({ status: 'ready', url: 'blob:picture' }));
  });

  it('reads an abandoned pending card as interrupted and a finished one without its picture as missing', async () => {
    const pending = renderHook(() => usePicture({ imageId: 'nobody-paints-this', status: 'pending' }));
    await vi.waitFor(() => expect(pending.result.current).toEqual({ status: 'interrupted' }));
    const ready = renderHook(() => usePicture({ imageId: 'made-elsewhere', status: 'ready' }));
    await vi.waitFor(() => expect(ready.result.current).toEqual({ status: 'missing' }));
    const failed = renderHook(() => usePicture({ imageId: 'x', status: 'failed', error: IMAGE_DECLINED }));
    expect(failed.result.current).toEqual({ status: 'failed', error: IMAGE_DECLINED });
  });
});
