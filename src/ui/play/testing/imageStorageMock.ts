/**
 * In-memory stand-ins for the picture hooks of '@/storage' in UI tests:
 *
 *   vi.mock('@/storage', async (importOriginal) => ({
 *     ...(await importOriginal<typeof import('@/storage')>()),
 *     ...(await import('@/ui/play/testing/imageStorageMock')).imageStorage,
 *   }));
 *
 * Seed with seedPictures(); resetPictures() in beforeEach.
 */
import { vi } from 'vitest';
import type { StoredImageMeta } from '@/storage';
import type { StoredImage } from '@/types';

export interface FakePicture extends StoredImageMeta {
  /** What useImageUrl returns for it. */
  url: string;
}

let pictures: FakePicture[] = [];
/** False: useImageList answers undefined (still loading). */
let listLoaded = true;

function meta({ url: _url, ...rest }: FakePicture): StoredImageMeta {
  return rest;
}

export function fakePicture(overrides: Partial<FakePicture> & Pick<FakePicture, 'id'>): FakePicture {
  return {
    campaignId: 'camp-1',
    sessionId: 'sess-1',
    title: 'The drowned lantern at dusk',
    subject: 'scene',
    prompt: 'A lighthouse on a breakwater at dusk, its lantern burning cold green through the fog.',
    model: 'gpt-image-2.5-flare',
    mime: 'image/webp',
    createdAt: 1_700_000_000_000,
    url: `blob:http://localhost/${overrides.id}`,
    ...overrides,
  };
}

export const imageStorage = {
  useImageList: vi.fn((campaignId: string | null): StoredImageMeta[] | undefined => {
    if (!listLoaded) return undefined;
    if (!campaignId) return [];
    return pictures
      .filter((p) => p.campaignId === campaignId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(meta);
  }),
  useImageUrl: vi.fn((imageId: string | null): string | null => (imageId ? (pictures.find((p) => p.id === imageId)?.url ?? null) : null)),
  getImage: vi.fn(async (imageId: string): Promise<StoredImage | undefined> => {
    const found = pictures.find((p) => p.id === imageId);
    return found ? { ...meta(found), blob: new Blob(['fake'], { type: found.mime }) } : undefined;
  }),
};

export function seedPictures(list: FakePicture[], opts: { loaded?: boolean } = {}): void {
  pictures = list;
  listLoaded = opts.loaded ?? true;
}

export function resetPictures(): void {
  pictures = [];
  listLoaded = true;
  imageStorage.useImageList.mockClear();
  imageStorage.useImageUrl.mockClear();
  imageStorage.getImage.mockClear();
}
