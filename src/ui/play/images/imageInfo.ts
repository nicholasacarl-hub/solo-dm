/**
 * Display helpers for illustrations: labels, the frame shape a picture is expected to have, and
 * file names for saving a copy.
 */
import type { ImageSubject } from '@/types';

export const SUBJECT_LABELS: Record<ImageSubject, string> = {
  scene: 'Scene',
  battle: 'Battle',
  character: 'Character',
  npc: 'Character',
  creature: 'Creature',
  item: 'Item',
};

export type ImageShape = 'landscape' | 'portrait' | 'square';

/**
 * The shape a picture of this subject usually has (the DM picks the real aspect). Used for the
 * placeholder while it is painted, so the card changes size as little as possible when it arrives.
 */
export function shapeForSubject(subject: ImageSubject): ImageShape {
  switch (subject) {
    case 'character':
    case 'npc':
      return 'portrait';
    case 'creature':
    case 'item':
      return 'square';
    default:
      return 'landscape';
  }
}

/** How tall a picture may be in the story (it is never wider than the column). */
export const PICTURE_MAX_HEIGHT = 'max-h-[min(70vh,36rem)]';

/**
 * Tailwind classes for the frame that holds a picture's place (while it's painted, and while it
 * decodes), sized like the picture will be so the story doesn't jump when it arrives.
 */
export const FRAME_CLASSES: Record<ImageShape, string> = {
  landscape: 'aspect-[3/2] w-full',
  portrait: 'mx-auto aspect-[2/3] h-[min(70vh,36rem)] max-w-full',
  square: 'mx-auto aspect-square w-full max-w-[min(70vh,36rem)]',
};

const EXTENSIONS: Record<string, string> = {
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/avif': 'avif',
};

/** "The Drowned Lantern" + image/webp → "the-drowned-lantern.webp". */
export function imageFileName(title: string, mime: string | undefined): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .slice(0, 60)
    .replace(/^-+|-+$/g, '');
  const type = mime?.toLowerCase().split(';')[0].trim() ?? '';
  const extension = EXTENSIONS[type] ?? (type.startsWith('image/') ? type.slice(6).replace(/[^a-z0-9]/g, '') : '');
  return `${slug || 'illustration'}.${extension || 'webp'}`;
}
