/**
 * View-only state of the Play screen (not persisted, not seen by the DM): the mobile tab,
 * spoiler toggles, the composer's draft and prefill requests, and the battle map's view state
 * (dock size, mode, cameras, the move plan, measuring, area templates). Reset whenever the table unmounts.
 */
import { create } from 'zustand';
import type { AreaSpec, GridPoint } from '@/types';

export type MobileTab = 'story' | 'sheet' | 'combat' | 'journal' | 'rules';

export interface ComposerPrefill {
  text: string;
  /** Changes on every request so the same text can be prefilled twice. */
  nonce: number;
}

/** Desktop battle-map dock: the 44px BattleBar, the default height, or tall. */
export type MapDockSize = 'collapsed' | 'normal' | 'large';
/** What a tap on the battle map does. */
export type MapMode = 'move' | 'measure' | 'area';
/** A battle map's camera: square size in px and the view's centre (cx, cy; their units are camera.ts's to define). */
export interface MapCamera {
  cellPx: number;
  cx: number;
  cy: number;
}
/** The hero's planned move (the same fields commitHeroMove takes). */
export interface MapPlan {
  to: GridPoint;
  prefer: 'safest' | 'shortest';
  dash: boolean;
  disengage: boolean;
  standUp: boolean;
}
/** One end of a measurement: a creature (by id) or a square. */
export type MapMeasureEnd = { id: string } | GridPoint;
export interface MapMeasure {
  from: MapMeasureEnd;
  to: MapMeasureEnd | null;
}
/** The player's area template while it is being placed. */
export interface MapTemplate {
  spec: AreaSpec;
  label: string;
  rangeFt?: number;
  snap: 'square' | 'corner';
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
  /** Desktop dock size; default 'normal'. */
  mapDock: MapDockSize;
  /** Default 'move'. */
  mapMode: MapMode;
  /** The PositionsList instead of the viewport. */
  mapList: boolean;
  /** Per map id (BattleMap.id): survives the Combat-tab unmount and the 1024px remount. */
  cameras: Record<string, MapCamera>;
  plan: MapPlan | null;
  measure: MapMeasure | null;
  template: MapTemplate | null;
  /** Tracker hover ↔ token. */
  highlightedId: string | null;
  /** The map's keyboard cursor. */
  cursor: GridPoint | null;
  /** Nonce: the Composer focuses itself without touching the draft. */
  composerFocus: number;
  setMobileTab(tab: MobileTab): void;
  setRevealAllDmRolls(value: boolean): void;
  setShowSpoilers(value: boolean): void;
  /** Put text in the composer (and bring the story into view on mobile). */
  prefillComposer(text: string): void;
  setDraft(text: string): void;
  setOoc(value: boolean): void;
  setMapDock(value: MapDockSize): void;
  setMapMode(mode: MapMode): void;
  setMapList(value: boolean): void;
  setCamera(mapId: string, camera: MapCamera): void;
  setPlan(plan: MapPlan | null): void;
  setMeasure(measure: MapMeasure | null): void;
  setTemplate(template: MapTemplate | null): void;
  setHighlighted(id: string | null): void;
  setCursor(square: GridPoint | null): void;
  /** Focus the composer (phone: switch to Story) without replacing the draft. */
  focusComposer(): void;
  /** Append a line to the draft (newline-separated), switch to Story on phones, and focus. Never replaces text. */
  appendToDraft(line: string): void;
  /** Desktop: expand the dock; phone: switch to the Combat tab. */
  focusMap(): void;
  reset(): void;
}

const initial = () => ({
  mobileTab: 'story' as MobileTab,
  revealAllDmRolls: false,
  showSpoilers: false,
  prefill: null,
  draft: '',
  ooc: false,
  mapDock: 'normal' as MapDockSize,
  mapMode: 'move' as MapMode,
  mapList: false,
  cameras: {} as Record<string, MapCamera>,
  plan: null,
  measure: null,
  template: null,
  highlightedId: null,
  cursor: null,
  composerFocus: 0,
});

let nonce = 0;

/** `line` after the draft's text on its own line; the draft itself is never changed. */
function withLine(draft: string, line: string): string {
  if (!draft.trim()) return line;
  return draft.endsWith('\n') ? `${draft}${line}` : `${draft}\n${line}`;
}

// The mobile tab only shows on phones, so the Story / Combat switches below are harmless on desktop.
export const usePlayView = create<PlayViewState>()((set) => ({
  ...initial(),
  setMobileTab: (mobileTab) => set({ mobileTab }),
  setRevealAllDmRolls: (revealAllDmRolls) => set({ revealAllDmRolls }),
  setShowSpoilers: (showSpoilers) => set({ showSpoilers }),
  prefillComposer: (text) => set({ prefill: { text, nonce: ++nonce }, mobileTab: 'story' }),
  setDraft: (draft) => set({ draft }),
  setOoc: (ooc) => set({ ooc }),
  setMapDock: (mapDock) => set({ mapDock }),
  setMapMode: (mapMode) => set({ mapMode }),
  setMapList: (mapList) => set({ mapList }),
  setCamera: (mapId, camera) => set((s) => ({ cameras: { ...s.cameras, [mapId]: camera } })),
  setPlan: (plan) => set({ plan }),
  setMeasure: (measure) => set({ measure }),
  setTemplate: (template) => set({ template }),
  setHighlighted: (highlightedId) => set({ highlightedId }),
  setCursor: (cursor) => set({ cursor }),
  focusComposer: () => set((s) => ({ composerFocus: s.composerFocus + 1, mobileTab: 'story' })),
  appendToDraft: (line) =>
    set((s) => ({ draft: withLine(s.draft, line), composerFocus: s.composerFocus + 1, mobileTab: 'story' })),
  focusMap: () => set((s) => ({ mapDock: s.mapDock === 'collapsed' ? 'normal' : s.mapDock, mobileTab: 'combat' })),
  reset: () => set(initial()),
}));
