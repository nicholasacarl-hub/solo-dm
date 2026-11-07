/** View, edit, retire/restore or delete one homebrew entry — or write a new one (origin 'player'). */
import { useId, useState } from 'react';
import { HOMEBREW_SOURCE_ID, CONTENT_KINDS, type ContentKind, type HomebrewEntry } from '@/types';
import { newId } from '@/lib/id';
import { Badge, Button, Dialog, Field, Input, Select, Textarea } from '@/ui/components/ui';
import { Markdown } from '@/ui/components/Markdown';
import { SegmentedField } from '@/ui/components/OptionCards';
import { toast } from '@/ui/components/toast';
import { errorMessage } from '@/ui/shell/format';
import { deleteHomebrewEntry, saveHomebrewEntry } from './homebrewActions';
import { kindInfo } from './kinds';

export interface CampaignOption {
  id: string;
  name: string;
}

interface Draft {
  kind: ContentKind;
  name: string;
  summary: string;
  text: string;
  balanceNotes: string;
  campaignId: string | null;
}

const SHARED = '__shared__';

function draftFrom(entry: HomebrewEntry | null, defaultCampaignId: string | null): Draft {
  return {
    kind: entry?.kind ?? 'spell',
    name: entry?.name ?? '',
    summary: entry?.summary ?? '',
    text: entry?.text ?? '',
    balanceNotes: entry?.balanceNotes ?? '',
    campaignId: entry ? entry.campaignId : defaultCampaignId,
  };
}

/** Build the entry to save from the form (pure; exported for tests). */
export function homebrewFromDraft(draft: Draft, existing: HomebrewEntry | null, now = Date.now()): HomebrewEntry {
  const fields = {
    kind: draft.kind,
    name: draft.name.trim(),
    summary: draft.summary.trim() || undefined,
    text: draft.text.trim(),
    balanceNotes: draft.balanceNotes.trim() || undefined,
    campaignId: draft.campaignId,
    updatedAt: now,
  };
  if (existing) return { ...existing, ...fields };
  return {
    id: `hb:${newId()}`,
    sourceId: HOMEBREW_SOURCE_ID,
    sourceName: 'Homebrew',
    origin: 'player',
    status: 'active',
    createdAt: now,
    ...fields,
  };
}

export function HomebrewDialog({
  open,
  entry,
  campaigns,
  campaignName,
  defaultCampaignId = null,
  onClose,
}: {
  open: boolean;
  /** null = write a new entry. */
  entry: HomebrewEntry | null;
  campaigns: CampaignOption[];
  campaignName: (id: string | null) => string;
  defaultCampaignId?: string | null;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<'view' | 'edit'>(entry ? 'view' : 'edit');
  const [draft, setDraft] = useState<Draft>(() => draftFrom(entry, defaultCampaignId));
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: () => Promise<void>, success: string) => {
    setBusy(true);
    try {
      await action();
      toast.success(success);
      return true;
    } catch (err) {
      toast.error(errorMessage(err, 'Could not save the homebrew.'));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!draft.name.trim()) return setError('Give it a name.');
    if (!draft.text.trim()) return setError('Describe what it does.');
    setError(null);
    const next = homebrewFromDraft(draft, entry);
    const ok = await run(() => saveHomebrewEntry(next, entry ? 'edited' : 'created', entry), `Saved “${next.name}”.`);
    if (ok) onClose();
  };

  const setStatus = async (status: HomebrewEntry['status']) => {
    if (!entry) return;
    const next = { ...entry, status, updatedAt: Date.now() };
    const ok = await run(
      () => saveHomebrewEntry(next, status === 'retired' ? 'retired' : 'restored', entry),
      status === 'retired' ? `Retired “${entry.name}”.` : `Restored “${entry.name}”.`,
    );
    if (ok) onClose();
  };

  const remove = async () => {
    if (!entry) return;
    const ok = await run(() => deleteHomebrewEntry(entry), `Deleted “${entry.name}”.`);
    if (ok) onClose();
  };

  const viewing = mode === 'view' && entry !== null;
  const title = viewing ? entry.name : entry ? `Edit “${entry.name}”` : 'New homebrew';
  const description = viewing
    ? `${kindInfo(entry.kind).label} · ${entry.origin === 'dm' ? 'Created by the DM' : 'Written by you'} · ${campaignName(entry.campaignId)}`
    : 'Your DM can use it in the campaigns you choose. Markdown is supported.';

  let footer;
  if (viewing && confirmDelete) {
    footer = (
      <>
        <p className="mr-auto self-center text-sm text-danger">Delete it for good?</p>
        <Button variant="ghost" disabled={busy} onClick={() => setConfirmDelete(false)}>
          Keep it
        </Button>
        <Button variant="danger" loading={busy} onClick={() => void remove()}>
          Delete
        </Button>
      </>
    );
  } else if (viewing) {
    footer = (
      <>
        <Button variant="ghost" className="mr-auto" disabled={busy} onClick={() => setConfirmDelete(true)}>
          Delete
        </Button>
        <Button disabled={busy} onClick={() => void setStatus(entry.status === 'retired' ? 'active' : 'retired')}>
          {entry.status === 'retired' ? 'Restore' : 'Retire'}
        </Button>
        <Button variant="arcane" disabled={busy} onClick={() => setMode('edit')}>
          Edit
        </Button>
      </>
    );
  } else {
    footer = (
      <>
        <Button variant="ghost" disabled={busy} onClick={() => (entry ? setMode('view') : onClose())}>
          Cancel
        </Button>
        <Button variant="arcane" loading={busy} onClick={() => void save()}>
          Save
        </Button>
      </>
    );
  }

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!busy) onClose();
      }}
      dismissible={!busy}
      size="lg"
      title={title}
      description={description}
      footer={footer}
    >
      {viewing ? (
        <HomebrewView entry={entry} />
      ) : (
        <HomebrewForm draft={draft} onChange={setDraft} campaigns={campaigns} error={error} onSubmit={() => void save()} />
      )}
    </Dialog>
  );
}

