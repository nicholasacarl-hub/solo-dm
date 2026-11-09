/**
 * End to end with a fake Anthropic API (spec §8.4): the real @/data, @/storage, @/state/gameStore and DM
 * tool handlers over fake-indexeddb; the SRD JSON served by a stubbed fetch; Claude played by
 * FakeExtractionClient (SCRIPTED_WIRE by block title). Function level: no app clicking.
 *
 * The steps run in order and share state (a later step needs the earlier ones). Book content is the
 * invented "Gloamwood Almanac" (src/test/structuredFixtures.ts) and nothing else.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import builderRaw from '../../../public/srd/builder.json?raw';
import compendiumRaw from '../../../public/srd/compendium.json?raw';
import {
  buildLibraryLookup,
  candidatesForRecords,
  detectionContext,
  detectStructure,
  exportPack,
  gainedFeatures,
  getRulesIndex,
  importLibraryDocument,
  invalidateRulesIndex,
  loadBuilderData,
  parsePack,
  type PackFileV1,
} from '@/data';
import {
  applyFeatChoice,
  featChoices,
  featChoiceTrigger,
  subclassRefOf,
  type FeatChoice,
  type FeatPick,
} from '@/data/options/levelUpChoices';
import { rulesIndexVersion, resetRulesIndex } from '@/data/rulesIndexStore';
import { resetSrdCache, loadSrdBuilderData } from '@/data/srd';
import { estimateModels, retryRecords, startJob } from '@/dm';
import { usageDelta } from '@/dm/cost';
import { buildExtractionRequest, EXTRACT_MAX_TOKENS, EXTRACT_MAX_TOKENS_CAP } from '@/dm/libraryRequests';
import { requestBlocks } from '@/dm/extract/blocks';
import type { ExtractionClient } from '@/dm/extract/call';
import { setExtractionDeps, resetExtractionDeps } from '@/dm/extract/deps';
import { FakeExtractionClient, type RecordedExtractionRequest } from '@/dm/testing/fakeExtractionClient';
import { deps as dmDeps } from '@/dm/deps';
import type { ToolContext } from '@/dm/tools/context';
import { runTool } from '@/dm/tools/handlers';
import { characterSheetText, levelUp, proficiencyBonus } from '@/engine';
import { importedPlaceholder } from '@/lib/importedContent';
import { useGame, whenPersisted } from '@/state/gameStore';
import {
  createCampaign,
  exportCampaignBundleWithReport,
  getJob,
  getSourceEntries,
  importCampaignBundle,
  listRecords,
  parseCampaignBundle,
  saveLibrarySourceWithRecords,
} from '@/storage';
import { serializeBundle } from '@/storage/backup';
import { db } from '@/storage/db';
import { decideSync } from '@/storage/githubSync';
import { loadTargetState, saveTargetState, syncTargetKey } from '@/storage/syncState';
import { resetDatabase } from '@/storage/testData';
import {
  acceptConfident,
  acceptRecords,
  resetReviewActionsForTests,
  saveRecordEdit,
  setParentClass,
} from '@/ui/library/structure/reviewActions';
import { parentChoices, suggestedParent } from '@/ui/library/structure/forms/ParentClassSelect';
import { buildCharacter, emptyDraft, firstIncompleteStep, type BuilderContext, type BuilderDraft } from '@/ui/builder/logic';
import { sampleSettings } from '@/test/fixtures';
import { GLOAMWOOD_CANDIDATES, GLOAMWOOD_MARKERS, GLOAMWOOD_MIXED, GLOAMWOOD_TITLE, TEXT } from '@/test/structuredFixtures';
import {
  DEFAULT_SETTINGS,
  type BuilderData,
  type Campaign,
  type Character,
  type ExtractionJob,
  type ModelId,
  type MonsterData,
  type StructuredRecord,
  type SubclassData,
  type SubclassOption,
  type UsageTotals,
} from '@/types';

const SETTINGS = { ...DEFAULT_SETTINGS, apiKey: 'sk-ant-test', mockMode: false, model: 'claude-opus-5-5' as const, useFallbacks: true };

/** What the steps share. */
const run: {
  sourceId: string;
  fake: FakeExtractionClient;
  /** Each answer's usage as the call path prices it (usageDelta), in the order the answers were read. */
  priced: UsageTotals[];
  firstJob?: ExtractionJob;
  builder?: BuilderData;
  bookData?: PackFileV1;
  acceptedCount?: number;
  campaign?: Campaign;
  character?: Character;
  bundleText?: string;
  originals: Map<string, string>;
} = { sourceId: '', fake: new FakeExtractionClient({ sleep: async () => undefined }), priced: [], originals: new Map() };

