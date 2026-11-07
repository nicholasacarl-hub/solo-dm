/**
 * "Generate portrait" on the character sheet: a portrait of the hero painted from the sheet in the
 * campaign's art style. The full picture goes to the gallery; a small square copy becomes
 * Character.portrait (it travels in save files, so it must stay small).
 */
import type { Campaign, Character } from '@/types';
import { newId } from '@/lib/id';
import { getSettings } from '@/state/settingsStore';
import { saveImage } from '@/storage';
import { ImageServiceError, isAbortError } from './errors';
import { imagesAvailable, paintingQueue } from './illustrate';
import { explainPaintError, paint } from './openai';
import { buildImagePrompt, campaignArtStyle, portraitDescription } from './prompt';
import { portraitThumbnail } from './thumbnail';

function cancelled(): DOMException {
  return new DOMException('The portrait was cancelled.', 'AbortError');
}

/** The full prompt for a portrait of the hero (exported for previews and tests). */
export function portraitPrompt(character: Character, campaign: Pick<Campaign, 'settings'>): string {
  return buildImagePrompt({
    prompt: portraitDescription(character),
    subject: 'character',
    artStyle: campaignArtStyle(campaign),
    avoid: [...campaign.settings.lines, ...campaign.settings.veils],
  });
}

/**
 * Paint a portrait of the hero from their sheet (species, class, appearance, gear) in the campaign's
 * art style. Stores the full image in the gallery and returns a small data: URL (≈256 px JPEG) to set
 * as Character.portrait. Rejects with a readable message (an AbortError when `signal` aborts; a
 * picture that was already painted by then is still kept in the gallery).
 */
export async function generatePortrait(
  character: Character,
  campaign: Campaign,
  signal?: AbortSignal,
): Promise<{ portrait: string; imageId: string }> {
  const settings = getSettings();
  const available = imagesAvailable(settings);
  if (!available.ok) throw new ImageServiceError(available.reason);
  const { model, quality, openaiApiKey } = settings.images;
  const prompt = portraitPrompt(character, campaign);

  let picture: Awaited<ReturnType<typeof paint>>;
  try {
    picture = await paintingQueue.run(
      () => paint({ apiKey: openaiApiKey, settings: { model, quality }, prompt, aspect: 'portrait', signal }),
      { signal, priority: true },
    );
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) throw cancelled();
    throw new ImageServiceError(await explainPaintError(error, model));
  }

  // Painted (and paid for): it goes to the gallery even if the player has stopped waiting.
  const imageId = newId();
  await saveImage({
    id: imageId,
    campaignId: campaign.id,
    sessionId: campaign.activeSessionId,
    title: `Portrait of ${character.name.trim() || 'the hero'}`,
    subject: 'character',
    prompt,
    model,
    mime: picture.mime,
    blob: picture.blob,
    createdAt: Date.now(),
  });
  if (signal?.aborted) throw cancelled();
  const portrait = await portraitThumbnail(picture.blob);
  return { portrait, imageId };
}
