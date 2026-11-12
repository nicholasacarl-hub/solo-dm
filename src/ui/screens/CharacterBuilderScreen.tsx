/**
 * Route #/campaign/:id/character — build the campaign's character (2024 rules), or, when it already
 * has one, edit their details (with an explicit "Rebuild from scratch").
 */
import { useEffect } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useShallow } from 'zustand/react/shallow';
import { ArrowLeft } from 'lucide-react';
import { useBuilderData } from '@/data';
import { useGame } from '@/state/gameStore';
import type { Character } from '@/types';
import { CharacterBuilder } from '@/ui/builder/CharacterBuilder';
import { EditCharacterDetails } from '@/ui/builder/EditCharacterDetails';
import { useSpellOptions } from '@/ui/builder/useSpellOptions';
import { EmptyState, Spinner } from '@/ui/components/ui';
import { classSummary } from '@/ui/sheet/SheetHeader';
import { Page, PageHeader, useDocumentTitle } from '@/ui/shell/Page';

function Loading({ label }: { label: string }) {
  return (
    <div className="flex flex-1 items-center justify-center gap-3 px-4 py-24 text-sm text-muted">
      <Spinner label={label} />
      <span aria-hidden>{label}</span>
    </div>
  );
}

function Problem({ title, children }: { title: string; children: string }) {
  return (
    <Page width="narrow">
      <EmptyState
        title={title}
        action={
          <Link to="/" className="text-sm font-medium text-accent underline-offset-2 hover:underline">
            Back to your campaigns
          </Link>
        }
      >
        {children}
      </EmptyState>
    </Page>
  );
}

export function CharacterBuilderScreen() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();
  const rebuilding = search.get('rebuild') === '1';
  const { campaignId, campaign, character, loading, loadError } = useGame(
    useShallow((s) => ({ campaignId: s.campaignId, campaign: s.campaign, character: s.character, loading: s.loading, loadError: s.loadError })),
  );
  const builder = useBuilderData();
  const spells = useSpellOptions();
  useDocumentTitle(character && !rebuilding ? `Edit ${character.name}` : 'Create your hero');

  useEffect(() => {
    if (id && campaignId !== id) {
      useGame
        .getState()
        .loadCampaign(id)
        .catch(() => undefined); // loadError carries the message
    }
  }, [id, campaignId]);

  if (!id) return <Problem title="No campaign selected">Pick a campaign from your save slots first.</Problem>;
  if (loading || campaignId !== id) return <Loading label="Opening the campaign…" />;
  if (loadError) return <Problem title="We couldn't open this campaign">{loadError}</Problem>;
  if (!campaign) return <Problem title="Campaign not found">This campaign may have been deleted or moved to another browser.</Problem>;

  const back = (
    <Link to={character ? `/play/${id}` : '/'} className="inline-flex items-center gap-1 text-sm text-muted hover:text-text">
      <ArrowLeft className="size-4" aria-hidden /> {character ? 'Back to the table' : 'Campaigns'}
    </Link>
  );

  if (character && !rebuilding) {
    return (
      <Page width="narrow">
        <PageHeader eyebrow={back} title={`Edit ${character.name}`} description={`${campaign.name} · ${classSummary(character)}`} />
        <EditCharacterDetails
          character={character}
          campaignId={id}
          onSaved={() => navigate(`/play/${id}`)}
          onRebuild={() => setSearch({ rebuild: '1' })}
        />
      </Page>
    );
  }

  if (builder.loading) return <Loading label="Unrolling a fresh character sheet…" />;
  if (builder.error || !builder.data) {
    return <Problem title="The character builder couldn't load">{builder.error ?? 'The rules data is missing.'}</Problem>;
  }

  const save = async (built: Character) => {
    const { setCharacter, updateCampaign, queueDmNotice } = useGame.getState();
    await setCharacter(built);
    await updateCampaign({ status: 'active' });
    if (character && campaign.activeSessionId) {
      queueDmNotice(`Player rebuilt their character from scratch: ${built.name}, ${built.species} ${classSummary(built)} (level 1). Treat the new sheet as canon: get_character_sheet has it.`);
    }
    navigate(`/play/${id}`);
  };

  return (
    <Page>
      <PageHeader
        eyebrow={back}
        title={rebuilding ? 'Rebuild your hero' : 'Create your hero'}
        description={`For ${campaign.name}. Fifth-edition 2024 rules (SRD 5.2.1) — every choice can be left to the DM.`}
      />
      <CharacterBuilder campaign={campaign} data={builder.data} spells={spells} characterId={character?.id} onSave={save} />
    </Page>
  );
}