const records = () => listRecords(run.sourceId);
const recordNamed = async (name: string) => {
  const found = (await records()).find((r) => r.name === name);
  if (!found) throw new Error(`no record named ${name}`);
  return found;
};
const waitForJob = (id: string) =>
  vi.waitFor(
    async () => {
      const job = await getJob(id);
      expect(job?.status).toBe('done');
      return job as ExtractionJob;
    },
    { timeout: 15_000, interval: 25 },
  );
/** Wait for the review actions' debounced refresh (500 ms) to land. */
const settleRefresh = () => new Promise((resolve) => setTimeout(resolve, 650));

/** The fake Anthropic client, with every answer's usage priced as runExtraction prices it (for the job's bill). */
const client: ExtractionClient = {
  beta: {
    messages: {
      stream(params, options) {
        const stream = run.fake.beta.messages.stream(params, options);
        return {
          [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](),
          abort: () => stream.abort(),
          finalMessage: async () => {
            const message = await stream.finalMessage();
            run.priced.push(usageDelta(message.usage, message.model || params.model, '5m', params.model));
            return message;
          },
        };
      },
    },
  },
};

const sumUsage = (list: readonly UsageTotals[]): UsageTotals =>
  list.reduce(
    (a, b) => ({
      requests: a.requests + b.requests,
      inputTokens: a.inputTokens + b.inputTokens,
      outputTokens: a.outputTokens + b.outputTokens,
      cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
      cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
      estimatedCostUsd: a.estimatedCostUsd + b.estimatedCostUsd,
    }),
    { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: 0 },
  );

/** The job's bill equals what its answers cost (tokens exactly; dollars up to float rounding). */
function expectBilled(job: ExtractionJob, answers: readonly UsageTotals[]): void {
  const { estimatedCostUsd, ...tokens } = sumUsage(answers);
  const { estimatedCostUsd: billed, ...billedTokens } = job.usage;
  expect(billedTokens).toEqual(tokens);
  expect(billed).toBeGreaterThan(0);
  expect(billed).toBeCloseTo(estimatedCostUsd, 9);
}

/**
 * Every request a job sent is exactly what the audited builder makes from its record's own blocks
 * (rule 4): no other entry, no title, no character or campaign; a retry after max_tokens doubles it.
 */
async function expectAuditedRequests(job: ExtractionJob, requests: readonly RecordedExtractionRequest[], model: ModelId): Promise<void> {
  const jobRecords = (await records()).filter((r) => r.jobId === job.id);
  const [entries, context] = await Promise.all([getSourceEntries(run.sourceId), detectionContext()]);
  const { candidates } = candidatesForRecords(jobRecords, entries, context.segment);
  const byTitle = new Map<string, { record: StructuredRecord; blocks: ReturnType<typeof requestBlocks>['blocks'] }>();
  for (const record of jobRecords) {
    const candidate = candidates.get(record.id);
    if (!candidate) continue;
    const { blocks } = requestBlocks({ ...candidate, key: record.candidateKey });
    byTitle.set(blocks[0].title, { record, blocks });
  }
  const attempts = new Map<string, number>();
  for (const r of requests) {
    const planned = byTitle.get(r.title ?? '');
    expect(planned, r.title ?? 'a request without a block').toBeDefined();
    if (!planned) continue;
    const attempt = attempts.get(r.title ?? '') ?? 0;
    attempts.set(r.title ?? '', attempt + 1);
    const { kind } = planned.record;
    const maxTokens = attempt > 0 ? { maxTokens: Math.min(2 * EXTRACT_MAX_TOKENS[kind], EXTRACT_MAX_TOKENS_CAP) } : {};
    expect(r.params, r.title ?? '').toEqual(buildExtractionRequest({ kind, model, useFallbacks: true, blocks: planned.blocks, ...maxTokens }));
    expect(JSON.stringify(r.params)).not.toContain(GLOAMWOOD_TITLE);
    expect(r.options.maxRetries).toBe(0);
  }
}

beforeAll(async () => {
  await resetDatabase();
  resetSrdCache();
  resetRulesIndex();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => new Response(String(url).endsWith('compendium.json') ? compendiumRaw : builderRaw, { status: 200 })),
  );
  setExtractionDeps({ client: () => client, settings: () => SETTINGS, sleep: async () => undefined, locks: null, dmBusy: () => false, pageHidden: () => false, online: () => true, keepSaves: () => undefined });
});

