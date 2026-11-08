import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type { CampaignSettings } from '@/types';
import { sampleSettings } from '@/test/fixtures';
import { CampaignSettingsForm, type CampaignSettingsFormProps } from './CampaignSettingsForm';
import { autoCleanup } from './testUtils';

vi.mock('@/storage', () => ({
  useLibrarySources: () => [
    { id: 'srd-5.2.1', title: 'SRD 5.2.1', kind: 'builtin', enabled: true, entryCount: 2000, createdAt: 0, updatedAt: 0 },
    { id: 'lib-notes', title: 'My spell notes', kind: 'import', enabled: true, entryCount: 12, createdAt: 0, updatedAt: 0 },
  ],
}));

autoCleanup();

function Harness({ initial, onChange, ...props }: Omit<CampaignSettingsFormProps, 'value' | 'onChange'> & {
  initial: CampaignSettings;
  onChange?: (next: CampaignSettings) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <MemoryRouter>
      <CampaignSettingsForm
        {...props}
        value={value}
        onChange={(next) => {
          setValue(next);
          onChange?.(next);
        }}
      />
    </MemoryRouter>
  );
}

const lastCall = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.at(-1)?.[0] as CampaignSettings;

describe('CampaignSettingsForm', () => {
  it('shows every section with headings by default', () => {
    render(<Harness initial={sampleSettings()} />);
    expect(screen.getByRole('heading', { name: 'Story' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Table rules' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Safety' })).toBeInTheDocument();
    expect(screen.getByText('Rules as written; the DM looks things up.')).toBeInTheDocument();
  });

  it('treats a tone that matches no preset as custom and edits it', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness initial={sampleSettings()} sections={['story']} onChange={onChange} />);

    expect(screen.getByRole('radio', { name: /Custom/ })).toBeChecked();
    const custom = screen.getByLabelText('Your tone');
    expect(custom).toHaveValue('Heroic fantasy with a streak of mystery');

    await user.click(screen.getByRole('radio', { name: /Political intrigue/ }));
    expect(lastCall(onChange).tone).toBe('Political intrigue: factions, secrets, words sharper than swords.');
    expect(screen.queryByLabelText('Your tone')).not.toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: /Custom/ }));
    expect(lastCall(onChange).tone).toBe('Heroic fantasy with a streak of mystery');
  });

  it('keeps a topic on only one of lines and veils', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness initial={sampleSettings()} sections={['safety']} onChange={onChange} />);

    // "Torture" starts as a veil; making it a line takes it off the veils.
    await user.type(screen.getByRole('textbox', { name: 'Lines' }), 'torture{Enter}');
    expect(lastCall(onChange).lines).toEqual(['Harm to children', 'torture']);
    expect(lastCall(onChange).veils).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Remove Harm to children' }));
    expect(lastCall(onChange).lines).toEqual(['torture']);
  });

  it('offers transformations, as "offered" for campaigns made before the setting existed', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness initial={sampleSettings()} sections={['rules']} onChange={onChange} />);

    const group = screen.getByRole('group', { name: 'Transformations' });
    expect(within(group).getByRole('radio', { name: /Offered — you always choose/ })).toBeChecked();
    expect(within(group).getByText('Default')).toBeInTheDocument();
    expect(within(group).getByText(/nothing changes unless you choose it in the story/)).toBeInTheDocument();
    expect(within(group).getByText(/always a way to resist, reverse or cure it/)).toBeInTheDocument();

    await user.click(within(group).getByRole('radio', { name: /Consequences can stick/ }));
    expect(lastCall(onChange).transformations).toBe('consequences');
    await user.click(within(group).getByRole('radio', { name: /^Off(?!ered)/ }));
    expect(lastCall(onChange).transformations).toBe('off');
  });

  it('offers battle maps Off / When it helps / Every fight, as "When it helps" for campaigns made before', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness initial={sampleSettings()} sections={['rules']} onChange={onChange} />);

    const group = screen.getByRole('group', { name: 'Battle maps' });
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((r) => r.closest('label')?.querySelector('.font-medium')?.textContent)).toEqual([
      'Off — theater of the mind',
      'When it helps',
      'Every fight',
    ]);
    expect(within(group).getByRole('radio', { name: /When it helps/ })).toBeChecked();
    expect(within(group).getByText('Default')).toBeInTheDocument();
    expect(within(group).getByText(/A grid of 5-foot squares/)).toBeInTheDocument();

    await user.click(within(group).getByRole('radio', { name: /Every fight/ }));
    expect(lastCall(onChange).battleMaps).toBe('always');
    await user.click(within(group).getByRole('radio', { name: /Off — theater of the mind/ }));
    expect(lastCall(onChange).battleMaps).toBe('off');
  });

  it('suggests art styles that suit the tone, and takes the player’s own', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness initial={sampleSettings()} sections={['story']} onChange={onChange} />);

    const input = screen.getByLabelText('Art style');
    expect(input).toHaveValue('');
    expect(input).toHaveAttribute('placeholder', expect.stringMatching(/^heroic fantasy oil painting/));
    const suggestions = within(screen.getByRole('group', { name: 'Art style suggestions' })).getAllByRole('button');
    expect(suggestions.map((b) => b.textContent)).toEqual([
      'Heroic oil· suits your tone',
      'Painterly',
      'Bright adventure',
      'Storybook',
      'Ink & wash',
    ]);
    expect(suggestions.every((b) => b.getAttribute('aria-pressed') === 'false')).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Storybook' }));
    expect(lastCall(onChange).artStyle).toBe('storybook watercolor illustration, soft pastel palette, gentle glowing light');
    expect(screen.getByRole('button', { name: 'Storybook' })).toHaveAttribute('aria-pressed', 'true');

    await user.clear(input);
    await user.type(input, 'woodcut print');
    expect(lastCall(onChange).artStyle).toBe('woodcut print');
    expect(screen.getByRole('button', { name: 'Storybook' })).toHaveAttribute('aria-pressed', 'false');

    // A darker tone suggests darker styles.
    await user.click(screen.getByRole('radio', { name: /Cosmic horror/ }));
    expect(within(screen.getByRole('group', { name: 'Art style suggestions' })).getAllByRole('button')[0]).toHaveTextContent(
      /^Eerie/,
    );
  });

  it('maps leveling and DM-roll choices to booleans and points rules sources at the Library', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness initial={sampleSettings()} sections={['rules']} onChange={onChange} />);

    await user.click(screen.getByRole('radio', { name: /Experience points/ }));
    expect(lastCall(onChange).milestoneLeveling).toBe(false);
    await user.click(screen.getByRole('radio', { name: /In the open/ }));
    expect(lastCall(onChange).showDmRolls).toBe(true);

    // The DM consults every book switched on in the Library; there is no per-campaign picker.
    expect(screen.queryByRole('checkbox', { name: /My spell notes/ })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Library' })).toHaveAttribute('href', '/library?tab=mine');
  });
});
