import { useEffect, useState } from 'react';
import { CircularProgress, Typography } from '@mui/material';

import { fetchCachedDocumentResponse } from '../document-preview-utils';
import { runWorkerTask, WorkerTaskTimeoutError } from '../workers/worker-client';
import {
  formatLegacyOfficePreviewError,
  LegacyOfficePreviewError,
  LegacyOfficePreviewErrorCode,
} from '../legacy-office/legacy-office-errors';
import {
  LEGACY_OFFICE_DOWNLOAD_TIMEOUT_MS,
  LEGACY_OFFICE_MAX_FILE_BYTES,
  LEGACY_OFFICE_WORKER_TIMEOUT_MS,
} from '../legacy-office/legacy-office-limits';
import {
  type DocPreviewResult,
  type XlsPreviewResult,
  validateDocPreviewResult,
  validateXlsPreviewResult,
} from '../legacy-office/legacy-office-preview.types';
import { XlsxGrid } from '../xlsx/XlsxGrid';
import { XlsxSheetTabs } from '../xlsx/XlsxSheetTabs';

type LegacyKind = 'doc' | 'xls';
type DocListItem = Extract<DocPreviewResult['blocks'][number], { type: 'list' }>['items'][number];
type DocListNode = { text: string; children: DocListNode[] };

function NestedDocList({ items, ordered }: { items: DocListItem[]; ordered: boolean }) {
  const roots: DocListNode[] = [];
  const ancestors: Array<{ level: number; children: DocListNode[] }> = [
    { level: -1, children: roots },
  ];
  for (const item of items) {
    while (true) {
      const ancestor = ancestors.at(-1);
      if (ancestor == null || ancestor.level < item.level) break;
      ancestors.pop();
    }
    const parent = ancestors.at(-1);
    if (parent == null) continue;
    const node = { text: item.text, children: [] };
    parent.children.push(node);
    ancestors.push({ level: item.level, children: node.children });
  }
  const List = ordered ? 'ol' : 'ul';
  const renderNodes = (nodes: DocListNode[]) => (
    <List>
      {nodes.map((node, index) => (
        <li key={index}>
          {node.text}
          {node.children.length > 0 ? renderNodes(node.children) : null}
        </li>
      ))}
    </List>
  );
  return renderNodes(roots);
}

export function LegacyOfficeDocumentPreview({
  href,
  zoom,
  sizeBytes,
  kind,
}: {
  href: string;
  zoom: number;
  sizeBytes?: number | null;
  kind: LegacyKind;
}) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [result, setResult] = useState<DocPreviewResult | XlsPreviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sheetIndex, setSheetIndex] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    let downloadTimedOut = false;
    const downloadTimer = window.setTimeout(() => {
      downloadTimedOut = true;
      controller.abort();
    }, LEGACY_OFFICE_DOWNLOAD_TIMEOUT_MS);
    const load = async () => {
      try {
        if (sizeBytes != null && sizeBytes > LEGACY_OFFICE_MAX_FILE_BYTES)
          throw new Error('LEGACY_OFFICE_FILE_TOO_LARGE');
        const { buffer } = await fetchCachedDocumentResponse(
          href,
          LEGACY_OFFICE_MAX_FILE_BYTES,
          'LEGACY_OFFICE_FILE_TOO_LARGE',
          controller.signal,
        );
        window.clearTimeout(downloadTimer);
        const value = await runWorkerTask<
          { buffer: ArrayBuffer },
          DocPreviewResult | XlsPreviewResult
        >(
          () =>
            kind === 'doc'
              ? new Worker(new URL('../legacy-office/doc-preview.worker.ts', import.meta.url), {
                  type: 'module',
                })
              : new Worker(new URL('../legacy-office/xls-preview.worker.ts', import.meta.url), {
                  type: 'module',
                }),
          { buffer },
          controller.signal,
          [buffer],
          LEGACY_OFFICE_WORKER_TIMEOUT_MS,
        );
        const validated =
          kind === 'doc' ? validateDocPreviewResult(value) : validateXlsPreviewResult(value);
        if (disposed) return;
        if (validated == null)
          throw new LegacyOfficePreviewError(LegacyOfficePreviewErrorCode.MalformedWorkerResponse);
        setResult(validated);
        setStatus('ready');
      } catch (caught) {
        if (disposed || (controller.signal.aborted && !downloadTimedOut)) return;
        setError(
          downloadTimedOut
            ? 'LEGACY_OFFICE_DOWNLOAD_TIMEOUT'
            : caught instanceof WorkerTaskTimeoutError
              ? LegacyOfficePreviewErrorCode.ParseTimeout
              : caught instanceof Error
                ? caught.message
                : null,
        );
        setStatus('error');
      }
    };
    setStatus('loading');
    setResult(null);
    setError(null);
    setSheetIndex(0);
    void load();
    return () => {
      disposed = true;
      window.clearTimeout(downloadTimer);
      controller.abort();
    };
  }, [href, kind, sizeBytes]);
  const extension = kind.toUpperCase() as 'DOC' | 'XLS';
  if (status === 'loading')
    return (
      <div className="grid h-full place-items-center">
        <CircularProgress size={22} />
      </div>
    );
  if (status === 'error' || result == null)
    return (
      <section className="p-6 text-center">
        <Typography variant="h6">Помилка перегляду</Typography>
        <Typography variant="body2">{formatLegacyOfficePreviewError(error, extension)}</Typography>
      </section>
    );
  if (kind === 'xls') {
    const workbook = result as XlsPreviewResult;
    const sheet = workbook.sheets[sheetIndex] ?? workbook.sheets[0];
    return (
      <div className="flex h-full min-h-0 w-full flex-col">
        {sheet ? (
          <div className="min-h-0 flex-1">
            <XlsxGrid
              rows={sheet.rows}
              zoom={zoom}
              truncated={sheet.truncated || workbook.truncated}
            />
          </div>
        ) : null}
        {workbook.sheets.length > 1 ? (
          <XlsxSheetTabs
            sheetNames={workbook.sheets.map((item) => item.name)}
            selectedIndex={sheetIndex}
            onSelectIndex={setSheetIndex}
          />
        ) : null}
      </div>
    );
  }
  const document = result as DocPreviewResult;
  return (
    <article
      className="h-full overflow-auto p-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary"
      style={{ fontSize: `${zoom}%` }}
      tabIndex={0}
      aria-label="Попередній перегляд документа"
    >
      {document.blocks.map((block, index) =>
        block.type === 'paragraph' ? (
          <p key={index}>{block.text}</p>
        ) : block.type === 'list' ? (
          <NestedDocList key={index} items={block.items} ordered={block.ordered} />
        ) : (
          <div
            key={index}
            className="my-3 max-w-full overflow-auto rounded border border-slate-300 dark:border-slate-600"
          >
            <table className="w-full min-w-max border-collapse text-sm">
              <tbody>
                {block.rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {row.map((cell, cellIndex) => (
                      <td
                        key={cellIndex}
                        className="border border-slate-300 p-2 align-top dark:border-slate-600"
                      >
                        {cell.text}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ),
      )}
      {document.truncated ? (
        <Typography role="status">
          Попередній перегляд скорочено через обмеження безпеки.
        </Typography>
      ) : null}
    </article>
  );
}
