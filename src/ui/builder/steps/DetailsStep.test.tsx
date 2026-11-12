import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SHEET_TEXT_MAX } from '@/engine';
import { DetailsFields } from './DetailsStep';

const value = (backstory: string, ideals = '') => ({ name: 'Kestrel Vane', pronouns: '', alignment: '', portrait: '', personality: { backstory, ideals } });

describe('DetailsFields', () => {
  it("links each text box to its hint, and says when a field is past what the DM's sheet carries", () => {
    render(<DetailsFields value={value('Grew up on the salt flats.', 'x'.repeat(SHEET_TEXT_MAX + 1))} onChange={vi.fn()} />);
    const backstory = screen.getByLabelText('Backstory');
    expect(document.getElementById(backstory.getAttribute('aria-describedby') ?? '')?.textContent).toMatch(/the DM reads all of it/);
    const ideals = screen.getByLabelText('Ideals');
    expect(document.getElementById(ideals.getAttribute('aria-describedby') ?? '')?.textContent).toMatch(/The DM's sheet carries the first 20,000 characters/);
    expect(screen.getByLabelText('Bonds').getAttribute('aria-describedby')).toBeNull();
  });
});
