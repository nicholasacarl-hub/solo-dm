/**
 * Light edit mode for an existing character: name, pronouns, alignment, portrait and personality.
 * Rules choices are changed on the sheet or by the DM; "Rebuild from scratch" (after a warning)
 * replaces the character with a new level 1 build.
 */
import { useState } from 'react';
import { Link } from 'react-router';
import { RotateCcw, Save } from 'lucide-react';
import type { Character, Personality } from '@/types';
import { Button, Card, Dialog } from '@/ui/components/ui';
import { Portrait, classSummary } from '@/ui/sheet/SheetHeader';
import { useSheetEdit, type SheetChange } from '@/ui/sheet/useSheetActions';
import { DetailsFields, type DetailsValue } from './steps/DetailsStep';

const PERSONALITY_KEYS: (keyof Personality)[] = ['traits', 'ideals', 'bonds', 'flaws', 'appearance', 'backstory'];

function clean(text: string | undefined): string | undefined {
  const t = text?.trim();
  return t ? t : undefined;
}

/** Apply edited details; the notice lists what changed. */
export function detailsChange(c: Character, value: DetailsValue): SheetChange {
  const changed: string[] = [];
  const name = value.name.trim();
  if (name && name !== c.name) changed.push(`name ${c.name} → ${name}`);
  if ((clean(value.pronouns) ?? '') !== (c.pronouns ?? '')) changed.push(`pronouns ${clean(value.pronouns) ?? 'none'}`);
  if ((clean(value.alignment) ?? '') !== (c.alignment ?? '')) changed.push(`alignment ${clean(value.alignment) ?? 'unspecified'}`);
  if (value.portrait && value.portrait !== c.portrait) changed.push('portrait');
  const personality: Personality = {};
  for (const key of PERSONALITY_KEYS) {
    const text = clean(value.personality[key]);
    if (text) personality[key] = text;
    if ((text ?? '') !== (c.personality[key] ?? '')) changed.push(key === 'traits' ? 'personality traits' : key);
  }
  if (!changed.length) return { character: c, notice: null };
  return {
    character: {
      ...c,
      name: name || c.name,
      pronouns: clean(value.pronouns),
      alignment: clean(value.alignment),
      portrait: value.portrait || c.portrait,
      personality,
    },
    notice: `Player edited their character details: ${changed.join(', ')}`,
  };
}

export function EditCharacterDetails({
  character,
  campaignId,
  onSaved,
  onRebuild,
}: {
  character: Character;
  campaignId: string;
  onSaved: () => void;
  onRebuild: () => void;
}) {
  const edit = useSheetEdit();
  const [value, setValue] = useState<DetailsValue>(() => ({
    name: character.name,
    pronouns: character.pronouns ?? '',
    alignment: character.alignment ?? '',
    portrait: character.portrait ?? '',
    personality: { ...character.personality },
  }));
  const [nameError, setNameError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const speciesName = character.species.split(' (')[0];

  const save = async () => {
    if (!value.name.trim()) {
      setNameError('Your character needs a name.');
      return;
    }
    setSaving(true);
    const saved = await edit((c) => detailsChange(c, value));
    setSaving(false);
    if (saved) onSaved();
  };

  return (
    <div className="flex flex-col gap-6">
      <Card className="flex items-center gap-3 p-4">
        <Portrait portrait={value.portrait || character.portrait} size="lg" />
        <div className="min-w-0 flex-1">
          <p className="truncate font-display text-lg font-semibold">{value.name || character.name}</p>
          <p className="text-sm text-muted">{[character.species, character.background, classSummary(character)].filter(Boolean).join(' · ')}</p>
        </div>
        <Link to={`/play/${campaignId}`} className="hidden text-sm text-accent underline-offset-2 hover:underline sm:inline">
          Back to the table
        </Link>
      </Card>
      <p className="text-sm text-muted">
        Classes, ability scores, gear and spells change through play — on your character sheet or with the DM. Here you can polish who your hero is.
      </p>
      <DetailsFields
        value={value}
        speciesName={speciesName}
        nameError={nameError}
        onChange={(patch) => {
          setValue((v) => ({ ...v, ...patch }));
          if (patch.name?.trim()) setNameError(undefined);
        }}
      />
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Link to={`/play/${campaignId}`} className="rounded-xl px-4 py-2 text-sm text-muted hover:bg-surface-2 hover:text-text">
          Cancel
        </Link>
        <Button variant="primary" loading={saving} icon={<Save className="size-4" aria-hidden />} onClick={() => void save()}>
          Save details
        </Button>
      </div>
      <Card className="flex flex-col gap-3 border-danger/40 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="font-medium">Rebuild from scratch</p>
          <p className="text-sm text-muted">Start over with a new level 1 character for this campaign. The story, journal and quests stay.</p>
        </div>
        <Button variant="danger" icon={<RotateCcw className="size-4" aria-hidden />} onClick={() => setConfirming(true)} className="self-start sm:self-auto">
          Rebuild…
        </Button>
      </Card>
      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        size="sm"
        title={`Rebuild ${character.name}?`}
        description="Your current class, ability scores, gear, spells and level are replaced when you save the new build. This can't be undone (export a backup first if you might want them back)."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Keep my character
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirming(false);
                onRebuild();
              }}
            >
              Rebuild from scratch
            </Button>
          </>
        }
      />
    </div>
  );
}
