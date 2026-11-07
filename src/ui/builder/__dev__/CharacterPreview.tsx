/**
 * DEV ONLY: preview the character builder and sheet with fixture data and an in-memory game store,
 * independent of storage and the DM. Opened through ./preview.html (never part of the app build):
 *
 *   /src/ui/builder/__dev__/preview.html?preview=sheet      (also: builder, edit, shortrest, levelup)
 *   &theme=light   &step=abilities   &dm=1 (let the DM build everything)   &class=Fighter
 */
import { useEffect, useState } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { applyTheme } from '@/state/settingsStore';
import { useGame } from '@/state/gameStore';
import { sampleCampaign, sampleCharacter } from '@/test/fixtures';
import type { BuilderData, Character, LogEntry } from '@/types';
import { Toaster, toast } from '@/ui/components/toast';
import { Button, Card } from '@/ui/components/ui';
import { CharacterSheet } from '@/ui/sheet/CharacterSheet';
import { LevelUpDialog } from '@/ui/sheet/LevelUpDialog';
import { ShortRestDialog } from '@/ui/sheet/ShortRestDialog';
import { Page, PageHeader } from '@/ui/shell/Page';
import { letDmBuildAll } from '../autofill';
import { CharacterBuilder } from '../CharacterBuilder';
import { EditCharacterDetails } from '../EditCharacterDetails';
import { spellInfo } from '../spells';
import { builderFixture, spellFixture } from '../testing/builderFixture';
import { emptyDraft, BUILDER_STEPS, type BuilderStep } from '../types';
import { writeDraft } from '../useBuilderDraft';

const params = new URLSearchParams(window.location.search);
const view = params.get('preview') ?? 'sheet';

/** Replace the store's persistence-backed actions with in-memory ones. */
function seedStore(character: Character | null) {
  const campaign = sampleCampaign({ characterId: character?.id ?? null, status: character ? 'active' : 'setup' });
  let seq = 0;
  useGame.setState({
    campaignId: campaign.id,
    campaign,
    character,
    loading: false,
    loadError: null,
    log: [],
    pendingDmNotices: [],
    loadCampaign: async () => undefined,
    updateCampaign: async (patch) => {
      const current = useGame.getState().campaign!;
      const next = typeof patch === 'function' ? patch(current) : { ...current, ...patch };
      useGame.setState({ campaign: next });
      return next;
    },
    setCharacter: async (c) => {
      useGame.setState({ character: c });
      toast.success(`Saved ${c.name}`);
      console.info('[preview] setCharacter', c);
    },
    updateCharacter: async (fn) => {
      const next = fn(useGame.getState().character!);
      useGame.setState({ character: next });
      return next;
    },
    queueDmNotice: (text) => {
      console.info('[preview] DM notice:', text);
      useGame.setState({ pendingDmNotices: [...useGame.getState().pendingDmNotices, text] });
    },
    appendLog: async (entry) => {
      const full = { ...entry, id: `log-${++seq}`, campaignId: campaign.id, sessionId: null, seq, createdAt: Date.now() } as LogEntry;
      console.info('[preview] log', full);
      useGame.setState({ log: [...useGame.getState().log, full] });
      return full;
    },
  });
}

async function loadData(): Promise<BuilderData> {
  try {
    const res = await fetch('/srd/builder.json');
    if (res.ok) return (await res.json()) as BuilderData;
  } catch {
    // fall back to the fixture
  }
  return builderFixture();
}

function Notices() {
  const notices = useGame((s) => s.pendingDmNotices);
  if (!notices.length) return null;
  return (
    <Card className="p-3 text-xs">
      <p className="mb-1 font-semibold">DM notices queued</p>
      <ol className="list-decimal pl-4 text-muted">
        {notices.map((n, i) => (
          <li key={i}>{n}</li>
        ))}
      </ol>
    </Card>
  );
}

