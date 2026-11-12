import { useId } from 'react';
import { Dices } from 'lucide-react';
import { cryptoRng } from '@/engine';
import type { Personality } from '@/types';
import { Button, Field, Input, Select, Textarea } from '@/ui/components/ui';
import { dmSheetLengthHint } from '@/ui/sheet/sheetChanges';
import { StepHeader, SubHeading } from '../BuilderParts';
import { ALIGNMENTS, defaultPortrait, suggestName } from '../flavor';
import { picks } from '../logic';
import { PortraitPicker } from '../PortraitPicker';
import type { StepProps } from './stepTypes';

export const PERSONALITY_FIELDS: { key: keyof Personality; label: string; placeholder: string }[] = [
  { key: 'traits', label: 'Personality traits', placeholder: 'How do others see you?' },
  { key: 'ideals', label: 'Ideals', placeholder: 'What do you believe in?' },
  { key: 'bonds', label: 'Bonds', placeholder: 'Who or what do you care about?' },
  { key: 'flaws', label: 'Flaws', placeholder: 'What gets you into trouble?' },
  { key: 'appearance', label: 'Appearance', placeholder: 'What stands out about you?' },
];

export interface DetailsValue {
  name: string;
  pronouns: string;
  alignment: string;
  portrait: string;
  personality: Personality;
}

/** The details form, shared by the builder and the light edit mode. */
export function DetailsFields({
  value,
  onChange,
  speciesName,
  nameError,
}: {
  value: DetailsValue;
  onChange: (patch: Partial<DetailsValue>) => void;
  speciesName?: string;
  nameError?: string;
}) {
  const ids = { name: useId(), pronouns: useId(), alignment: useId(), backstory: useId() };
  const personalityId = useId();
  const setPersonality = (key: keyof Personality, text: string) => onChange({ personality: { ...value.personality, [key]: text } });
  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Name" htmlFor={ids.name} error={nameError} hint="Required">
          <div className="flex gap-2">
            <Input
              id={ids.name}
              value={value.name}
              required
              aria-required
              aria-invalid={Boolean(nameError)}
              onChange={(e) => onChange({ name: e.target.value })}
              placeholder="What do they call you?"
              autoComplete="off"
            />
            <Button variant="secondary" onClick={() => onChange({ name: suggestName(speciesName, cryptoRng) })} title="Suggest a name" aria-label="Suggest a name">
              <Dices className="size-4" aria-hidden />
            </Button>
          </div>
        </Field>
        <Field label="Pronouns" htmlFor={ids.pronouns} hint="Optional">
          <Input id={ids.pronouns} value={value.pronouns} onChange={(e) => onChange({ pronouns: e.target.value })} placeholder="she/her, he/him, they/them…" />
        </Field>
        <Field label="Alignment" htmlFor={ids.alignment} hint="Optional — a compass, not a cage">
          <Select id={ids.alignment} value={value.alignment} onChange={(e) => onChange({ alignment: e.target.value })}>
            <option value="">Unspecified</option>
            {ALIGNMENTS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="flex flex-col gap-2">
        <SubHeading>Portrait</SubHeading>
        <PortraitPicker value={value.portrait || defaultPortrait(speciesName)} onChange={(portrait) => onChange({ portrait })} />
      </div>
      <div className="flex flex-col gap-2">
        <SubHeading>Personality</SubHeading>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {PERSONALITY_FIELDS.map((f) => (
            <Field key={f.key} label={f.label} htmlFor={`${personalityId}-${f.key}`} hint={dmSheetLengthHint(value.personality[f.key])}>
              <Textarea
                id={`${personalityId}-${f.key}`}
                rows={2}
                value={value.personality[f.key] ?? ''}
                placeholder={f.placeholder}
                onChange={(e) => setPersonality(f.key, e.target.value)}
                className="min-h-0"
              />
            </Field>
          ))}
        </div>
      </div>
      <Field
        label="Backstory"
        htmlFor={ids.backstory}
        hint={dmSheetLengthHint(value.personality.backstory) ?? 'As long or short as you like — the DM reads all of it and weaves it into the story.'}
      >
        <Textarea id={ids.backstory} rows={5} value={value.personality.backstory ?? ''} onChange={(e) => setPersonality('backstory', e.target.value)} />
      </Field>
    </div>
  );
}

export function DetailsStep({ draft, setDraft, ctx, onDmDecide }: StepProps) {
  const { species } = picks(draft, ctx.data);
  return (
    <div className="flex flex-col gap-5">
      <StepHeader
        title="Details"
        description="Name your hero and sketch who they are. Leave anything blank and the DM will fill it in as the story unfolds."
        onDmDecide={onDmDecide}
        dmLabel="Let the DM fill the gaps"
      />
      <DetailsFields
        value={draft}
        speciesName={species?.name}
        onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))}
      />
    </div>
  );
}
