/**
 * A stand-in for the '@/state/gameStore' module in DM tests (vi.mock), so tests never load the
 * real store's persistence code. The DM reaches the store through deps, which tests replace with
 * createFakeGameStore().
 */
import { create } from 'zustand';
import type { DmStatus, GameStore } from '@/state/gameStore';

export const initialDmStatus: DmStatus = { phase: 'idle', activity: null, error: null, retryable: false };

export const useGame = create<Partial<GameStore>>()(() => ({}));
