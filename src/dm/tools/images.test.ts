import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/engine', () => import('../testing/fakeEngine'));
vi.mock('@/data', () => import('../testing/fakeData'));
vi.mock('@/state/gameStore', () => import('../testing/fakeGameStoreModule'));

import type { IllustrationRequest, IllustrationStart } from '@/images';
import { DEFAULT_IMAGE_SETTINGS, type ImageFrequency } from '@/types';
import { deps, resetDmDeps, type DmImages } from '../deps';
import { DmCancelledError } from '../errors';
import { NO_IMAGE_KEY, setupHarness, type Harness } from '../testing/harness';
import type { ToolContext } from './context';
import { runTool } from './handlers';
import { IMAGE_START_TIMEOUT_MS, imagesThisScene } from './images';

afterEach(() => {
  resetDmDeps();
  vi.useRealTimers();
});

const PICTURE = {
  subject: 'scene',
  title: 'The drowned bell tower',
  prompt: 'A half-sunken stone bell tower at dusk, green light in its arches, fog on black water, a lone figure on a rowboat.',
  aspect: 'landscape',
};

interface Setup extends Harness {
  run: (input: unknown, signal?: AbortSignal) => ReturnType<typeof runTool>;
  requests: IllustrationRequest[];
}

/** A harness with an OpenAI key (unless `images` says otherwise) and the given frequency. */
function setup(opts: { frequency?: ImageFrequency; images?: Partial<DmImages>; start?: (req: IllustrationRequest) => Promise<IllustrationStart> } = {}): Setup {
  const requests: IllustrationRequest[] = [];
  const harness: { current?: Harness } = {};
  const request: DmImages['request'] = async (req) => {
    requests.push(req);
    if (opts.start) return opts.start(req);
    // As the images module does: the pending card is in the log before it resolves.
    const entry = await harness.current!.s().appendLog({ kind: 'image', imageId: `img-${requests.length}`, title: req.title, subject: req.subject, status: 'pending' });
    return { ok: true, imageId: `img-${requests.length}`, logEntryId: entry.id };
  };
  const h = setupHarness({
    withSession: true,
    settings: { images: { ...DEFAULT_IMAGE_SETTINGS, openaiApiKey: 'sk-openai-test', frequency: opts.frequency ?? 'request' } },
    images: { available: () => ({ ok: true }), request, ...opts.images },
  });
  harness.current = h;
  const run = (input: unknown, signal = new AbortController().signal) => {
    const ctx: ToolContext = { deps: deps(), signal, status: vi.fn() };
    return runTool('show_image', input, ctx);
  };
  return { ...h, run, requests };
}

describe('show_image', () => {
  it('starts the painting and returns at once, telling the DM to keep narrating', async () => {
    const h = setup();
    const out = await h.run(PICTURE);
    expect(out.isError).toBeUndefined();
    expect(out.content).toBe(
      `The picture "The drowned bell tower" is being painted and will appear in the log when it's ready. Keep narrating — don't describe the picture or wait for it.`,
    );
    expect(h.requests).toEqual([{ campaignId: 'camp-1', title: 'The drowned bell tower', subject: 'scene', prompt: PICTURE.prompt, aspect: 'landscape' }]);
    // The images module's card is the log line; the tool adds none of its own.
    expect(h.s().log.map((e) => e.kind)).toEqual(['image']);
  });

  it('leaves the aspect and whether the hero is in frame to the images module unless the DM says', async () => {
    const h = setup();
    await h.run({ ...PICTURE, aspect: undefined, subject: 'character' });
    expect(h.requests[0]).not.toHaveProperty('aspect');
    expect(h.requests[0]).not.toHaveProperty('heroInFrame');
    expect(h.requests[0].subject).toBe('character');
    await h.run({ ...PICTURE, hero_in_frame: true });
    expect(h.requests[1]).toMatchObject({ subject: 'scene', heroInFrame: true });
  });

  it("returns the reason when there's no key, and tells the DM not to bring pictures up", async () => {
    const h = setup({ images: { available: () => ({ ok: false, reason: NO_IMAGE_KEY }) } });
    const out = await h.run(PICTURE);
    expect(out.isError).toBe(true);
    expect(out.content).toBe(
      `No picture was made: ${NO_IMAGE_KEY}. Don't mention pictures unless the player asked for one; if they did, tell them in one short out-of-character line, and describe it in words instead.`,
    );
    expect(h.requests).toHaveLength(0);
  });

  it('never paints when the player switched illustrations off, even with a key', async () => {
    const h = setup({ frequency: 'off' });
    const out = await h.run(PICTURE);
    expect(out.isError).toBe(true);
    expect(out.content).toContain('the player has switched illustrations off (Settings → Illustrations)');
    expect(h.requests).toHaveLength(0);
  });

  it('passes on a refusal or a failure to start, without breaking the turn', async () => {
    const declined = setup({ start: async () => ({ ok: false, reason: 'the image service declined this description' }) });
    const out = await declined.run(PICTURE);
    expect(out).toMatchObject({ isError: true, content: expect.stringContaining('No picture was made: the image service declined this description.') });

    const broken = setup({ start: async () => Promise.reject(new Error('IndexedDB is full')) });
    const failed = await broken.run(PICTURE);
    expect(failed.isError).toBe(true);
    expect(failed.content).toContain("The picture couldn't be started (IndexedDB is full). Carry on without it.");

    const throwing = setup({
      images: {
        available: () => {
          throw new Error('images: imagesAvailable not implemented');
        },
      },
    });
    expect((await throwing.run(PICTURE)).content).toContain('No picture was made: images: imagesAvailable not implemented.');
  });

  it("doesn't hold up the turn when the painting is slow to start", async () => {
    vi.useFakeTimers();
    const h = setup({ start: () => new Promise<IllustrationStart>(() => {}) });
    const pending = h.run(PICTURE);
    await vi.advanceTimersByTimeAsync(IMAGE_START_TIMEOUT_MS);
    const out = await pending;
    expect(out.isError).toBeUndefined();
    expect(out.content).toContain('is slow to start; it may still appear in the log');
    expect(out.content).toContain("don't call show_image again for it");
  });

  it('stops waiting when the player presses Stop', async () => {
    const h = setup({ start: () => new Promise<IllustrationStart>(() => {}) });
    const stop = new AbortController();
    const pending = h.run(PICTURE, stop.signal);
    stop.abort();
    await expect(pending).rejects.toBeInstanceOf(DmCancelledError);
  });

  it('nudges the DM when key moments are piling up in one scene', async () => {
    const h = setup({ frequency: 'moments' });
    expect((await h.run(PICTURE)).content).not.toContain('pictures this scene');
    const second = await h.run({ ...PICTURE, title: 'The bell rings' });
    expect(second.content).toContain('That makes 2 pictures this scene: keep to about one per scene for key moments, unless the player asks.');

    await h.s().appendLog({ kind: 'tool', tool: 'set_scene', icon: 'scene', summary: 'New scene: The breakwater' });
    expect((await h.run({ ...PICTURE, title: 'The breakwater' })).content).not.toContain('pictures this scene');
    expect(imagesThisScene(h.s().log, 'sess-1')).toBe(1);

    // On request, every picture was asked for: no nudge.
    const asked = setup({ frequency: 'request' });
    await asked.run(PICTURE);
    expect((await asked.run(PICTURE)).content).not.toContain('pictures this scene');
  });

  it('validates its input like every tool', async () => {
    const h = setup();
    const out = await h.run({ ...PICTURE, subject: 'map' });
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/^Invalid input for show_image/);
    expect(h.requests).toHaveLength(0);
  });
});
