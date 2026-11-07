/**
 * Stand-in for '@/dm' in Play tests: vi.mock('@/dm', () => import('@/ui/play/testing/dmMock')).
 */
import { vi } from 'vitest';
import type { DmController } from '@/dm';

export const dm = {
  beginOrResume: vi.fn<DmController['beginOrResume']>(async () => {}),
  sendPlayerMessage: vi.fn<DmController['sendPlayerMessage']>(async () => {}),
  regenerate: vi.fn<DmController['regenerate']>(async () => {}),
  retry: vi.fn<DmController['retry']>(async () => {}),
  cancel: vi.fn<DmController['cancel']>(() => {}),
  endSession: vi.fn<DmController['endSession']>(async () => {}),
  isBusy: vi.fn<DmController['isBusy']>(() => false),
};

/** Reset call history and default implementations between tests. */
export function resetDmMock(): void {
  dm.beginOrResume.mockReset().mockImplementation(async () => {});
  dm.sendPlayerMessage.mockReset().mockImplementation(async () => {});
  dm.regenerate.mockReset().mockImplementation(async () => {});
  dm.retry.mockReset().mockImplementation(async () => {});
  dm.cancel.mockReset().mockImplementation(() => {});
  dm.endSession.mockReset().mockImplementation(async () => {});
  dm.isBusy.mockReset().mockImplementation(() => false);
}
