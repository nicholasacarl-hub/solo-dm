import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { gloamwoodEntries, gloamwoodRecords, gloamwoodSource } from '@/test/structuredFixtures';
import { installDialogPolyfill } from '@/ui/shell/testUtils';

vi.mock('@/data', async () => (await import('@/ui/library/structure/testing/mocks')).structuredDataMock());
vi.mock('@/storage', async () => (await import('@/ui/library/structure/testing/mocks')).structuredStorageMock());

const data = await import('@/data');
const { BookDataDialog, bookDataFileName } = await import('./BookDataDialog');

describe('Download book data', () => {
  beforeEach(() => {
    installDialogPolyfill();
    vi.mocked(data.exportPack).mockReturnValue({ format: 'solo-dm-pack', version: 1, schemaVersion: 1, title: 'The Gloamwood Almanac', entries: [] });
  });

  it('says the file holds the book\'s full text and names it', () => {
    render(<BookDataDialog open source={gloamwoodSource()} onClose={() => {}} />);
    expect(screen.getByText(/This file contains the full text of “The Gloamwood Almanac” and your reviewed data/)).toBeInTheDocument();
    expect(screen.getByText(/Keep it for yourself; don't share it\. It is never part of campaign saves or GitHub backups\./)).toBeInTheDocument();
    expect(screen.getByText('the-gloamwood-almanac.book-data.json')).toBeInTheDocument();
    expect(bookDataFileName('!!!')).toBe('book.book-data.json');
  });

  it('writes every entry and record of the book into the file', async () => {
    const user = userEvent.setup();
    const createObjectURL = vi.fn(() => 'blob:book');
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const onClose = vi.fn();
    render(<BookDataDialog open source={gloamwoodSource()} onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: 'Download book data' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(data.exportPack).toHaveBeenCalledWith(gloamwoodSource(), gloamwoodEntries(), gloamwoodRecords());
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    click.mockRestore();
  });
});
