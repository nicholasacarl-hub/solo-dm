/** Settings: the player's Anthropic API key (show/hide, test, remember). */
import { useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { CheckCircle2, ExternalLink, Loader2, TriangleAlert } from 'lucide-react';
import { useSettings } from '@/state/settingsStore';
import { Button, Field, Switch } from '@/ui/components/ui';
import { SecretInput } from '@/ui/components/SecretInput';
import { errorMessage } from '../format';
import { StatusLine } from './SettingsSection';

type KeyTest = { status: 'idle' } | { status: 'testing' } | { status: 'ok' } | { status: 'error'; message: string };

export const ANTHROPIC_KEYS_URL = 'https://console.anthropic.com/settings/keys';

/** Load the DM module only when needed: it pulls in the Anthropic SDK. */
async function checkKey(apiKey: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const { testApiKey } = await import('@/dm');
  return testApiKey(apiKey);
}

export function ApiKeySettings({ autoFocus = false }: { autoFocus?: boolean }) {
  const { apiKey, rememberApiKey, mockMode, setApiKey, clearApiKey, update } = useSettings(
    useShallow((s) => ({
      apiKey: s.apiKey,
      rememberApiKey: s.rememberApiKey,
      mockMode: s.mockMode,
      setApiKey: s.setApiKey,
      clearApiKey: s.clearApiKey,
      update: s.update,
    })),
  );
  const [draft, setDraft] = useState(apiKey);
  const [syncedKey, setSyncedKey] = useState(apiKey);
  const [test, setTest] = useState<KeyTest>({ status: 'idle' });
  const testRun = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Follow outside changes (reset, removal) without fighting the player's own typing.
  if (apiKey !== syncedKey) {
    setSyncedKey(apiKey);
    if (apiKey !== draft.trim()) setDraft(apiKey);
  }

  useEffect(() => {
    if (!autoFocus) return;
    inputRef.current?.focus({ preventScroll: true });
    inputRef.current?.scrollIntoView({ block: 'center' });
  }, [autoFocus]);

  const onInput = (value: string) => {
    testRun.current++;
    setDraft(value);
    setApiKey(value);
    setTest({ status: 'idle' });
  };

  const runTest = async () => {
    const key = draft.trim();
    if (!key) return;
    const run = ++testRun.current;
    setTest({ status: 'testing' });
    let next: KeyTest;
    try {
      const result = await checkKey(key);
      next = result.ok ? { status: 'ok' } : { status: 'error', message: result.error };
    } catch (error) {
      next = { status: 'error', message: errorMessage(error, 'Could not reach Anthropic.') };
    }
    if (run === testRun.current) setTest(next);
  };

  const trimmed = draft.trim();
  const looksOdd = trimmed !== '' && !trimmed.startsWith('sk-ant-');

  return (
    <>
      <Field label="Anthropic API key" htmlFor="settings-api-key">
        <div className="flex gap-2">
          <div className="min-w-0 flex-1">
            <SecretInput
              ref={inputRef}
              id="settings-api-key"
              noun="key"
              value={draft}
              placeholder="sk-ant-…"
              onChange={(e) => onInput(e.target.value)}
            />
          </div>
          <Button onClick={() => void runTest()} loading={test.status === 'testing'} disabled={!trimmed}>
            Test
          </Button>
        </div>
        <div role="status" aria-live="polite">
          {test.status === 'testing' && (
            <StatusLine tone="muted" icon={<Loader2 className="size-4 animate-spin" aria-hidden />}>
              Checking your key with Anthropic…
            </StatusLine>
          )}
          {test.status === 'ok' && (
            <StatusLine tone="success" icon={<CheckCircle2 className="size-4" aria-hidden />}>
              {mockMode ? 'Your key works.' : 'Your key works. You’re ready to play.'}
            </StatusLine>
          )}
          {test.status === 'ok' && mockMode && (
            <div className="mt-2 flex flex-wrap items-center gap-2 rounded-xl bg-gold-soft px-3 py-2 text-sm text-text">
              <span className="min-w-0 flex-1">The offline demo DM is still on, so Claude won’t be used yet.</span>
              <Button size="sm" variant="primary" onClick={() => update({ mockMode: false })}>
                Turn off the demo and play with Claude
              </Button>
            </div>
          )}
          {test.status === 'error' && (
            <StatusLine tone="danger" icon={<TriangleAlert className="size-4" aria-hidden />}>
              {test.message}
            </StatusLine>
          )}
          {test.status === 'idle' && looksOdd && (
            <StatusLine tone="gold" icon={<TriangleAlert className="size-4" aria-hidden />}>
              Anthropic API keys usually start with “sk-ant-”.
            </StatusLine>
          )}
        </div>
      </Field>

      <Switch
        checked={rememberApiKey}
        onChange={(remember) => update({ rememberApiKey: remember })}
        label="Remember on this device"
        description="Off: the key is kept only until you close this tab."
      />

      <div className="flex flex-col gap-2.5 rounded-xl bg-surface-2 px-4 py-3.5 text-sm text-muted">
        <a
          href={ANTHROPIC_KEYS_URL}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex w-fit items-center gap-1.5 font-medium text-accent underline-offset-2 hover:underline"
        >
          Create a key in the Anthropic Console
          <ExternalLink className="size-3.5" aria-hidden />
        </a>
        <p>API usage is billed by Anthropic, separately from any Claude subscription.</p>
        <p>Your key stays in this browser and is sent only to Anthropic’s API.</p>
        <p>Tip: set a monthly spend limit in the Console so a long campaign never surprises you.</p>
      </div>

      {apiKey && (
        <div>
          <Button variant="ghost" size="sm" onClick={clearApiKey}>
            Remove key from this browser
          </Button>
        </div>
      )}
    </>
  );
}
