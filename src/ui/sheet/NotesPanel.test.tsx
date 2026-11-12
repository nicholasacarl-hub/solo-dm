import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SHEET_TEXT_MAX } from '@/engine';
import { sampleCharacter } from '@/test/fixtures';
import { NotesPanel } from './NotesPanel';

describe('NotesPanel', () => {
  it("tells the player, under the field, when a backstory is past what the DM's sheet carries", () => {
    const long = sampleCharacter({ personality: { backstory: 'word '.repeat(SHEET_TEXT_MAX / 4) } });
    render(<NotesPanel character={long} editable onEdit={vi.fn()} />);
    const field = screen.getByLabelText('Backstory');
    const hint = screen.getByText(/The DM's sheet carries the first 20,000 characters of this/);
    expect(field.getAttribute('aria-describedby')).toBe(hint.id);
  });

  it('shows no hint for a real backstory', () => {
    render(<NotesPanel character={sampleCharacter({ personality: { backstory: 'Grew up on the salt flats.' } })} editable onEdit={vi.fn()} />);
    expect(screen.queryByText(/The DM's sheet carries/)).toBeNull();
    expect(screen.getByLabelText('Backstory').getAttribute('aria-describedby')).toBeNull();
  });
});
