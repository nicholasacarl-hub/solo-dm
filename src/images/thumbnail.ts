/**
 * Shrink a portrait to a small square JPEG data: URL for Character.portrait (embedded in the save,
 * so it must stay small). Browser-only: it draws on a canvas.
 */

export const THUMBNAIL_SIZE = 256;
const JPEG_QUALITY = 0.85;
/** Where the square is cut from a tall portrait: a little below the top, where the face usually is. */
const CROP_FROM_TOP = 0.2;

interface Drawable {
  source: CanvasImageSource;
  width: number;
  height: number;
  release: () => void;
}

async function decode(blob: Blob): Promise<Drawable> {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob);
    return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
  }
  // Older browsers: decode through an <img> (blob: URLs are allowed by the page's CSP).
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, release: () => URL.revokeObjectURL(url) };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

/** A `size`×`size` JPEG data: URL of the picture (center square, nudged up for tall portraits). */
export async function portraitThumbnail(blob: Blob, size = THUMBNAIL_SIZE): Promise<string> {
  const image = await decode(blob);
  try {
    const side = Math.min(image.width, image.height);
    if (side <= 0) throw new Error('The portrait could not be read.');
    const sx = (image.width - side) / 2;
    const sy = (image.height - side) * CROP_FROM_TOP;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This browser could not shrink the portrait.');
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(image.source, sx, sy, side, side, 0, 0, size, size);
    return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
  } finally {
    image.release();
  }
}
