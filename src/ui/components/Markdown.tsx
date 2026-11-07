/**
 * Safe markdown renderer (GitHub-flavored, no raw HTML). Use for DM narration, rules text,
 * homebrew and imported content. Links open in a new tab.
 *
 * Images never load from the network: the text is untrusted (model output, imported books, save
 * files), and a remote <img> would tell a third party the player's IP or carry campaign text away
 * in its URL. Remote images become a plain link the player can choose to open; only images embedded
 * in the text itself (data:image/ or blob: URLs) are shown.
 */
import { memo } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components, type UrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ImageIcon } from 'lucide-react';
import { cn } from '@/lib/cn';

/** An image that is part of the text itself (no request leaves the browser). */
export function isEmbeddedImageUrl(url: string): boolean {
  return /^data:image\//i.test(url) || /^blob:/i.test(url);
}

const linkClass = 'text-accent underline underline-offset-2';

/** Keep embedded image sources (the default transform drops data: and blob:); everything else as usual. */
const urlTransform: UrlTransform = (url, key, node) =>
  key === 'src' && node.tagName === 'img' && isEmbeddedImageUrl(url) ? url : defaultUrlTransform(url);

const components: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" className={linkClass} />,
  img: ({ src, alt, title }) => {
    const url = typeof src === 'string' ? src : '';
    if (isEmbeddedImageUrl(url)) return <img src={url} alt={alt ?? ''} title={title} className="max-w-full rounded-lg" />;
    const label = (
      <>
        <ImageIcon className="mr-1 inline size-[1em] align-[-0.125em]" aria-hidden />
        {alt?.trim() || 'Image'}
      </>
    );
    if (!/^https?:/i.test(url)) return <span className="text-muted">{label}</span>;
    return (
      <a href={url} title={title ?? url} target="_blank" rel="noreferrer noopener" className={linkClass}>
        {label}
      </a>
    );
  },
};

export const Markdown = memo(function Markdown({
  children,
  className,
  variant = 'prose',
}: {
  children: string;
  className?: string;
  /** 'narration' = DM story text styling; 'prose' = rules/reference text. */
  variant?: 'narration' | 'prose';
}) {
  return (
    <div
      className={cn(
        variant === 'narration'
          ? 'narration'
          : 'prose prose-sm max-w-none text-text prose-headings:font-display prose-headings:text-text prose-strong:text-text prose-a:text-accent dark:prose-invert',
        className,
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} urlTransform={urlTransform} skipHtml>
        {children}
      </ReactMarkdown>
    </div>
  );
});
