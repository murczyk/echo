/**
 * @vitest-environment happy-dom
 */
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../workers/worker-client.ts', () => ({
  runWorkerTask: vi.fn(),
  WorkerTaskTimeoutError: class WorkerTaskTimeoutError extends Error {},
}));
vi.mock('../../xlsx/XlsxGrid.tsx', () => ({
  XlsxGrid: ({ rows }: { rows: string[][] }) => <div data-xlsx-grid>{rows[0]?.[0]}</div>,
}));
vi.mock('../../xlsx/XlsxSheetTabs.tsx', () => ({
  XlsxSheetTabs: ({ sheetNames }: { sheetNames: string[] }) => (
    <div data-xlsx-tabs>{sheetNames.join(',')}</div>
  ),
}));

import { runWorkerTask } from '../../workers/worker-client.ts';
import { LegacyOfficeDocumentPreview } from '../LegacyOfficeDocumentPreview.tsx';

describe('LegacyOfficeDocumentPreview', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('renders validated DOC DTOs with semantic paragraphs, lists, and tables', async () => {
    vi.mocked(runWorkerTask).mockResolvedValueOnce({
      truncated: false,
      blocks: [
        { type: 'paragraph', text: 'Абзац' },
        {
          type: 'list',
          ordered: true,
          items: [
            { level: 0, marker: '5.', text: 'Пункт' },
            { level: 0, marker: 'B)', text: 'Літера' },
            { level: 1, marker: '•', text: 'Вкладений пункт' },
          ],
        },
        { type: 'table', rows: [[{ text: 'Перший рядок\nДругий рядок' }]] },
      ],
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(new ArrayBuffer(8), { headers: { 'content-length': '8' } }),
    );
    const container = document.createElement('div');
    const root = createRoot(container);
    document.body.appendChild(container);

    await act(async () => {
      root.render(<LegacyOfficeDocumentPreview href="/document.doc" zoom={100} kind="doc" />);
    });

    expect(container.querySelector('p')?.textContent).toBe('Абзац');
    expect(container.querySelector('ol')?.classList.contains('list-none')).toBe(true);
    expect(container.querySelector('ol li span')?.textContent).toBe('5.');
    expect(container.querySelectorAll('ol > li span')[1]?.textContent).toBe('B)');
    expect(container.querySelector('ol > li:last-child ol li span')?.textContent).toBe('•');
    expect(container.querySelector('table td')?.textContent).toBe('Перший рядок\nДругий рядок');
    expect(container.querySelector('table td')?.classList.contains('whitespace-pre-line')).toBe(
      true,
    );
    expect(container.querySelector('article')?.getAttribute('tabindex')).toBe('0');
    expect(
      container.querySelector('table')?.parentElement?.classList.contains('overflow-auto'),
    ).toBe(true);
    root.unmount();
  });

  it('uses the existing grid and sheet tabs for XLS DTOs', async () => {
    vi.mocked(runWorkerTask).mockResolvedValueOnce({
      truncated: false,
      sheets: [
        { name: 'Перший', rows: [['A1']], rowCount: 1, columnCount: 1, truncated: false },
        { name: 'Другий', rows: [['B1']], rowCount: 1, columnCount: 1, truncated: false },
      ],
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(new ArrayBuffer(8), { headers: { 'content-length': '8' } }),
    );
    const container = document.createElement('div');
    const root = createRoot(container);
    document.body.appendChild(container);

    await act(async () => {
      root.render(<LegacyOfficeDocumentPreview href="/workbook.xls" zoom={100} kind="xls" />);
    });

    expect(container.querySelector('[data-xlsx-grid]')?.textContent).toBe('A1');
    expect(container.querySelector('[data-xlsx-tabs]')?.textContent).toBe('Перший,Другий');
    root.unmount();
  });
});
