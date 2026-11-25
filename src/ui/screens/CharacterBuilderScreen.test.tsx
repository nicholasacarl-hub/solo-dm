/**
 * The builder screen lists spells for its own campaign: that campaign's homebrew and shared homebrew, each
 * saying it is homebrew, and never another campaign's, which this campaign's DM couldn't look up (the rules
 * search hides it). The real rules index over the abridged SRD spell fixture; invented homebrew names only.
 */
import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RulesIndex } from '@/data';
import { createRulesIndex } from '@/data/search';
import { sampleCampaign } from '@/test/fixtures';
import { HOMEBREW_SOURCE_ID, type HomebrewEntry } from '@/types';
import { spellFixture } from '@/ui/builder/testing/builderFixture';
import { resetFakeGame } from '@/ui/builder/testing/fakeGameStore';
import { emptyDraft } from '@/ui/builder/types';
import { writeDraft } from '@/ui/builder/useBuilderDraft';
import { autoCleanup, renderRoute } from '@/ui/shell/testUtils';
import { CharacterBuilderScreen } from './CharacterBuilderScreen';

const mocks = vi.hoisted(() => ({ index: null as RulesIndex | null }));

vi.mock('@/images', () => import('@/ui/play/testing/imagesMock'));
vi.mock('@/state/gameStore', async () => (await import('@/ui/builder/testing/fakeGameStore')).fakeGameStoreModule());
vi.mock('@/data', async () => {
  const { builderFixture } = await import('@/ui/builder/testing/builderFixture');
  const data = builderFixture();
  return {
    getBuilderProblems: () => [],
    countUnreviewedOptions: async () => [],
    useBuilderData: () => ({ data, error: null, loading: false }),
    loadBuilderData: async () => data,
    useRulesIndex: () => mocks.index,
    useRulesIndexState: () => ({ index: mocks.index, loading: false, error: null }),
    getRulesIndex: async () => mocks.index,
  };
});

const campaignA = sampleCampaign({ id: 'campaign-A' });

/** A spell the player saved in the Library, with the summary in the Homebrew dialog's hint format. */
const homebrewSpell = (id: string, name: string, campaignId: string | null): HomebrewEntry => ({
  id,
  sourceId: HOMEBREW_SOURCE_ID,
  sourceName: 'Homebrew',
  kind: 'spell',
  name,
  summary: 'Level 1 Evocation (Wizard)',
  text: `${name}: an invented spell.`,
  campaignId,
  origin: 'player',
  status: 'active',
  createdAt: 1,
  updatedAt: 1,
});

function renderScreen() {
  return renderRoute(<CharacterBuilderScreen />, { path: '/campaign/:id/character', at: `/campaign/${campaignA.id}/character` });
}

autoCleanup();
beforeEach(() => {
  sessionStorage.clear();
  resetFakeGame({ campaign: campaignA, character: null });
  mocks.index = createRulesIndex([
    ...spellFixture(),
    homebrewSpell('hb:ember-lance', 'Ember Lance', 'campaign-B'),
    homebrewSpell('hb:cinder-veil', 'Cinder Veil', 'campaign-A'),
    homebrewSpell('hb:lantern-spark', 'Lantern Spark', null),
  ]);
});

describe('CharacterBuilderScreen spells', () => {
  it("lists this campaign's and shared homebrew on the class list, labelled as homebrew, and never another campaign's", () => {
    // The scenario: Ember Lance was saved in campaign B, so campaign A's DM can't find it by name.
    expect(mocks.index?.findByName('Ember Lance', { campaignId: campaignA.id })).toBeUndefined();
    writeDraft(campaignA.id, { ...emptyDraft(), step: 'spells', classId: 'srd:class:wizard' });
    renderScreen();
    const spellbook = within(screen.getByRole('list', { name: 'Spellbook (level 1 spells)' }));
    expect(spellbook.queryByRole('checkbox', { name: /Ember Lance/ })).toBeNull();
    expect(spellbook.getByRole('checkbox', { name: /^Cinder Veil\s*From Homebrew/ })).toBeInTheDocument();
    expect(spellbook.getByRole('checkbox', { name: /^Lantern Spark\s*From Homebrew/ })).toBeInTheDocument();
    // The SRD's own spells name no source.
    expect(spellbook.getByRole('checkbox', { name: /^Magic Missile/ })).not.toHaveAccessibleName(/From/);
    expect(spellbook.getAllByRole('checkbox')).toHaveLength(9);
  });
});