function SheetPreview() {
  const character = useGame((s) => s.character);
  const [resting, setResting] = useState(false);
  const [leveling, setLeveling] = useState(false);
  if (!character) return null;
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 p-4 lg:flex-row lg:items-start">
      <aside className="w-full shrink-0 rounded-2xl border border-border bg-surface p-4 lg:w-[360px]">
        <CharacterSheet character={character} editable />
      </aside>
      <div className="hidden min-w-0 flex-1 flex-col gap-4 lg:flex">
        <Card className="p-4">
          <CharacterSheet character={character} variant="compact" />
        </Card>
        <div className="flex gap-2">
          <Button onClick={() => setResting(true)}>Short rest dialog</Button>
          <Button onClick={() => setLeveling(true)}>Level up dialog</Button>
        </div>
        <Notices />
      </div>
      {resting && (
        <ShortRestDialog
          request={{ kind: 'short-rest', id: 'r', hitDice: character.hitDice, conMod: 1 }}
          onDone={(r) => {
            console.info('[preview] short rest', r);
            setResting(false);
          }}
          onCancel={() => setResting(false)}
        />
      )}
      <LevelUpDialog open={leveling} onClose={() => setLeveling(false)} />
    </div>
  );
}

function BuilderPreview() {
  const campaign = useGame((s) => s.campaign);
  const [data, setData] = useState<BuilderData | null>(null);
  const spells = spellFixture().map(spellInfo);
  useEffect(() => {
    void loadData().then((d) => {
      const step = params.get('step') as BuilderStep | null;
      let draft = { ...emptyDraft(), ...(step && BUILDER_STEPS.includes(step) ? { step } : {}) };
      const className = params.get('class');
      const cls = d.classes.find((c) => c.name === className);
      if (cls) draft = { ...draft, classId: cls.id };
      if (params.get('dm') === '1') draft = { ...letDmBuildAll(draft, { data: d, spells }), ...(step ? { step } : {}) };
      writeDraft(campaignIdFor(), draft);
      setData(d);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!data || !campaign) return null;
  return (
    <Page>
      <PageHeader title="Create your hero" description={`For ${campaign.name}. Fifth-edition 2024 rules (SRD 5.2.1) — every choice can be left to the DM.`} />
      <CharacterBuilder campaign={campaign} data={data} spells={{ spells, loading: false, error: null }} onSave={async (c) => useGame.getState().setCharacter(c)} />
    </Page>
  );
}

function campaignIdFor(): string {
  return useGame.getState().campaign?.id ?? 'camp-1';
}

function EditPreview() {
  const character = useGame((s) => s.character);
  if (!character) return null;
  return (
    <Page width="narrow">
      <PageHeader title={`Edit ${character.name}`} />
      <EditCharacterDetails character={character} campaignId="camp-1" onSaved={() => toast.success('Saved')} onRebuild={() => toast.info('Rebuild')} />
      <div className="mt-4">
        <Notices />
      </div>
    </Page>
  );
}

function Preview() {
  switch (view) {
    case 'builder':
      return <BuilderPreview />;
    case 'edit':
      return <EditPreview />;
    case 'shortrest':
      return <ShortRestDialog request={{ kind: 'short-rest', id: 'r', hitDice: [{ die: 6, total: 3, spent: 1 }, { die: 10, total: 1, spent: 0 }], conMod: 1 }} onDone={() => undefined} onCancel={() => undefined} />;
    case 'levelup':
      return <LevelUpDialog open onClose={() => undefined} />;
    default:
      return <SheetPreview />;
  }
}

export function CharacterPreviewApp() {
  const [ready, setReady] = useState(false);
  const [router] = useState(() => createMemoryRouter([{ path: '*', element: <Preview /> }]));
  useEffect(() => {
    applyTheme(params.get('theme') === 'light' ? 'light' : 'dark');
    seedStore(view === 'builder' ? null : sampleCharacter());
    setReady(true);
  }, []);
  if (!ready) return null;
  return (
    <div className="min-h-dvh bg-bg text-text">
      <RouterProvider router={router} />
      <Toaster />
    </div>
  );
}
