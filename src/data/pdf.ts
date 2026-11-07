/**
 * PDF text extraction with pdf.js (loaded on demand: importers use `await import('./pdf')`).
 * Only the text layer is read; scanned PDFs without one should be imported as photos instead.
 * Nothing leaves the browser.
 */
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import type { TextItem, TextMarkedContent } from 'pdfjs-dist/types/src/display/api';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { pdfPagesToMarkdown, type PdfTextRun } from './pdfLayout';
import { abortError, throwIfAborted } from './text';

GlobalWorkerOptions.workerSrc = workerUrl;

function isTextItem(item: TextItem | TextMarkedContent): item is TextItem {
  return typeof (item as TextItem).str === 'string';
}

function toRun(item: TextItem): PdfTextRun {
  const [a, b, c, d, x, y] = item.transform as number[];
  // Vertical scale of the text matrix = font size; fall back to the item height.
  const fontSize = Math.hypot(c, d) || Math.hypot(a, b) || item.height;
  return { str: item.str, x, y, width: item.width, fontSize, hasEOL: item.hasEOL };
}

/** Extract a PDF's text as Markdown (headings inferred from font sizes, else one section per page). */
export async function extractPdfMarkdown(
  file: Blob,
  opts: { signal?: AbortSignal; onPage?: (done: number, total: number) => void } = {},
): Promise<string> {
  throwIfAborted(opts.signal);
  const data = new Uint8Array(await file.arrayBuffer());
  const task = getDocument({ data, stopAtErrors: false });
  const onAbort = () => void task.destroy();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const doc = await task.promise;
    const pages: PdfTextRun[][] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      if (opts.signal?.aborted) throw abortError();
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      pages.push(content.items.filter(isTextItem).map(toRun));
      page.cleanup();
      opts.onPage?.(n, doc.numPages);
    }
    return pdfPagesToMarkdown(pages);
  } catch (err) {
    if (opts.signal?.aborted) throw abortError();
    if (err instanceof Error && err.name === 'PasswordException') throw new Error('This PDF is password-protected.', { cause: err });
    if (err instanceof Error && err.name === 'InvalidPDFException') throw new Error("This file isn't a valid PDF.", { cause: err });
    throw err;
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
    void task.destroy();
  }
}
