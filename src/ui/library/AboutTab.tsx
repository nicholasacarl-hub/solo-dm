/** Library › About: SRD 5.2.1 attribution (verbatim), license, modifications and credits. */
import { Fragment, type ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';
import { SRD_ATTRIBUTION } from '@/data';
import { Card, SectionTitle } from '@/ui/components/ui';
import { plural } from '@/ui/shell/format';
import { manifestEntryCount, useSrdManifest } from './useSrdManifest';

const CC_BY_URL = 'https://creativecommons.org/licenses/by/4.0/';
const URL_PATTERN = /https?:\/\/[^\s"]+[^\s".,;:)]/g;

/** Render text verbatim, turning bare URLs into links (trailing punctuation stays text). */
export function Linkified({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0;
    parts.push(text.slice(last, start));
    parts.push(
      <a key={start} href={match[0]} target="_blank" rel="noreferrer noopener" className="text-accent underline underline-offset-2 [overflow-wrap:anywhere]">
        {match[0]}
      </a>,
    );
    last = start + match[0].length;
  }
  parts.push(text.slice(last));
  return (
    <>
      {parts.map((part, i) => (
        <Fragment key={i}>{part}</Fragment>
      ))}
    </>
  );
}

function ExtLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex items-center gap-1 text-accent underline underline-offset-2"
    >
      {children}
      <ExternalLink className="size-3" aria-hidden />
    </a>
  );
}

export function AboutTab() {
  const manifest = useSrdManifest();
  const total = manifestEntryCount(manifest);
  return (
    <div className="grid max-w-3xl grid-cols-1 gap-5">
      <Card className="p-5 sm:p-6">
        <SectionTitle>Rules content</SectionTitle>
        <p className="text-sm">
          Solo DM is <strong>compatible with fifth edition</strong>. Its bundled rules come from the System Reference
          Document 5.2.1, used under the <ExtLink href={CC_BY_URL}>Creative Commons Attribution 4.0 (CC-BY 4.0)</ExtLink>{' '}
          license.
        </p>
        <blockquote className="mt-4 border-l-2 border-accent pl-4 font-serif text-[0.95rem] leading-relaxed text-text">
          <Linkified text={SRD_ATTRIBUTION} />
        </blockquote>
        <p className="mt-4 text-sm text-muted">
          <span className="font-medium text-text">Modifications.</span> The SRD 5.2.1 text was converted to JSON and
          split into entries (one per rules section, spell, creature, item, class, species, background and feat), with
          short one-line summaries added.
        </p>
        {manifest && (
          <div className="mt-4 text-xs text-muted">
            <p>
              Bundled data: SRD {manifest.version}
              {total ? `, ${plural(total, 'entry', 'entries')}` : ''}, generated {manifest.generatedAt}. Converted from
              these CC-BY-4.0 sources:
            </p>
            <ul className="mt-1.5 flex flex-col gap-1">
              {manifest.sources.map((source) => (
                <li key={source.url}>
                  <ExtLink href={source.url}>{source.name}</ExtLink>{' '}
                  <span className="font-mono text-muted">@{source.commit.slice(0, 7)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      <Card className="p-5 sm:p-6">
        <SectionTitle>Unofficial</SectionTitle>
        <p className="text-sm text-muted">
          Solo DM is an unofficial fan project. It is not affiliated with, endorsed, sponsored or approved by Wizards of
          the Coast.
        </p>
      </Card>

      <Card className="p-5 sm:p-6">
        <SectionTitle>Your content</SectionTitle>
        <p className="text-sm text-muted">
          Books and notes you import stay in this browser on your device. They are never added to Solo DM itself, and
          exported save files leave them out. Only import content you own.
        </p>
      </Card>

      <Card className="p-5 sm:p-6">
        <SectionTitle>Credits</SectionTitle>
        <ul className="flex flex-col gap-1.5 text-sm text-muted">
          <li>
            Fonts: <ExtLink href="https://rsms.me/inter/">Inter</ExtLink>,{' '}
            <ExtLink href="https://github.com/productiontype/Spectral">Spectral</ExtLink> and{' '}
            <ExtLink href="https://github.com/NDISCOVER/Cinzel">Cinzel</ExtLink>, SIL Open Font License 1.1.
          </li>
          <li>
            Icons: <ExtLink href="https://lucide.dev">Lucide</ExtLink>, ISC License.
          </li>
          <li>Solo DM’s own code is MIT-licensed. The DM is Claude, by Anthropic, using your API key.</li>
        </ul>
      </Card>
    </div>
  );
}
