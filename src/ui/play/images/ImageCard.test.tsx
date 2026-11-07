import '../testing/setup';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { usePicture } from '@/images';
import type { ImageLogEntry, LogEntry } from '@/types';
import { resetImagesMock } from '../testing/imagesMock';
import { fakePicture, resetPictures, seedPictures } from '../testing/imageStorageMock';
import { seedGame } from '../testing/seed';
import { LogEntryView } from '../log/LogEntryView';
import { ImageCard } from './ImageCard';
import { imageFileName, shapeForSubject } from './imageInfo';

vi.mock('@/dm', () => import('../testing/dmMock'));
vi.mock('@/images', () => import('../testing/imagesMock'));
vi.mock('@/storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/storage')>()),
  ...(await import('../testing/imageStorageMock')).imageStorage,
}));

const entry = (overrides: Partial<ImageLogEntry> = {}): ImageLogEntry => ({
  id: 'log-img-1',
  campaignId: 'camp-1',
  sessionId: 'sess-1',
  seq: 50,
  createdAt: 1_700_000_000_000,
  kind: 'image',
  imageId: 'img-1',
  title: 'The drowned lantern at dusk',
  subject: 'scene',
  status: 'ready',
  ...overrides,
});

beforeEach(() => {
  resetImagesMock();
  resetPictures();
});

describe('ImageCard', () => {
  it('shows a calm "Painting…" placeholder with the title while the picture is made', () => {
    vi.mocked(usePicture).mockReturnValue({ status: 'painting' });
    render(<ImageCard entry={entry({ status: 'pending' })} />);
    expect(screen.getByText('Painting…')).toBeInTheDocument();
    expect(screen.getByText('The drowned lantern at dusk')).toBeInTheDocument();
    expect(screen.getByRole('figure')).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('shows the picture, and opens it larger with its title and a Save button', async () => {
    const user = userEvent.setup();
    seedPictures([fakePicture({ id: 'img-1', url: 'blob:http://localhost/lantern' })]);
    vi.mocked(usePicture).mockReturnValue({ status: 'ready', url: 'blob:http://localhost/lantern' });
    render(<ImageCard entry={entry()} />);

    const picture = screen.getByRole('button', { name: 'Open picture: The drowned lantern at dusk' });
    const img = within(picture).getByRole('img', { hidden: true });
    expect(img).toHaveAttribute('src', 'blob:http://localhost/lantern');
    expect(screen.getByRole('figure', { name: 'The drowned lantern at dusk' })).toBeInTheDocument();
    // The frame keeps the picture's place until it has decoded, so the story doesn't jump.
    expect(img).toHaveClass('opacity-0');
    expect(picture.querySelector('.aspect-\\[3\\/2\\]')).not.toBeNull();
    fireEvent.load(img);
    expect(img).not.toHaveClass('opacity-0');
    expect(picture.querySelector('.aspect-\\[3\\/2\\]')).toBeNull();

    await user.click(picture);
    const dialog = screen.getByRole('dialog', { name: 'The drowned lantern at dusk' });
    expect(within(dialog).getByRole('img', { name: 'The drowned lantern at dusk' })).toHaveAttribute('src', 'blob:http://localhost/lantern');
    const save = within(dialog).getByRole('link', { name: 'Save' });
    expect(save).toHaveAttribute('href', 'blob:http://localhost/lantern');
    expect(save).toHaveAttribute('download', 'the-drowned-lantern-at-dusk.webp');

    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps Save off until it knows the picture (for the file type)', async () => {
    const user = userEvent.setup();
    // The card has the picture but this device's gallery doesn't list it (yet).
    vi.mocked(usePicture).mockReturnValue({ status: 'ready', url: 'blob:http://localhost/lantern' });
    render(<ImageCard entry={entry()} />);
    await user.click(screen.getByRole('button', { name: /^Open picture/ }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByRole('link', { name: 'Save' })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('says quietly why a picture failed, and can paint it again', async () => {
    const user = userEvent.setup();
    const retry = vi.fn(async () => {});
    vi.mocked(usePicture).mockReturnValue({ status: 'failed', error: 'The image service declined this picture.', retry });
    render(<ImageCard entry={entry({ status: 'failed', error: 'The image service declined this picture.' })} />);
    expect(screen.getByText(/Couldn’t paint “The drowned lantern at dusk”\. The image service declined this picture\./)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('says so quietly when the browser cannot show the saved picture', () => {
    vi.mocked(usePicture).mockReturnValue({ status: 'ready', url: 'blob:http://localhost/broken' });
    render(<ImageCard entry={entry()} />);
    fireEvent.error(screen.getByRole('img', { hidden: true }));
    expect(screen.getByText('This browser can’t show “The drowned lantern at dusk”.')).toBeInTheDocument();
  });

  it('offers no retry when this tab cannot paint the picture again', () => {
    vi.mocked(usePicture).mockReturnValue({ status: 'failed', error: 'Your browser couldn’t reach OpenAI.' });
    render(<ImageCard entry={entry({ status: 'failed' })} />);
    expect(screen.getByText(/Your browser couldn’t reach OpenAI\./)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('explains pictures that were interrupted or are not on this device', () => {
    vi.mocked(usePicture).mockReturnValue({ status: 'interrupted' });
    const { rerender } = render(<ImageCard entry={entry({ status: 'pending' })} />);
    expect(screen.getByText(/was interrupted before it was finished\. Ask the DM to paint it again\./)).toBeInTheDocument();

    vi.mocked(usePicture).mockReturnValue({ status: 'missing' });
    rerender(<ImageCard entry={entry({ id: 'log-img-2' })} />);
    expect(screen.getByText(/isn’t on this device\. Pictures stay in the browser they were painted in\./)).toBeInTheDocument();
  });

  it('is rendered for image entries in the story log', () => {
    seedGame();
    vi.mocked(usePicture).mockReturnValue({ status: 'painting' });
    const image: LogEntry = entry({ status: 'pending' });
    render(<LogEntryView entry={image} showChoices={false} latestError={false} />);
    expect(screen.getByText('Painting…').closest('[data-kind]')).toHaveAttribute('data-kind', 'image');
  });
});

describe('image helpers', () => {
  it('names saved files after the title with the right extension', () => {
    expect(imageFileName('The Drowned Lantern', 'image/webp')).toBe('the-drowned-lantern.webp');
    expect(imageFileName('Tam’s “Boat”!', 'image/jpeg')).toBe('tam-s-boat.jpg');
    expect(imageFileName('Café Noir', 'image/png')).toBe('cafe-noir.png');
    expect(imageFileName('   ', undefined)).toBe('illustration.webp');
    expect(imageFileName('Map', 'image/x-icon')).toBe('map.xicon');
  });

  it('expects portraits for people and wide frames for places', () => {
    expect(shapeForSubject('character')).toBe('portrait');
    expect(shapeForSubject('npc')).toBe('portrait');
    expect(shapeForSubject('scene')).toBe('landscape');
    expect(shapeForSubject('battle')).toBe('landscape');
    expect(shapeForSubject('item')).toBe('square');
  });
});
