import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
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

  it('maps leveling and DM-roll choices to booleans and toggles imported sources', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness initial={sampleSettings()} sections={['rules']} onChange={onChange} />);

    await user.click(screen.getByRole('radio', { name: /Experience points/ }));
    expect(lastCall(onChange).milestoneLeveling).toBe(false);
    await user.click(screen.getByRole('radio', { name: /In the open/ }));
    expect(lastCall(onChange).showDmRolls).toBe(true);

    await user.click(screen.getByRole('checkbox', { name: /My spell notes/ }));
    expect(lastCall(onChange).enabledSources).toEqual(['srd-5.2.1', 'lib-notes']);
    expect(screen.getByRole('checkbox', { name: /SRD 5\.2\.1/ })).toBeDisabled();
  });
});
