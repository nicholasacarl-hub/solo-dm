import '../testing/setup';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useGame } from '@/state/gameStore';
import { toast } from '@/ui/components/toast';
import { resetDmMock } from '../testing/dmMock';
import { seedGame } from '../testing/seed';
import { TableRulesDialog } from './SessionDialogs';

vi.mock('@/dm', () => import('../testing/dmMock'));
vi.mock('@/engine', () => import('../testing/engineMock'));
vi.mock('@/data', () => ({ useRulesIndex: () => null }));
vi.mock('@/storage', () => ({ useLibrarySources: () => [] }));

function renderRules() {
  const spies = seedGame();
  const onClose = vi.fn();
  render(
    <MemoryRouter>
      <TableRulesDialog open onClose={onClose} />
    </MemoryRouter>,
  );
  const dialog = screen.getByRole('dialog', { name: 'Table rules' });
  return { spies, onClose, dialog, user: userEvent.setup() };
}

beforeEach(() => resetDmMock());
afterEach(() => vi.restoreAllMocks());

describe('TableRulesDialog: battle maps', () => {
  it('saves a battle-maps-only change and says the DM will hear about it (the DM harness tells the DM)', async () => {
    const success = vi.spyOn(toast, 'success');
    const { spies, onClose, dialog, user } = renderRules();
    const save = within(dialog).getByRole('button', { name: 'Save changes' });
    expect(save).toBeDisabled();

    const group = within(dialog).getByRole('group', { name: 'Battle maps' });
    expect(within(group).getByRole('radio', { name: /When it helps/ })).toBeChecked();
    await user.click(within(group).getByRole('radio', { name: /Every fight/ }));
    expect(save).toBeEnabled();
    await user.click(save);

    await waitFor(() => expect(spies.updateCampaign).toHaveBeenCalledTimes(1));
    expect(useGame.getState().campaign?.settings.battleMaps).toBe('always');
    expect(spies.queueDmNotice).not.toHaveBeenCalled();
    expect(success).toHaveBeenCalledWith('Table rules updated. The DM will hear about it on your next turn.');
    expect(onClose).toHaveBeenCalled();
  });

  it('a change back to the default still counts (missing means When it helps)', async () => {
    const { dialog, user } = renderRules();
    const group = within(dialog).getByRole('group', { name: 'Battle maps' });
    const save = within(dialog).getByRole('button', { name: 'Save changes' });
    await user.click(within(group).getByRole('radio', { name: /Off — theater of the mind/ }));
    expect(save).toBeEnabled();
    await user.click(within(group).getByRole('radio', { name: /When it helps/ }));
    expect(save).toBeDisabled();
  });
});
