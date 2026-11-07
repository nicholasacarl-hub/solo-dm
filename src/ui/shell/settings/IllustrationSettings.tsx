/**
 * Settings: illustrations painted by OpenAI's image models with the player's own OpenAI key (show/hide,
 * test, link to the key page), when the DM may paint, which model, what quality, and where the
 * pictures are kept.
 */
import { useId, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { CheckCircle2, ExternalLink, HardDrive, Loader2, TriangleAlert } from 'lucide-react';
import { testOpenAiKey } from '@/images';
import { useSettings } from '@/state/settingsStore';
import { useCampaignList, useImageStats, type ImageStats } from '@/storage';
import { IMAGE_MODELS, type ImageFrequency, type ImageSettings } from '@/types';
import { Badge, Button, Field, Select } from '@/ui/components/ui';
import { OptionCards, type OptionCardOption } from '@/ui/components/OptionCards';
import { SecretInput } from '@/ui/components/SecretInput';
import { errorMessage, formatBytes, plural } from '../format';
import { StatusLine } from './SettingsSection';

export const OPENAI_KEYS_URL = 'https://platform.openai.com/api-keys';

type KeyTest = { status: 'idle' } | { status: 'testing' } | { status: 'ok' } | { status: 'error'; message: string };

const FREQUENCY_OPTIONS: readonly OptionCardOption<ImageFrequency>[] = [
  { value: 'off', label: 'Off', description: 'No pictures. The DM never asks for one.' },
  {
    value: 'request',
    label: 'When I ask',
    description: 'Only when you ask: “show me the harbor”, the Show me the scene button, or Paint portrait on your sheet.',
  },
  {
    value: 'moments',
    label: 'Key moments',
    description: 'The DM may also paint a new place, a big reveal or the start of a fight, at most about once a scene.',
  },
];

const QUALITY_OPTIONS: readonly OptionCardOption<ImageSettings['quality']>[] = [
  { value: 'low', label: 'Low', description: 'Quick sketches. The cheapest.' },
  {
    value: 'medium',
    label: 'Medium',
    description: 'Good detail for a few cents a picture.',
    aside: <Badge tone="accent">Recommended</Badge>,
  },
  { value: 'high', label: 'High', description: 'The finest detail, at several times the price.' },
];

/** What looks off about a key (OpenAI keys start with "sk-"; Anthropic keys with "sk-ant-"). */
function keyWarning(key: string): string | null {
  if (!key) return null;
  if (key.startsWith('sk-ant-')) return 'That looks like your Claude (Anthropic) key. Pictures need a key from OpenAI.';
  if (!key.startsWith('sk-')) return 'OpenAI API keys usually start with “sk-”.';
  return null;
}

function OpenAiKeyField() {
  const { key, frequency, rememberApiKey, setOpenAiKey, updateImages } = useSettings(
    useShallow((s) => ({
      key: s.images.openaiApiKey,
      frequency: s.images.frequency,
      rememberApiKey: s.rememberApiKey,
      setOpenAiKey: s.setOpenAiKey,
      updateImages: s.updateImages,
    })),
  );
  const [draft, setDraft] = useState(key);
  const [syncedKey, setSyncedKey] = useState(key);
  const [test, setTest] = useState<KeyTest>({ status: 'idle' });
  const testRun = useRef(0);

  // Follow outside changes (reset, removal, another tab) without fighting the player's own typing.
  if (key !== syncedKey) {
    setSyncedKey(key);
    if (key !== draft.trim()) setDraft(key);
  }

  const onInput = (value: string) => {
    testRun.current++;
    setDraft(value);
    setOpenAiKey(value);
    setTest({ status: 'idle' });
  };

  const runTest = async () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    const run = ++testRun.current;
    setTest({ status: 'testing' });
    let next: KeyTest;
    try {
      const result = await testOpenAiKey(trimmed);
      next = result.ok ? { status: 'ok' } : { status: 'error', message: result.error };
    } catch (error) {
      next = { status: 'error', message: errorMessage(error, 'Could not reach OpenAI.') };
    }
    if (run === testRun.current) setTest(next);
  };

  const trimmed = draft.trim();
  const warning = keyWarning(trimmed);

  return (
    <>
      <Field label="OpenAI API key" htmlFor="settings-openai-key">
        <div className="flex gap-2">
          <div className="min-w-0 flex-1">
            <SecretInput
              id="settings-openai-key"
              noun="OpenAI key"
              value={draft}
              placeholder="sk-…"
              onChange={(e) => onInput(e.target.value)}
            />
          </div>
          <Button onClick={() => void runTest()} loading={test.status === 'testing'} disabled={!trimmed} aria-label="Test OpenAI key">
            Test
          </Button>
        </div>
        <div role="status" aria-live="polite">
          {test.status === 'testing' && (
            <StatusLine tone="muted" icon={<Loader2 className="size-4 animate-spin" aria-hidden />}>
              Checking your key with OpenAI…
            </StatusLine>
          )}
          {test.status === 'ok' && (
            <StatusLine tone="success" icon={<CheckCircle2 className="size-4" aria-hidden />}>
              Your OpenAI key works. The DM can paint pictures.
            </StatusLine>
          )}
          {test.status === 'ok' && frequency !== 'moments' && (
            <div className="mt-2 flex flex-wrap items-center gap-2 rounded-xl bg-gold-soft px-3 py-2 text-sm text-text">
              <span className="min-w-0 flex-1">
                Let the DM illustrate key moments too: a new place, a big reveal, the start of a fight.
              </span>
              <Button size="sm" variant="primary" onClick={() => updateImages({ frequency: 'moments' })}>
                Illustrate key moments
              </Button>
            </div>
          )}
          {test.status === 'error' && (
            <StatusLine tone="danger" icon={<TriangleAlert className="size-4" aria-hidden />}>
              {test.message}
            </StatusLine>
          )}
          {test.status === 'idle' && warning && (
            <StatusLine tone="gold" icon={<TriangleAlert className="size-4" aria-hidden />}>
              {warning}
            </StatusLine>
          )}
        </div>
      </Field>

      <div className="flex flex-col gap-2.5 rounded-xl bg-surface-2 px-4 py-3.5 text-sm text-muted">
        <a
          href={OPENAI_KEYS_URL}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex w-fit items-center gap-1.5 font-medium text-accent underline-offset-2 hover:underline"
        >
          Create a key on platform.openai.com
          <ExternalLink className="size-3.5" aria-hidden />
        </a>
        <p>OpenAI bills pictures separately from Claude and from any ChatGPT subscription.</p>
        <p>Your key stays in this browser and is sent only to OpenAI’s API.</p>
        <p>
          {rememberApiKey
            ? 'Like your Claude key, it is remembered on this device (see “Remember on this device” above).'
            : 'Like your Claude key, it is kept only until you close this tab (see “Remember on this device” above).'}
        </p>
      </div>

      {key && (
        <div>
          <Button variant="ghost" size="sm" onClick={() => onInput('')}>
            Remove OpenAI key from this browser
          </Button>
        </div>
      )}
    </>
  );
}

