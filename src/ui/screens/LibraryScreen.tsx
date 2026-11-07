/**
 * Route: #/library — Browse the rules, My library (imports), Homebrew, About.
 * The tab lives in ?tab= (browse | mine | homebrew | about); ?entry=<id> deep-links an entry.
 */
import { useSearchParams } from 'react-router';
import { BookOpen, FlaskConical, Info, Library } from 'lucide-react';
import { Tabs } from '@/ui/components/ui';
import { ErrorBoundary } from '@/ui/components/ErrorBoundary';
import { AboutTab } from '@/ui/library/AboutTab';
import { BrowseTab } from '@/ui/library/BrowseTab';
import { HomebrewTab } from '@/ui/library/HomebrewTab';
import { MyLibraryTab } from '@/ui/library/MyLibraryTab';
import { Page, PageHeader, useDocumentTitle } from '@/ui/shell/Page';

export type LibraryTab = 'browse' | 'mine' | 'homebrew' | 'about';

const TABS: { value: LibraryTab; label: string; short?: string; icon: typeof BookOpen }[] = [
  { value: 'browse', label: 'Browse rules', short: 'Browse', icon: BookOpen },
  { value: 'mine', label: 'My library', icon: Library },
  { value: 'homebrew', label: 'Homebrew', icon: FlaskConical },
  { value: 'about', label: 'About', icon: Info },
];

function parseTab(value: string | null): LibraryTab {
  return TABS.find((t) => t.value === value)?.value ?? 'browse';
}

export function LibraryScreen() {
  useDocumentTitle('Library');
  const [params, setParams] = useSearchParams();
  const tab = parseTab(params.get('tab'));
  const current = TABS.find((t) => t.value === tab) ?? TABS[0];

  const selectTab = (next: LibraryTab) =>
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        p.set('tab', next);
        if (next !== 'browse') p.delete('entry');
        return p;
      },
      { replace: true },
    );

  return (
    <Page>
      <PageHeader
        title="Library"
        description="The rules your DM consults: the SRD, books you’ve imported, and homebrew from your campaigns."
      />
      <Tabs
        value={tab}
        onChange={selectTab}
        className="mb-6"
        tabs={TABS.map((t) => ({
          value: t.value,
          label: t.short ? (
            <>
              <span className="sm:hidden">{t.short}</span>
              <span className="hidden sm:inline">{t.label}</span>
            </>
          ) : (
            t.label
          ),
          icon: <t.icon className="hidden size-4 sm:block" aria-hidden />,
        }))}
      />
      <div role="tabpanel" aria-label={current.label}>
        <ErrorBoundary label={current.label} resetKeys={[tab]}>
          {tab === 'browse' && <BrowseTab />}
          {tab === 'mine' && <MyLibraryTab />}
          {tab === 'homebrew' && <HomebrewTab />}
          {tab === 'about' && <AboutTab />}
        </ErrorBoundary>
      </div>
    </Page>
  );
}
