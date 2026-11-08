import { beforeEach, describe, expect, it } from 'vitest';
import { usePlayView } from './playView';

const view = () => usePlayView.getState();

beforeEach(() => view().reset());

describe('battle-map view state', () => {
  it('starts with the map defaults', () => {
    expect(view()).toMatchObject({
      mapDock: 'normal',
      mapMode: 'move',
      mapList: false,
      cameras: {},
      plan: null,
      measure: null,
      template: null,
      highlightedId: null,
      cursor: null,
      composerFocus: 0,
    });
  });

  it('keeps one camera per map id', () => {
    view().setCamera('map-1', { cellPx: 40, cx: 3, cy: 4 });
    view().setCamera('map-2', { cellPx: 24, cx: 8, cy: 6 });
    view().setCamera('map-1', { cellPx: 44, cx: 2, cy: 5 });
    expect(view().cameras).toEqual({ 'map-1': { cellPx: 44, cx: 2, cy: 5 }, 'map-2': { cellPx: 24, cx: 8, cy: 6 } });
  });

  it('appendToDraft adds a line without replacing the draft, switches to Story and asks for focus', () => {
    view().setMobileTab('combat');
    view().appendToDraft('I keep moving to A7.');
    expect(view()).toMatchObject({ draft: 'I keep moving to A7.', mobileTab: 'story', composerFocus: 1 });

    view().setDraft('I swing at the bandit');
    view().appendToDraft('[Area: Fireball — 20-ft sphere centred on G4; on my map it catches Bandit 1, Bandit 2]');
    expect(view().draft).toBe('I swing at the bandit\n[Area: Fireball — 20-ft sphere centred on G4; on my map it catches Bandit 1, Bandit 2]');
    expect(view().composerFocus).toBe(2);

    view().setDraft('Two lines\n');
    view().appendToDraft('I end my turn.');
    expect(view().draft).toBe('Two lines\nI end my turn.');
  });

  it('focusComposer only asks for focus (phone: the Story tab); the draft is untouched', () => {
    view().setDraft('half a thought');
    view().setMobileTab('combat');
    view().focusComposer();
    expect(view()).toMatchObject({ draft: 'half a thought', mobileTab: 'story', composerFocus: 1 });
  });

  it('focusMap expands a collapsed dock and switches phones to the Combat tab', () => {
    view().setMapDock('collapsed');
    view().focusMap();
    expect(view()).toMatchObject({ mapDock: 'normal', mobileTab: 'combat' });
    view().setMapDock('large');
    view().focusMap();
    expect(view().mapDock).toBe('large');
  });

  it('reset clears the map view state', () => {
    view().setMapMode('area');
    view().setPlan({ to: { x: 3, y: 7 }, prefer: 'safest', dash: false, disengage: false, standUp: false });
    view().setCursor({ x: 1, y: 5 });
    view().setCamera('map-1', { cellPx: 40, cx: 3, cy: 4 });
    view().focusComposer();
    view().reset();
    expect(view()).toMatchObject({ mapMode: 'move', plan: null, cursor: null, cameras: {}, composerFocus: 0 });
  });
});