function ModelField() {
  const id = useId();
  const { model, updateImages } = useSettings(useShallow((s) => ({ model: s.images.model, updateImages: s.updateImages })));
  const info = IMAGE_MODELS.find((m) => m.id === model);
  return (
    <Field
      label="Image model"
      htmlFor={`${id}-model`}
      hint={info ? info.blurb : 'This model isn’t one Solo DM offers. Pick one from the list if pictures fail.'}
    >
      <Select id={`${id}-model`} value={model} onChange={(e) => updateImages({ model: e.target.value })}>
        {!info && <option value={model}>{model} (custom)</option>}
        {IMAGE_MODELS.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </Select>
    </Field>
  );
}

/** How many pictures each campaign has on this device, most first. */
function PicturesByCampaign({ byCampaign }: { byCampaign: ImageStats['byCampaign'] }) {
  const summaries = useCampaignList();
  const names = new Map((summaries ?? []).map((s) => [s.campaign.id, s.campaign.name]));
  const rows = Object.entries(byCampaign).sort(([, a], [, b]) => b.count - a.count);
  return (
    <ul aria-label="Pictures by campaign" className="flex flex-col gap-0.5 pl-6 text-xs text-muted">
      {rows.map(([id, own]) => (
        <li key={id} className="[overflow-wrap:anywhere]">
          {names.get(id) ?? 'Another campaign'}: {plural(own.count, 'picture')}, {formatBytes(own.bytes)}
        </li>
      ))}
    </ul>
  );
}

function StoredPictures() {
  const stats = useImageStats();
  const campaigns = stats ? Object.keys(stats.byCampaign).length : 0;
  return (
    <div className="flex flex-col gap-1.5 text-sm">
      <StatusLine tone="muted" icon={<HardDrive className="size-4" aria-hidden />}>
        Pictures stay on this device. They aren’t included in save files or GitHub cloud saves (they’re too large), and
        deleting a campaign deletes its pictures.
      </StatusLine>
      <p className="pl-6 text-xs text-muted" aria-live="polite">
        {stats === undefined
          ? 'Counting pictures…'
          : stats.count === 0
            ? 'No pictures on this device yet.'
            : `On this device: ${plural(stats.count, 'picture')} in ${plural(campaigns, 'campaign')}, ${formatBytes(stats.bytes)}.`}
      </p>
      {stats && stats.count > 0 && <PicturesByCampaign byCampaign={stats.byCampaign} />}
    </div>
  );
}

export function IllustrationSettings() {
  const { frequency, quality, hasKey, updateImages } = useSettings(
    useShallow((s) => ({
      frequency: s.images.frequency,
      quality: s.images.quality,
      hasKey: s.images.openaiApiKey.trim() !== '',
      updateImages: s.updateImages,
    })),
  );
  return (
    <>
      <OpenAiKeyField />
      <OptionCards
        legend="When to paint"
        hint={hasKey ? 'The DM writes each picture’s description; OpenAI paints it while the story goes on.' : 'Add an OpenAI key above to turn pictures on.'}
        value={frequency}
        options={FREQUENCY_OPTIONS}
        onChange={(next) => updateImages({ frequency: next })}
      />
      <ModelField />
      <OptionCards
        legend="Quality"
        hint="Rough cost: a few cents a picture at medium, billed by OpenAI. Low costs less; high costs several times more."
        columns={3}
        value={quality}
        options={QUALITY_OPTIONS}
        onChange={(next) => updateImages({ quality: next })}
      />
      <StoredPictures />
    </>
  );
}
