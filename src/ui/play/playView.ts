/**
 * View-only state of the Play screen (not persisted, not seen by the DM): the mobile tab,
 * spoiler toggles, the composer's draft and prefill requests. Reset whenever the table unmounts.
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
  /**
   * The composer's unsent text and OOC toggle. Kept here, not in the composer, so they survive the
   * composer remounting when the window crosses the desktop breakpoint (an iPad rotating).
   */
  draft: string;
  ooc: boolean;
  setMobileTab(tab: MobileTab): void;
  setRevealAllDmRolls(value: boolean): void;
  setShowSpoilers(value: boolean): void;
  /** Put text in the composer (and bring the story into view on mobile). */
  prefillComposer(text: string): void;
  setDraft(text: string): void;
  setOoc(value: boolean): void;
  reset(): void;
}

const initial = {
  mobileTab: 'story' as MobileTab,
  revealAllDmRolls: false,
  showSpoilers: false,
  prefill: null,
  draft: '',
  ooc: false,
};

let nonce = 0;

export const usePlayView = create<PlayViewState>()((set) => ({
  ...initial,
  setMobileTab: (mobileTab) => set({ mobileTab }),
  setRevealAllDmRolls: (revealAllDmRolls) => set({ revealAllDmRolls }),
  setShowSpoilers: (showSpoilers) => set({ showSpoilers }),
  prefillComposer: (text) => set({ prefill: { text, nonce: ++nonce }, mobileTab: 'story' }),
  setDraft: (draft) => set({ draft }),
  setOoc: (ooc) => set({ ooc }),
  reset: () => set(initial),
}));