afterAll(async () => {
  resetReviewActionsForTests();
  resetExtractionDeps();
  useGame.getState().unloadCampaign();
  await whenPersisted();
  vi.unstubAllGlobals();
});

describe('structured imports end to end (spec §8.4)', { timeout: 30_000 }, () => {
  it('1. imports the mixed-dialect book with a fingerprint', async () => {
    const source = await importLibraryDocument({ title: GLOAMWOOD_TITLE, format: 'markdown', text: GLOAMWOOD_MIXED });
    run.sourceId = source.id;
    expect(source.entryCount).toBe(52);
    expect(source.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect((await db.library.get(source.id))?.fingerprint).toBe(source.fingerprint);
  });

  it('2. detects every candidate, reads the Markdown entries offline and leaves the flattened ones for Claude', async () => {
    const summary = await detectStructure(run.sourceId);
    // Counts by kind equal the fixture's (a gear table counts once, through its row).
    const expected = new Map<string, number>();
    for (const c of GLOAMWOOD_CANDIDATES) expected.set(c.kind, (expected.get(c.kind) ?? 0) + 1);
    for (const [kind, found] of expected) expect(summary.byKind[kind as StructuredRecord['kind']]?.found, kind).toBe(found);
    expect(summary.total).toBe(GLOAMWOOD_CANDIDATES.length);
    expect(summary.leftOut).toBe(0);
    const all = await records();
    const byName = new Map(all.map((r) => [r.name, r]));
    for (const name of ['Ashen Choir', 'Cinder Mote', "Moth's Grace", 'Lantern Bearer', 'Hooked Reach', 'Lamplighter', 'Ferry Hand', 'Ember Warden', 'Bramble Hound', 'Hookstaff']) {
      expect(byName.get(name)?.data, name).not.toBeNull();
    }
    expect(byName.get('Bramble Hound')?.adaptations.map((a) => a.code)).toContain('monster-2014-statblock');
    for (const name of ['Wickwright', 'Glimmerwing Drake', 'Mothkin']) {
      const r = byName.get(name);
      expect(r?.data, name).toBeNull();
      expect(r?.warnings.map((w) => w.code), name).toContain('needs-claude');
    }
    // Lore stays a rule: no record starts at The Long Dusk.
    const longDusk = (await db.libraryEntries.where('sourceId').equals(run.sourceId).toArray()).find((e) => e.name === 'The Long Dusk');
    expect(all.some((r) => r.entryIds[0] === longDusk?.id)).toBe(false);
  });

  it('3. structures the rest with Claude: one warm-up per kind, a max_tokens retry, a refusal, then a retry on Sonnet', async () => {
    const estimates = await estimateModels(run.sourceId, { claudeFor: 'misses' });
    expect(estimates).toHaveLength(3);
    expect(estimates[0].model).toBe('claude-opus-5-5');

    run.fake.script('Glimmerwing Drake', { type: 'max_tokens' });
    run.fake.script('Mothkin', { type: 'refusal', category: 'cyber' });
    const job = await startJob(run.sourceId, { model: 'claude-opus-5-5', claudeFor: 'misses' });
    const done = await waitForJob(job.id);
    run.firstJob = done;

    const reqs = [...run.fake.requests];
    // The three flattened entries, plus the Goblin Warrior (no ability scores printed: it stays unreadable).
    expect(reqs.map((r) => r.title).sort()).toEqual(['Glimmerwing Drake', 'Glimmerwing Drake', 'Goblin Warrior', 'Mothkin', 'Wickwright']);
    // Every body is the audited builder's output for its record's own blocks (rule 4); the drake's retry doubles max_tokens.
    await expectAuditedRequests(done, reqs, 'claude-opus-5-5');
    const drake = reqs.filter((r) => r.title === 'Glimmerwing Drake');
    expect(drake.map((r) => r.step)).toEqual(['max_tokens', 'answer']);
    expect(drake[1].params.max_tokens).toBe(12000);
    // Per kind, no second request starts before the first one's first event (the warm-up opens the lane).
    for (const kind of new Set(reqs.map((r) => r.kind))) {
      const ofKind = reqs.filter((r) => r.kind === kind);
      if (ofKind.length > 1) expect(ofKind[1].at).toBeGreaterThanOrEqual(ofKind[0].firstEventAt ?? Infinity);
    }
    expect(done.counts.refused).toBe(1);
    expect((await recordNamed('Mothkin')).runState).toBe('refused');
    // The bill is every answer's usage priced by usageDelta, the truncated and refused ones included.
    expect(run.priced).toHaveLength(reqs.length);
    expectBilled(done, run.priced);

    const before = run.fake.requests.length;
    const pricedBefore = run.priced.length;
    const retryId = await retryRecords(job.id, 'refused', 'claude-sonnet-5-5');
    expect(retryId).not.toBe(job.id);
    const retryJob = await waitForJob(retryId);
    const retry = run.fake.requests.slice(before);
    expect(retry.map((r) => r.title)).toEqual(['Mothkin']);
    expect(retry[0].params.model).toBe('claude-sonnet-5-5');
    expect(retry[0].params).toMatchObject({ fallbacks: 'default' });
    await expectAuditedRequests(retryJob, retry, 'claude-sonnet-5-5');
    expectBilled(retryJob, run.priced.slice(pricedBefore));
    expect((await recordNamed('Mothkin')).data).not.toBeNull();
  });

  it('4. reviews: accepts the confident ones in one batch (Undo works), fixes the drake, attaches the subclasses', async () => {
    const v0 = rulesIndexVersion();
    const bulk = await acceptConfident(run.sourceId);
    expect(bulk.accepted).toBeGreaterThan(5);
    const accepted = (await records()).filter((r) => r.status === 'accepted');
    expect(accepted.some((r) => r.kind === 'class' || r.kind === 'subclass')).toBe(false);
    await settleRefresh();
    expect(rulesIndexVersion()).toBe(v0 + 1);
    await bulk.undo();
    expect((await records()).filter((r) => r.status === 'accepted')).toHaveLength(0);
    const redo = await acceptConfident(run.sourceId);
    expect(redo.accepted).toBe(bulk.accepted);

    // The drake was misread ("58 (8d10 + 8)"): its HP is checked and fixed to the book's 52 before accepting.
    const drake = await recordNamed('Glimmerwing Drake');
    expect(drake.status).toBe('pending');
    expect(drake.warnings.map((w) => w.code)).toContain('cross-check');
    const fixed = await saveRecordEdit(drake, { ...(drake.data as MonsterData), hp: 52 });
    expect((fixed.data as MonsterData).hp).toBe(52);

    // "Attaches to" as the review pre-selects it: the SRD Fighter for Ember Warden, this book's Wickwright (still
    // waiting for review) for Order of the Long Wick.
    const book = await records();
    const builder = await loadBuilderData();
    const parentOf = (r: StructuredRecord) => suggestedParent((r.data as SubclassData).parentClass, r.sourceId, parentChoices(builder, r.sourceId, book));
    const ember = await recordNamed('Ember Warden');
    const wick = await recordNamed('Wickwright');
    const order = await recordNamed('Order of the Long Wick');
    expect(parentOf(ember)).toMatchObject({ id: 'srd:class:fighter', reason: 'srd' });
    expect(parentOf(order)).toMatchObject({ id: wick.publicId, reason: 'same-book' });
    await setParentClass(ember.id, parentOf(ember).id as string);
    await setParentClass(order.id, parentOf(order).id as string);
    expect((await recordNamed('Ember Warden')).parentClassId).toBe('srd:class:fighter');
    const names = ['Glimmerwing Drake', 'Ember Warden', 'Wickwright', 'Order of the Long Wick', 'Mothkin'];
    const chosen = await Promise.all(names.map((n) => recordNamed(n)));
    const result = await acceptRecords(chosen.map((r) => r.id));
    expect(result.skipped).toEqual([]);
    // (Mothkin may already be in: Sonnet's clean read made it one of the confident ones.)
    expect(result.accepted).toBe(chosen.filter((r) => r.status !== 'accepted').length);
    for (const n of names) expect((await recordNamed(n)).status, n).toBe('accepted');
    await settleRefresh();
    run.acceptedCount = (await records()).filter((r) => r.status === 'accepted').length;
  });

  it('5. the index answers with the reviewed drake, and the SRD Goblin Warrior still wins over the thin duplicate', async () => {
    const index = await getRulesIndex();
    const drake = index.findByName('Glimmerwing Drake', { kind: 'monster' });
    expect(drake?.sourceId).toBe(run.sourceId);
    expect(drake?.data).toMatchObject({ size: 'Large', reachFt: 10, ac: 17, hp: 52, recordId: expect.any(String) });
    expect(index.findByName('Goblin Warrior', { kind: 'monster' })?.sourceId).toBe('srd-5.2.1');
  });

  it('6. the builder data merges the book without touching the SRD object', async () => {
    const builder = await loadBuilderData();
    run.builder = builder;
    const srd = await loadSrdBuilderData();
    const fighter = builder.classes.find((c) => c.id === 'srd:class:fighter');
    expect(fighter?.subclasses.map((s) => s.name)).toContain('Ember Warden');
    expect(srd.classes.find((c) => c.id === 'srd:class:fighter')?.subclasses.map((s) => s.name)).not.toContain('Ember Warden');
    expect(builder.classes.find((c) => c.name === 'Wickwright')?.subclasses.map((s) => s.name)).toEqual(['Order of the Long Wick']);
    for (const [list, name] of [
      [builder.species, 'Mothkin'],
      [builder.backgrounds, 'Lamplighter'],
      [builder.feats, "Moth's Grace"],
      [builder.equipment, 'Hookstaff'],
    ] as const) {
      expect((list as readonly { name: string; source?: { title: string } }[]).find((o) => o.name === name)?.source?.title, name).toBe(GLOAMWOOD_TITLE);
    }
    const mail = builder.equipment.find((e) => e.name === "Warden's Mail");
    expect(mail).toMatchObject({ category: 'armor', armorClass: 16, magic: { bonuses: { ac: 1 } } });
    expect(builder.equipment.find((e) => e.name === 'Mothsilk Cloak')).toMatchObject({ category: 'gear', magic: { bonuses: { ac: 1, savingThrows: 1 } } });
    // "Download book data" from this device, for step 12.
    const source = await db.library.get(run.sourceId);
    const entries = await db.libraryEntries.where('sourceId').equals(run.sourceId).toArray();
    run.bookData = JSON.parse(JSON.stringify(exportPack(source as NonNullable<typeof source>, entries, await records()))) as PackFileV1;
  });

  it('7. builds a hero with the book’s background, species and gear; copied text carries refs', async () => {
    const data = run.builder as BuilderData;
    const background = data.backgrounds.find((b) => b.name === 'Lamplighter');
    const species = data.species.find((s) => s.name === 'Mothkin');
    const ctx: BuilderContext = { data, spells: [] };
    const draft: BuilderDraft = {
      ...emptyDraft(),
      classId: 'srd:class:fighter',
      fightingStyle: 'Defense',
      backgroundId: background?.id ?? null,
      bonusPlus2: 'dex',
      bonusPlus1: 'wis',
      speciesId: species?.id ?? null,
      lineage: 'Ashwing',
      lineageAbility: 'wis',
      size: 'Medium',
      assignment: { str: 0, dex: 1, con: 2, wis: 3, int: 4, cha: 5 },
      classSkills: ['athletics', 'survival'],
      languages: ['Elvish', 'Halfling'],
      classEquipment: 0,
      backgroundEquipment: 0,
      weaponMasteries: ['Longsword', 'Shortbow', 'Greatsword'],
      name: 'Wren Ashdown',
    };
    expect(firstIncompleteStep(draft, ctx)).toBeNull();
    const campaign = await createCampaign({ name: 'The Lamp Road', premise: '', settings: { ...sampleSettings(), playerRollMode: 'auto' } });
    const built = buildCharacter(draft, ctx, { campaignId: campaign.id });
    // Dusk Sight, the Ashwing lineage and Moth's Grace (resolved from the same book) carry the full text and refs.
    const bookFingerprint = (await db.library.get(run.sourceId))?.fingerprint;
    for (const [name, marker] of [['Dusk Sight', GLOAMWOOD_MARKERS[2]], ['Ashwing', GLOAMWOOD_MARKERS[3]], ["Moth's Grace", GLOAMWOOD_MARKERS[4]]] as const) {
      const f = built.features.find((x) => x.name === name);
      expect(f?.description, name).toContain(marker);
      expect(f?.ref, name).toMatchObject({ textCopied: true, sourceId: run.sourceId, sourceTitle: GLOAMWOOD_TITLE, bookFingerprint, at: expect.any(Object) });
    }
    // Every feature with book text (the species' other traits too) must come back on another device (step 11).
    for (const f of built.features.filter((x) => x.ref?.textCopied)) run.originals.set(f.name, f.description ?? '');
    expect(built.speciesRef).toMatchObject({ kind: 'species', entryName: 'Mothkin' });
    expect(built.backgroundRef).toMatchObject({ kind: 'background', entryName: 'Lamplighter' });
    const hookstaff = built.inventory.find((i) => i.name === 'Hookstaff');
    expect(hookstaff?.ref).toMatchObject({ textCopied: false });
    expect(hookstaff?.description ?? '').not.toContain('Smiths in the forest towns');
    expect(built.attacks.find((a) => a.name === 'Hookstaff')).toMatchObject({ damage: '1d8', damageType: 'bludgeoning' });
    await useGame.getState().loadCampaign(campaign.id);
    await useGame.getState().setCharacter(built);
    run.campaign = useGame.getState().campaign ?? undefined;
  });

  it('8. levels up into Ember Warden (book features with refs), then takes Lantern Bearer from the feat panel', async () => {
    const data = run.builder as BuilderData;
    const fighter = data.classes.find((c) => c.id === 'srd:class:fighter');
    const ember = fighter?.subclasses.find((s) => s.name === 'Ember Warden');
    if (!fighter || !ember) throw new Error('no Fighter or Ember Warden');
    /**
     * The level-up dialog's logic (LevelUpDialog.tsx): gainedFeatures → levelUp (with the subclass's ref) →
     * the feat panel's choice, "Decide with my DM" unless the player picks something.
     */
    const up = (c: Character, sub?: SubclassOption, choose?: (picks: FeatPick[]) => FeatChoice) => {
      const classLevel = c.classes[0].level + 1;
      const gained = gainedFeatures(fighter, classLevel, sub, { scores: c.abilityScores, characterLevel: classLevel }, { have: c.features, subclassChosenNow: Boolean(sub) });
      const subclassRef = subclassRefOf(sub);
      const leveled = levelUp(c, {
        className: 'Fighter',
        classId: 'srd:class:fighter',
        hpMethod: 'average',
        newFeatures: gained,
        equipment: data.equipment,
        ...(sub ? { subclass: sub.name, subclassId: sub.id } : {}),
        ...(subclassRef ? { subclassRef } : {}),
      }).character;
      const trigger = featChoiceTrigger(gained);
      if (!trigger) return leveled;
      const before = new Set(c.features.map((f) => f.id));
      const addedIds = new Set(leveled.features.filter((f) => !before.has(f.id)).map((f) => f.id));
      const picks = featChoices(trigger.kind, data.feats, { cls: fighter, characterLevel: classLevel, have: c.features });
      const choice = choose?.(picks) ?? { kind: 'dm' };
      return applyFeatChoice(leveled, trigger, choice, { className: 'Fighter', classLevel, addedIds, equipment: data.equipment }).character;
    };
    const game = useGame.getState();
    await game.updateCharacter((c) => up(c));
    await game.updateCharacter((c) => up(c, ember));
    const at3 = useGame.getState().character as Character;
    expect(at3.classes[0]).toMatchObject({ level: 3, subclass: 'Ember Warden', subclassId: ember.id });
    expect(at3.classes[0].subclassRef).toMatchObject({ kind: 'subclass', entryId: ember.id, entryName: 'Ember Warden', textCopied: false });
    const ward = at3.features.find((f) => f.name === 'Ember Ward');
    expect(ward?.ref).toMatchObject({ textCopied: true, kind: 'subclass', part: 'Ember Ward' });
    expect(ward?.uses).toMatchObject({ max: proficiencyBonus(3), recharge: 'long' });
    expect(at3.features.find((f) => f.name === 'Kindled Strikes')?.ref).toBeDefined();
    for (const name of ['Ember Ward', 'Kindled Strikes']) run.originals.set(name, at3.features.find((f) => f.name === name)?.description ?? '');

    // Fighter 4 offers the feat panel (Ability Score Improvement); the player takes the book's Lantern Bearer (+1 Wis).
    let offered: FeatPick | undefined;
    await game.updateCharacter((c) =>
      up(c, undefined, (picks) => {
        offered = picks.find((p) => p.name === 'Lantern Bearer');
        if (!offered) throw new Error('the feat panel does not offer Lantern Bearer');
        return { kind: 'feat', pick: offered, ability: 'wis' };
      }),
    );
    expect(offered).toMatchObject({ sourceLabel: GLOAMWOOD_TITLE, minLevel: 4, meetsLevel: true, increase: { abilities: ['wis', 'cha'], amount: 1 } });
    const at4 = useGame.getState().character as Character;
    expect(at4.classes[0].level).toBe(4);
    expect(at4.abilityScores.wis).toBe(at3.abilityScores.wis + 1);
    const bearer = at4.features.find((f) => f.name === 'Lantern Bearer');
    expect(bearer?.ref).toMatchObject({ kind: 'feat', entryName: 'Lantern Bearer', textCopied: true });
    // The feat takes the place of the level's Ability Score Improvement feature.
    expect(at4.features.some((f) => f.name === 'Ability Score Improvement')).toBe(false);
    run.originals.set('Lantern Bearer', bearer?.description ?? '');
  });

  it('9. fights the drake with its reviewed numbers; the DM sees the stats line wrapped', async () => {
    const game = useGame.getState();
    await game.startSession({
      id: 'sess-e2e',
      campaignId: run.campaign?.id as string,
      number: 1,
      status: 'active',
      model: 'claude-opus-5-5',
      systemPrompt: `## Hero\n${characterSheetText(game.character as Character)}`,
      startedAt: Date.now(),
      endedAt: null,
      recap: null,
      dmNotes: null,
      usage: { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: 0 },
      contextTokens: 0,
    });
    const ctx: ToolContext = { deps: dmDeps(), signal: new AbortController().signal, status: vi.fn() };
    const out = await runTool(
      'start_combat',
      { map: { width: 12, height: 10 }, combatants: [{ name: 'Glimmerwing Drake', side: 'enemy', stat_block: 'Glimmerwing Drake' }] },
      ctx,
    );
    expect(out.isError).toBeUndefined();
    const drake = useGame.getState().combat?.combatants.find((c) => c.name === 'Glimmerwing Drake');
    expect(drake).toMatchObject({ ac: 17, hp: { max: 52 }, initiativeBonus: 2, size: 'Large', reachFt: 10 });
    expect(drake?.speeds).toEqual({ walk: 30, fly: 60, hover: true });
    expect(out.content).toContain(`from the stat block (${GLOAMWOOD_TITLE})`);
    const entry = await runTool('get_entry', { name: 'Glimmerwing Drake' }, ctx);
    expect(entry.content).toMatch(new RegExp(`^<imported-content source="${GLOAMWOOD_TITLE}">[\\s\\S]*Reviewed stats:[\\s\\S]*</imported-content>$`));
    // A DM level_up call that echoes Ember Ward's text (rule 1: the transcript is append-only; exports redact the copy).
    await game.appendTranscript([
      { role: 'user', content: 'I level up.' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-1', name: 'level_up', input: { class_name: 'Fighter', new_features: [{ name: 'Ember Ward', description: TEXT.emberWard.join('\n\n') }] } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: entry.content }] },
    ]);
    await whenPersisted();
  });

  it('10. exports a save with no book text in it, only names and placeholders', async () => {
    const { bundle, report } = await exportCampaignBundleWithReport(run.campaign?.id as string);
    const text = serializeBundle(bundle);
    run.bundleText = text;
    for (const marker of GLOAMWOOD_MARKERS) expect(text, marker).not.toContain(marker);
    const placeholder = importedPlaceholder(GLOAMWOOD_TITLE);
    expect(text).toContain(JSON.stringify(placeholder).slice(1, -1));
    expect(text).toContain('Ember Ward');
    expect(text).toContain('Mothkin');
    expect(bundle.format).toBe('solo-dm-campaign');
    expect(bundle.version).toBe(1);
    for (const packField of ['entries', 'records', 'bookFingerprint']) expect(Object.keys(bundle)).not.toContain(packField);
    expect(bundle.character?.features.filter((f) => f.ref?.textCopied).every((f) => f.ref?.redacted === true)).toBe(true);
    // The frozen system prompt keeps the names; its wrapped feature text became the placeholder.
    const prompt = bundle.sessions.find((s) => s.id === 'sess-e2e')?.systemPrompt ?? '';
    expect(prompt).toContain('**Ember Ward**');
    expect(prompt).toContain(placeholder);
    // The DM's level_up input that echoed Ember Ward's text was replaced in the copy.
    const levelUpInput = bundle.transcript
      .flatMap((m) => (m.param.role === 'assistant' && Array.isArray(m.param.content) ? m.param.content : []))
      .find((b) => b.type === 'tool_use' && b.name === 'level_up');
    expect(levelUpInput).toMatchObject({ input: { new_features: [{ name: 'Ember Ward', description: placeholder }] } });
    expect(report.books).toEqual([GLOAMWOOD_TITLE]);
    expect(report.passages).toBeGreaterThanOrEqual(5);
    // Rule 1: the stored transcript and character still hold the text (only the export copy changed).
    const stored = await db.transcript.where('sessionId').equals('sess-e2e').toArray();
    expect(JSON.stringify(stored)).toContain(GLOAMWOOD_MARKERS[0]);
    const character = await db.characters.get(run.campaign?.characterId as string);
    expect(character?.features.find((f) => f.name === 'Ember Ward')?.description).toContain(GLOAMWOOD_MARKERS[0]);
  });

  it('11. on another device the sheet shows placeholders; importing the same book back restores the text silently', async () => {
    useGame.getState().unloadCampaign();
    await whenPersisted();
    await resetDatabase();
    resetRulesIndex();
    const bundle = parseCampaignBundle(run.bundleText as string);
    const campaign = await importCampaignBundle(bundle, 'replace');
    await useGame.getState().loadCampaign(campaign.id);
    const pulled = useGame.getState().character as Character;
    expect(pulled.features.find((f) => f.name === 'Ember Ward')?.description).toBe(importedPlaceholder(GLOAMWOOD_TITLE));
    expect(characterSheetText(pulled)).toContain(`text from the player's book “${GLOAMWOOD_TITLE}” isn't on this device`);
    const missing = await useGame.getState().restoreImportedText();
    expect(missing?.missing.length).toBeGreaterThanOrEqual(5);

    const before = { character: (await db.characters.get(pulled.id))?.updatedAt, campaign: (await db.campaigns.get(campaign.id))?.updatedAt };
    // What a GitHub pull records once it has written the campaign.
    const target = syncTargetKey('player', 'saves', 'main', 'solo-dm');
    saveTargetState(target, { campaigns: { [campaign.id]: { remoteSha: 'sha-1', localUpdatedAt: before.campaign as number, syncedAt: 1 } }, remoteMeta: {} });
    const again = await importLibraryDocument({ title: GLOAMWOOD_TITLE, format: 'markdown', text: GLOAMWOOD_MIXED });
    expect(again.id).not.toBe(run.sourceId);
    invalidateRulesIndex();
    expect((await buildLibraryLookup()).sourcesByFingerprint.size).toBe(1);
    const report = await useGame.getState().restoreImportedText();
    expect(report?.restored).toBe(run.originals.size);
    await whenPersisted();
    const restored = (await db.characters.get(pulled.id)) as Character;
    for (const [name, text] of run.originals) expect(restored.features.find((f) => f.name === name)?.description, name).toBe(text);
    expect(restored.updatedAt).toBe(before.character);
    const campaignRow = await db.campaigns.get(campaign.id);
    expect(campaignRow?.updatedAt).toBe(before.campaign);
    // GitHub sync sees nothing to push: with the stored entry, neither side changed.
    const last = loadTargetState(target).campaigns[campaign.id];
    expect(decideSync(campaignRow, { sha: 'sha-1', updatedAt: bundle.campaign.updatedAt }, last)).toBe('skip');
  });

  it('12. "Download book data" moves the book to a fresh device: records pending, the accepted ones offered', async () => {
    useGame.getState().unloadCampaign();
    await whenPersisted();
    await resetDatabase();
    resetRulesIndex();
    const file = run.bookData as PackFileV1;
    const pack = parsePack(file, { sourceId: 'moved', sourceName: GLOAMWOOD_TITLE });
    expect(pack.issues).toEqual([]);
    expect(pack.records.every((r) => r.status === 'pending')).toBe(true);
    expect(pack.reviewedElsewhere).toBe(run.acceptedCount);
    const now = Date.now();
    await saveLibrarySourceWithRecords(
      { id: 'moved', kind: 'import', enabled: true, entryCount: pack.entries.length, createdAt: now, updatedAt: now, ...pack.source },
      pack.entries,
      pack.records,
    );
    expect((await db.library.get('moved'))?.fingerprint).toBe(file.bookFingerprint);
    const elsewhere = pack.records.filter((r: StructuredRecord) => r.reviewedElsewhere).map((r) => r.id);
    const accepted = await acceptRecords(elsewhere);
    expect(accepted.skipped).toEqual([]);
    await settleRefresh();
    const builder = await loadBuilderData();
    expect(builder.classes.find((c) => c.id === 'srd:class:fighter')?.subclasses.map((s) => s.name)).toContain('Ember Warden');
  });
});
