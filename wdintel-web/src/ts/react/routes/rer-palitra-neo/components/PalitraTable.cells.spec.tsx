/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from 'react';
import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Palitra } from '../../../../../Bindings';
import type { FolderTableRowView, PalitraRowView } from '../types';
import { buildPalitraTableColumns } from './PalitraTable.cells';

vi.mock('@mui/material', () => ({
  Box: ({ children, component = 'div', ...props }: any) => {
    const Component = component;
    return <Component {...props}>{children}</Component>;
  },
  Stack: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Tooltip: ({ title, children }: { title?: ReactNode; children?: ReactNode }) => (
    <span data-tooltip-title={String(title ?? '')}>{children}</span>
  ),
  Typography: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));

vi.mock('@mui/icons-material/FolderOutlined', () => ({ default: () => <span>folder</span> }));
vi.mock('@mui/icons-material/WarningAmber', () => ({
  default: ({ color }: { color?: string }) => <span data-testid={`warning-${color}`}>warning</span>,
}));

vi.mock('../../../components/PowerChip', () => ({
  PowerChip: ({ label }: { label: ReactNode }) => <span>{label}</span>,
}));

vi.mock('../../../components/mui-customized/table/custom-styles', () => ({
  FULL_HEIGHT_LOADING_ROW_COUNT: 8,
}));

let root: Root | null = null;

function makePalitra(overrides: Partial<Palitra> = {}): Palitra {
  return {
    id: 7,
    name: 'Warning Palette',
    folder: null,
    isArchived: false,
    colorHex: '#00bcd4',
    author: 'operator',
    sourceFileName: 'source.gpx',
    lastUploadedAtTs: 1,
    conversionStatus: 'ready',
    sourceFormat: 'gpx',
    conversionError: null,
    missingInGoi: false,
    importedFromGoi: true,
    goiOwned: true,
    goiSourceRefreshRetryAvailable: true,
    latestChangelogWarning: true,
    changelog: [
      {
        isOk: false,
        timestamp: '2026-07-17T12:00:00Z',
        text: 'GOI source conversion failed',
        description: 'Конвертація файлу ГОІ не вдалася.',
      },
    ],
    accessLogins: [],
    accessOrganismIds: [],
    accessAorId: [],
    ...overrides,
  } as Palitra;
}

function makeRow(palitra: Palitra): PalitraRowView {
  return {
    id: palitra.id,
    kind: 'palitra',
    palitra,
    hiddenByCollapsedFolder: false,
    name: palitra.name,
    depth: 0,
    colorHex: palitra.colorHex,
    sourceFileName: palitra.sourceFileName,
    lastUploadedAtTs: palitra.lastUploadedAtTs,
    author: palitra.author,
    accessSummary: '—',
    canModify: false,
    canRetryGoiSourceConversion: false,
    canSelect: true,
    archiveInFlight: false,
    deleteInFlight: false,
    downloadInFlight: false,
    uploadInFlight: false,
    retryInFlight: false,
  };
}

function makeFolderRow(): FolderTableRowView {
  return {
    id: 'folder',
    kind: 'folder',
    folderPath: '/long-folder',
    hiddenByCollapsedFolder: false,
    name: 'Дуже довга назва папки для перевірки переповнення',
    depth: 0,
    totalCount: 2,
    modifiableCount: 2,
    childCount: 2,
    isExpanded: false,
    canSelect: false,
    canModify: true,
    archiveInFlight: false,
    deleteInFlight: false,
    downloadInFlight: false,
    uploadInFlight: false,
    retryInFlight: false,
    colorHex: null,
    sourceFileName: null,
    lastUploadedAtTs: null,
    author: null,
    accessSummary: '—',
  };
}

function renderNameCell(row: PalitraRowView) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const nameColumn = buildPalitraTableColumns(vi.fn()).find((column) => column.id === 'name');
  const cell = nameColumn?.Cell?.({ row: { original: row } } as never);

  act(() => {
    root?.render(createElement(() => <>{cell}</>));
  });

  return container;
}

afterEach(() => {
  root?.unmount();
  root = null;
  document.body.innerHTML = '';
});

describe('PalitraTable cells', () => {
  it('renders warning indicator with latest changelog description', () => {
    const container = renderNameCell(makeRow(makePalitra()));

    expect(container.textContent).toContain('Warning Palette');
    expect(container.querySelector('[data-testid="warning-warning"]')).not.toBeNull();
    expect(
      container.querySelector('[data-tooltip-title="Конвертація файлу ГОІ не вдалася."]'),
    ).not.toBeNull();
  });

  it('does not render changelog warning when latest state is OK', () => {
    const container = renderNameCell(
      makeRow(
        makePalitra({
          latestChangelogWarning: false,
          changelog: [
            {
              isOk: true,
              timestamp: '2026-07-17T12:05:00Z',
              text: 'Recovered',
              description: 'Синхронізацію відновлено.',
            },
          ],
        }),
      ),
    );

    expect(container.querySelector('[data-testid="warning-warning"]')).toBeNull();
  });

  it('shows a GOI import error with its parsing details', () => {
    const container = renderNameCell(
      makeRow(
        makePalitra({
          conversionStatus: 'error',
          conversionError: 'invalid XML before declaration',
          goiOwned: false,
        }),
      ),
    );

    expect(container.textContent).toContain('Помилка імпорту');
    expect(
      container.querySelector('[data-tooltip-title="invalid XML before declaration"]'),
    ).not.toBeNull();
  });

  it('keeps an overflowing folder name inside its single button tab stop', () => {
    const originalClientWidth = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'clientWidth',
    );
    const originalScrollWidth = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'scrollWidth',
    );
    const onToggleFolderExpanded = vi.fn();
    const container = document.createElement('div');
    const folder = makeFolderRow();
    try {
      Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
        configurable: true,
        get: () => 80,
      });
      Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
        configurable: true,
        get: () => 240,
      });
      document.body.appendChild(container);
      root = createRoot(container);
      const nameColumn = buildPalitraTableColumns(onToggleFolderExpanded).find(
        (column) => column.id === 'name',
      );
      const cell = nameColumn?.Cell?.({ row: { original: folder } } as never);

      act(() => {
        root?.render(createElement(() => <>{cell}</>));
      });

      const button = container.querySelector<HTMLButtonElement>('button');
      const overflowText = [...(button?.querySelectorAll<HTMLElement>('span') ?? [])].find(
        (element) =>
          element.textContent === folder.name && !element.hasAttribute('data-tooltip-title'),
      );
      expect(overflowText?.scrollWidth).toBeGreaterThan(overflowText?.clientWidth ?? 0);
      expect(button).not.toBeNull();
      expect(button?.tabIndex).toBe(0);
      expect(button?.querySelector('[tabindex="0"]')).toBeNull();
      expect(button?.textContent).toContain(folder.name);
      act(() => button?.click());
      expect(onToggleFolderExpanded).toHaveBeenCalledWith(folder.folderPath);
    } finally {
      root?.unmount();
      root = null;
      container.remove();
      if (originalClientWidth)
        Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth);
      else delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
      if (originalScrollWidth)
        Object.defineProperty(HTMLElement.prototype, 'scrollWidth', originalScrollWidth);
      else delete (HTMLElement.prototype as { scrollWidth?: number }).scrollWidth;
    }
  });
});
