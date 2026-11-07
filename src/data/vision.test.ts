import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APIUserAbortError, AuthenticationError } from '@anthropic-ai/sdk';
import type { BetaMessage, MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { useSettings } from '@/state/settingsStore';
import { TRANSCRIBE_SYSTEM_PROMPT, transcribeImages, type EncodedImage, type TranscriptionClient } from './vision';

type Reply = { text?: string; stop_reason?: BetaMessage['stop_reason']; category?: string };

function message({ text = '', stop_reason = 'end_turn', category }: Reply): BetaMessage {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [{ type: 'thinking', thinking: '', signature: 'sig' }, ...(text ? [{ type: 'text', text, citations: null }] : [])],
    stop_reason,
    stop_details: stop_reason === 'refusal' ? { type: 'refusal', category: category ?? null, explanation: null } : null,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  } as unknown as BetaMessage;
}

function fakeClient(...replies: (Reply | Error)[]) {
  const calls: { params: MessageCreateParamsNonStreaming; options?: { signal?: AbortSignal } }[] = [];
  const client: TranscriptionClient = {
    beta: {
      messages: {
        create: async (params, options) => {
          calls.push({ params, options });
          const reply = replies[calls.length - 1] ?? { text: '' };
          if (reply instanceof Error) throw reply;
          return message(reply);
        },
      },
    },
  };
  return { client, calls };
}

const encode = vi.fn(async (): Promise<EncodedImage> => ({ data: 'QUJD', mediaType: 'image/jpeg' }));
const photos = (n: number) => Array.from({ length: n }, (_, i) => new Blob([`photo ${i}`], { type: 'image/png' }));

beforeEach(() => {
  useSettings.getState().update({ model: 'claude-opus-5-5', useFallbacks: true });
});

afterEach(() => {
  useSettings.getState().reset();
  encode.mockClear();
});

describe('transcribeImages', () => {
  it('sends one vision request per photo and joins the Markdown', async () => {
    const { client, calls } = fakeClient({ text: '## Fireball\nA bright streak.' }, { text: '```markdown\n## Fire Bolt\nA mote of fire.\n```' });
    const progress = vi.fn();
    const result = await transcribeImages(photos(2), { client, encode, onProgress: progress });
    expect(result).toEqual({ markdown: '## Fireball\nA bright streak.\n\n## Fire Bolt\nA mote of fire.', warnings: [] });
    expect(calls).toHaveLength(2);
    expect(encode).toHaveBeenCalledTimes(2);
    expect(calls[0].params).toEqual({
      model: 'claude-opus-5-5',
      max_tokens: 8000,
      system: TRANSCRIBE_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } },
            { type: 'text', text: 'Transcribe this page.' },
          ],
        },
      ],
      output_config: { effort: 'low' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
    expect(calls[0].params).not.toHaveProperty('temperature');
    expect(progress.mock.calls.map((c) => c.slice(0, 2))).toEqual([
      [0, 2],
      [1, 2],
      [2, 2],
    ]);
    expect(progress.mock.calls[1][2]).toBe('Transcribing photo 2 of 2…');
  });

  it('uses the model from Settings and only opts into fallbacks where supported', async () => {
    useSettings.getState().update({ model: 'claude-haiku-5-5' });
    const haiku = fakeClient({ text: 'Text.' });
    await transcribeImages(photos(1), { client: haiku.client, encode });
    expect(haiku.calls[0].params).toMatchObject({ model: 'claude-haiku-5-5', output_config: { effort: 'low' } });
    expect(haiku.calls[0].params).not.toHaveProperty('fallbacks');

    useSettings.getState().update({ model: 'claude-sonnet-5-5', useFallbacks: false });
    const sonnet = fakeClient({ text: 'Text.' });
    await transcribeImages(photos(1), { client: sonnet.client, encode });
    expect(sonnet.calls[0].params).not.toHaveProperty('betas');

    useSettings.getState().update({ model: 'my-custom-model' });
    const custom = fakeClient({ text: 'Text.' });
    await transcribeImages(photos(1), { client: custom.client, encode });
    expect(custom.calls[0].params).not.toHaveProperty('output_config');
  });

  it('skips refused or empty photos with a warning and flags cut-off ones', async () => {
    const { client } = fakeClient({ stop_reason: 'refusal', category: 'general_harms' }, { text: 'Page two.', stop_reason: 'max_tokens' }, { text: '' });
    const result = await transcribeImages(photos(3), { client, encode });
    expect(result.markdown).toBe('Page two.');
    expect(result.warnings).toEqual([
      'Photo 1 was skipped: Claude declined to transcribe it (general_harms).',
      'Photo 2 may be incomplete: the transcription hit the length limit.',
      'Photo 3: no text was found.',
    ]);
  });

  it('fails when no photo could be transcribed', async () => {
    const { client } = fakeClient({ stop_reason: 'refusal' });
    await expect(transcribeImages(photos(1), { client, encode })).rejects.toThrow(/Nothing could be transcribed\. Photo 1 was skipped/);
  });

  it('passes the abort signal and reports cancellation as an AbortError', async () => {
    const controller = new AbortController();
    const { client, calls } = fakeClient(new APIUserAbortError());
    await expect(transcribeImages(photos(2), { client, encode, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls[0].options?.signal).toBe(controller.signal);
    controller.abort();
    await expect(transcribeImages(photos(1), { client, encode, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toHaveLength(1);
  });

  it('explains API errors', async () => {
    const { client } = fakeClient(new AuthenticationError(401, { type: 'error' }, 'invalid x-api-key', new Headers()));
    await expect(transcribeImages(photos(1), { client, encode })).rejects.toThrow('Claude rejected the API key. Check it in Settings.');
  });
});
