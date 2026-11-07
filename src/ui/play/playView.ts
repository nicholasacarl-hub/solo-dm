/**
 * View-only state of the Play screen (not persisted, not seen by the DM): the mobile tab,
 * spoiler toggles and composer prefill requests. Reset whenever the table unmounts.
 */
import { create } from 'zustand';

export type MobileTab = 'story' | 'sheet' | 'combat' | 'journal' | 'rules';

export interface ComposerPrefill {
  text: string;
  /** Changes on every request so the same text can be prefilled twice. */
  nonce: number;
}

interface PlayViewState {
  mobileTab: MobileTab;
  /** Header toggle: reveal every secret DM roll in this view. */
  revealAllDmRolls: boolean;
  /** Journal toggle: show DM-only journal entries, clocks, notes and secret log lines. */
  showSpoilers: boolean;
  prefill: ComposerPrefill | null;
  setMobileTab(tab: MobileTab): void;
  setRevealAllDmRolls(value: boolean): void;
  setShowSpoilers(value: boolean): void;
  /** Put text in the composer (and bring the story into view on mobile). */
  prefillComposer(text: string): void;
  reset(): void;
}

const initial = {
  mobileTab: 'story' as MobileTab,
  revealAllDmRolls: false,
  showSpoilers: false,
  prefill: null,
};

let nonce = 0;

export const usePlayView = create<PlayViewState>()((set) => ({
  ...initial,
  setMobileTab: (mobileTab) => set({ mobileTab }),
  setRevealAllDmRolls: (revealAllDmRolls) => set({ revealAllDmRolls }),
  setShowSpoilers: (showSpoilers) => set({ showSpoilers }),
  prefillComposer: (text) => set({ prefill: { text, nonce: ++nonce }, mobileTab: 'story' }),
  reset: () => set(initial),
}));
