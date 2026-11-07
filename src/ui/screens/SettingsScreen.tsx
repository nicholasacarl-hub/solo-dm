/** Route: #/settings — everything stored in this browser: API key, DM, appearance, saves, cloud saves. */
import { useLocation } from 'react-router';
import { Cloud, HardDrive, KeyRound, Palette, Sparkles, TriangleAlert, WandSparkles } from 'lucide-react';
import { ErrorBoundary } from '@/ui/components/ErrorBoundary';
import { Page, PageHeader, useDocumentTitle } from '@/ui/shell/Page';
import { ApiKeySettings } from '@/ui/shell/settings/ApiKeySettings';
import { AppearanceSettings, DemoSettings } from '@/ui/shell/settings/AppearanceSettings';
import { DangerZone } from '@/ui/shell/settings/DangerZone';
import { DmSettings } from '@/ui/shell/settings/DmSettings';
import { GithubSettings } from '@/ui/shell/settings/GithubSettings';
import { SettingsSection } from '@/ui/shell/settings/SettingsSection';
import { StorageSettings } from '@/ui/shell/settings/StorageSettings';

function wantsKeyFocus(state: unknown): boolean {
  return typeof state === 'object' && state !== null && (state as { focus?: unknown }).focus === 'api-key';
}

export function SettingsScreen() {
  useDocumentTitle('Settings');
  const location = useLocation();
  return (
    <Page width="narrow">
      <PageHeader title="Settings" description="Saved in this browser only. Changes apply right away." />
      <div className="flex flex-col gap-6">
        <SettingsSection id="api-key" title="Claude API key" icon={KeyRound}>
          <ApiKeySettings autoFocus={wantsKeyFocus(location.state)} />
        </SettingsSection>
        <SettingsSection id="dm" title="Your DM" icon={WandSparkles} description="Which Claude model runs the table, and how.">
          <DmSettings />
        </SettingsSection>
        <SettingsSection id="appearance" title="Appearance" icon={Palette}>
          <AppearanceSettings />
        </SettingsSection>
        <SettingsSection id="demo" title="Demo mode" icon={Sparkles}>
          <DemoSettings />
        </SettingsSection>
        <SettingsSection id="storage" title="Saves on this device" icon={HardDrive}>
          <StorageSettings />
        </SettingsSection>
        <SettingsSection id="github" title="Cloud saves on GitHub" icon={Cloud}>
          <ErrorBoundary label="Cloud saves">
            <GithubSettings />
          </ErrorBoundary>
        </SettingsSection>
        <SettingsSection id="danger" title="Danger zone" icon={TriangleAlert} tone="danger">
          <DangerZone />
        </SettingsSection>
      </div>
    </Page>
  );
}