function HomebrewView({ entry }: { entry: HomebrewEntry }) {
  return (
    <div className="flex flex-col gap-4">
      {entry.status === 'retired' && (
        <p className="rounded-xl bg-surface-2 px-3 py-2 text-sm text-muted">
          Retired: the DM won’t use this. Restore it to bring it back.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="arcane">Homebrew</Badge>
        {entry.basedOn && (
          <span className="text-xs text-muted">
            Based on <span className="font-medium text-text">{entry.basedOn.name}</span>
          </span>
        )}
      </div>
      {entry.summary && <p className="text-sm text-muted italic">{entry.summary}</p>}
      <Markdown>{entry.text}</Markdown>
      {entry.balanceNotes && (
        <div className="rounded-xl border border-arcane/25 bg-arcane-soft/40 px-4 py-3">
          <p className="text-xs font-semibold text-arcane">Balance notes</p>
          <Markdown className="mt-1">{entry.balanceNotes}</Markdown>
        </div>
      )}
    </div>
  );
}

function HomebrewForm({
  draft,
  onChange,
  campaigns,
  error,
  onSubmit,
}: {
  draft: Draft;
  onChange: (draft: Draft) => void;
  campaigns: CampaignOption[];
  error: string | null;
  onSubmit: () => void;
}) {
  const id = useId();
  const [tab, setTab] = useState<'write' | 'preview'>('write');
  const patch = (p: Partial<Draft>) => onChange({ ...draft, ...p });
  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_12rem]">
        <Field label="Name" htmlFor={`${id}-name`}>
          <Input
            id={`${id}-name`}
            value={draft.name}
            maxLength={120}
            placeholder="Ember Lance"
            onChange={(e) => patch({ name: e.target.value })}
          />
        </Field>
        <Field label="Kind" htmlFor={`${id}-kind`}>
          <Select id={`${id}-kind`} value={draft.kind} onChange={(e) => patch({ kind: e.target.value as ContentKind })}>
            {CONTENT_KINDS.map((k) => (
              <option key={k} value={k}>
                {kindInfo(k).label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label="Summary" htmlFor={`${id}-summary`} hint="One line, e.g. “Level 2 Evocation (Wizard)”.">
        <Input
          id={`${id}-summary`}
          value={draft.summary}
          maxLength={200}
          onChange={(e) => patch({ summary: e.target.value })}
        />
      </Field>
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <label htmlFor={`${id}-text`} className="text-sm font-medium">
            Rules text
          </label>
          <SegmentedField
            legend={<span className="sr-only">Editor view</span>}
            value={tab}
            options={[
              { value: 'write', label: 'Write' },
              { value: 'preview', label: 'Preview' },
            ]}
            onChange={setTab}
            className="[&>div]:mt-0"
          />
        </div>
        {tab === 'write' ? (
          <Textarea
            id={`${id}-text`}
            rows={9}
            value={draft.text}
            onChange={(e) => patch({ text: e.target.value })}
            placeholder={'*Level 2 Evocation*\n\n**Casting Time:** Action\n\nA lance of ember light…'}
          />
        ) : (
          <div className="min-h-40 rounded-xl border border-border bg-surface-2 px-3 py-2">
            {draft.text.trim() ? <Markdown>{draft.text}</Markdown> : <p className="text-sm text-muted">Nothing to preview yet.</p>}
          </div>
        )}
      </div>
      <Field label="Balance notes" htmlFor={`${id}-balance`} hint="How it compares to official options of the same level or rarity.">
        <Textarea
          id={`${id}-balance`}
          rows={3}
          value={draft.balanceNotes}
          onChange={(e) => patch({ balanceNotes: e.target.value })}
        />
      </Field>
      <Field label="Campaign" htmlFor={`${id}-campaign`} hint="Shared homebrew is available in every campaign.">
        <Select
          id={`${id}-campaign`}
          value={draft.campaignId ?? SHARED}
          onChange={(e) => patch({ campaignId: e.target.value === SHARED ? null : e.target.value })}
        >
          <option value={SHARED}>All campaigns (shared)</option>
          {campaigns.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </Field>
      {error && (
        <p role="alert" className="rounded-xl bg-danger-soft/60 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
      <button type="submit" hidden />
    </form>
  );
}
