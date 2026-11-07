import { describe, expect, it } from 'vitest';
import { sampleQuests } from '@/test/fixtures';
import type { Clock, Quest } from '@/types';
import { ambitionClock, nameKey, splitAmbitions } from './ambitions';

const clock = (overrides: Partial<Clock>): Clock => ({
  id: 'c',
  campaignId: 'camp-1',
  name: 'Clock',
  segments: 8,
  filled: 0,
  kind: 'progress',
  secret: false,
  resolved: false,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

const quest = (overrides: Partial<Quest>): Quest => ({
  id: 'q',
  campaignId: 'camp-1',
  title: 'Quest',
  status: 'active',
  summary: '',
  objectives: [],
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

describe('nameKey', () => {
  it('ignores case, punctuation, curly quotes, accents and spacing', () => {
    expect(nameKey("Found a Thieves' Guild")).toBe(nameKey('found a thieves’ guild'));
    expect(nameKey('  Take   the  throne! ')).toBe('take the throne');
    expect(nameKey('Réclamer la Côte')).toBe('reclamer la cote');
    expect(nameKey('Found a guild')).not.toBe(nameKey('Found a guild hall'));
  });
});

describe('ambitionClock', () => {
  const guild = { title: "Found a thieves' guild" };

  it('finds the clock with the same name, preferring a progress clock', () => {
    const threat = clock({ id: 'threat', name: 'Found a Thieves’ Guild', kind: 'threat' });
    const progress = clock({ id: 'progress', name: "found a thieves' guild" });
    expect(ambitionClock(guild, [threat, progress], false)?.id).toBe('progress');
    expect(ambitionClock(guild, [threat], false)?.id).toBe('threat');
    expect(ambitionClock(guild, [clock({ name: 'The Syndicate notices' })], false)).toBeUndefined();
  });

  it('never shows a secret clock while spoilers are off', () => {
    const secret = clock({ name: "Found a thieves' guild", secret: true });
    expect(ambitionClock(guild, [secret], false)).toBeUndefined();
    expect(ambitionClock(guild, [secret], true)).toBe(secret);
  });

  it('matches nothing for an empty title', () => {
    expect(ambitionClock({ title: '  ' }, [clock({ name: '' })], true)).toBeUndefined();
  });
});

describe('splitAmbitions', () => {
  it('takes ambitions out of the ordinary quest list, open ones first, otherwise in their order', () => {
    const achieved = quest({ id: 'a1', title: 'Win the regatta', ambition: true, status: 'completed' });
    const guild = quest({ id: 'a2', title: 'Found a guild', ambition: true, status: 'active' });
    const idea = quest({ id: 'a3', title: 'Own a ship', ambition: true, status: 'rumor' });
    const lost = quest({ id: 'a4', title: 'Take the throne', ambition: true, status: 'failed' });
    const { ambitions, quests } = splitAmbitions([achieved, ...sampleQuests(), lost, guild, idea]);
    expect(ambitions.map((q) => q.id)).toEqual(['a2', 'a3', 'a1', 'a4']);
    expect(quests.map((q) => q.id)).toEqual(['q-1', 'q-2']);
  });
});
