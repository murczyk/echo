/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from 'react';
import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Palitra } from '../../../../../Bindings';
import type { PalitraRowView } from '../types';
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
});
