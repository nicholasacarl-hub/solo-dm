import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { sampleCampaign } from '@/test/fixtures';
import { autoCleanup, renderRoute } from '@/ui/shell/testUtils';
import { NewCampaignScreen, newCampaignDraft, toCampaignInput, validatePremiseStep } from './NewCampaignScreen';

vi.mock('@/storage', () => ({
  createCampaign: vi.fn(),
  requestPersistentStorage: vi.fn(),
  useLibrarySources: () => [],
}));

const { createCampaign, requestPersistentStorage } = await import('@/storage');

autoCleanup();

function renderWizard() {
  return renderRoute(<NewCampaignScreen />, { path: '/new' });
}

const nextButton = () => screen.getByRole('button', { name: /^Next/ });
const stepHeading = (name: string) => screen.getByRole('heading', { level: 2, name });

describe('NewCampaignScreen', () => {
  beforeEach(() => {
    vi.mocked(createCampaign).mockReset();
    vi.mocked(requestPersistentStorage).mockReset().mockResolvedValue(false);
  });

  it('requires a campaign name before moving on', async () => {
    const user = userEvent.setup();
    renderWizard();

    await user.click(nextButton());

    expect(screen.getByText('Give your campaign a name.')).toBeInTheDocument();
    expect(stepHeading('Premise & tone')).toBeInTheDocument();
    const name = screen.getByLabelText('Campaign name');
    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(name).toHaveFocus();

    await user.type(name, 'The Salt Choir');
    expect(screen.queryByText('Give your campaign a name.')).not.toBeInTheDocument();
  });

  it('asks for a description when the tone is custom', async () => {
    const user = userEvent.setup();
    renderWizard();
    await user.type(screen.getByLabelText('Campaign name'), 'Odd Tidings');
    await user.click(screen.getByRole('radio', { name: /Custom/ }));
    await user.click(nextButton());

    expect(screen.getByText('Pick a tone, or describe your own.')).toBeInTheDocument();
    expect(stepHeading('Premise & tone')).toBeInTheDocument();
  });

  it('walks through all three steps and creates the campaign', async () => {
    vi.mocked(createCampaign).mockResolvedValue(
      sampleCampaign({ id: 'camp-new', name: 'The Salt Choir', status: 'setup', characterId: null }),
    );
    const user = userEvent.setup();
    renderWizard();

    await user.type(screen.getByLabelText('Campaign name'), '  The Salt Choir ');
    await user.type(screen.getByLabelText('Premise'), 'Drowned bells ring at low tide.');
    await user.click(screen.getByRole('radio', { name: /Cosmic horror/ }));
    await user.click(screen.getByRole('radio', { name: '🔔' }));
    await user.click(nextButton());

    expect(stepHeading('Table rules')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /Strict/ }));
    await user.click(screen.getByRole('radio', { name: /Physical dice/ }));
    await user.click(screen.getByRole('radio', { name: /Experience points/ }));
    await user.click(nextButton());

    expect(stepHeading('Safety')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add Torture to Lines' }));
    await user.type(screen.getByLabelText('Veils'), 'Drowning{Enter}');
    expect(screen.getByText('1 line, 1 veil')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Create campaign' }));

    await waitFor(() => expect(createCampaign).toHaveBeenCalledTimes(1));
    expect(vi.mocked(createCampaign).mock.calls[0][0]).toEqual({
      name: 'The Salt Choir',
      premise: 'Drowned bells ring at low tide.',
      coverEmoji: '🔔',
      coverColor: '#e8a33d',
      settings: expect.objectContaining({
        tone: 'Cosmic horror: creeping dread and truths best left unknown.',
        rulesFidelity: 'strict',
        homebrewFreedom: 'moderate',
        difficulty: 'standard',
        narrationLength: 'standard',
        playerRollMode: 'physical',
        milestoneLeveling: false,
        showDmRolls: false,
        enabledSources: ['srd-5.2.1'],
        lines: ['Torture'],
        veils: ['Drowning'],
      }),
    });
    expect(await screen.findByTestId('location')).toHaveTextContent('/campaign/camp-new/character');
    // The new save is the only copy: ask the browser not to evict it (a refusal changes nothing).
    expect(requestPersistentStorage).toHaveBeenCalledTimes(1);
  });

  it('lets the player go back without losing choices', async () => {
    const user = userEvent.setup();
    renderWizard();
    await user.type(screen.getByLabelText('Campaign name'), 'Red Salt Road');
    await user.click(nextButton());
    await user.click(screen.getByRole('radio', { name: /Brutal/ }));
    await user.click(screen.getByRole('button', { name: 'Back' }));

    expect(screen.getByLabelText('Campaign name')).toHaveValue('Red Salt Road');
    await user.click(nextButton());
    expect(screen.getByRole('radio', { name: /Brutal/ })).toBeChecked();
  });

  it('fills the first step from an original premise with "Surprise me"', async () => {
    const user = userEvent.setup();
    renderWizard();
    await user.click(screen.getByRole('button', { name: 'Surprise me' }));

    expect(screen.getByLabelText('Campaign name')).not.toHaveValue('');
    expect(screen.getByLabelText('Premise')).not.toHaveValue('');
  });

  it('keeps the creation error visible and stays on the wizard', async () => {
    vi.mocked(createCampaign).mockRejectedValue(new Error('Disk full'));
    const user = userEvent.setup();
    renderWizard();
    await user.type(screen.getByLabelText('Campaign name'), 'Cinderwake');
    await user.click(nextButton());
    await user.click(nextButton());
    await user.click(screen.getByRole('button', { name: 'Create campaign' }));

    await waitFor(() => expect(createCampaign).toHaveBeenCalled());
    expect(stepHeading('Safety')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create campaign' })).toBeEnabled();
    expect(requestPersistentStorage).not.toHaveBeenCalled();
  });
});

describe('wizard helpers', () => {
  it('validates the premise step', () => {
    const draft = newCampaignDraft();
    expect(validatePremiseStep(draft)).toEqual({ name: 'Give your campaign a name.' });
    expect(validatePremiseStep({ ...draft, name: 'X', settings: { ...draft.settings, tone: ' ' } })).toEqual({
      tone: 'Pick a tone, or describe your own.',
    });
  });

  it('trims text and drops empty notes when building the input', () => {
    const draft = newCampaignDraft();
    const input = toCampaignInput({
      ...draft,
      name: '  Name ',
      premise: ' Pitch ',
      settings: { ...draft.settings, setting: ' Coast ', playerNotes: '   ' },
    });
    expect(input.name).toBe('Name');
    expect(input.premise).toBe('Pitch');
    expect(input.settings.setting).toBe('Coast');
    expect(input.settings.playerNotes).toBeUndefined();
  });
});
