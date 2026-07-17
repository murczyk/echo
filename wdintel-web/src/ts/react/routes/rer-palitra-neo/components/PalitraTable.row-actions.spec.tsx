/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from 'react';
import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Palitra } from '../../../../../Bindings';
import type { PalitraRowView } from '../types';
import { renderPalitraTableRowActions } from './PalitraTable.row-actions';

vi.mock('@mui/material', () => ({
  Box: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  CircularProgress: () => <span>loading</span>,
  Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

vi.mock('@mui/icons-material/ArchiveOutlined', () => ({ default: () => <span>archive</span> }));
vi.mock('@mui/icons-material/ChevronRight', () => ({ default: () => <span>chevron</span> }));
vi.mock('@mui/icons-material/CloudUpload', () => ({ default: () => <span>upload</span> }));
vi.mock('@mui/icons-material/Delete', () => ({ default: () => <span>delete</span> }));
vi.mock('@mui/icons-material/Download', () => ({ default: () => <span>download</span> }));
vi.mock('@mui/icons-material/DriveFileMoveOutlined', () => ({ default: () => <span>move</span> }));
vi.mock('@mui/icons-material/Edit', () => ({ default: () => <span>edit</span> }));
vi.mock('@mui/icons-material/ExpandMore', () => ({ default: () => <span>expand</span> }));
vi.mock('@mui/icons-material/History', () => ({ default: () => <span>history</span> }));
vi.mock('@mui/icons-material/Replay', () => ({ default: () => <span>replay</span> }));
vi.mock('@mui/icons-material/VisibilityOutlined', () => ({ default: () => <span>preview</span> }));
vi.mock('@mui/icons-material/UnarchiveOutlined', () => ({ default: () => <span>unarchive</span> }));

vi.mock('../../../components/PowerIconButton', () => ({
  PowerIconButton: ({ children, onClick, disabled, 'aria-label': ariaLabel }: any) => (
    <button type="button" aria-label={ariaLabel} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
}));

vi.mock('../../../components/MrtRowActionButton', () => ({
  MrtRowActionButton: ({ label, disabled, onClick }: any) => (
    <button
      type="button"
      data-label={label}
      data-disabled={disabled === true ? 'true' : 'false'}
      disabled={disabled}
      onClick={onClick}
    >
      {label}
    </button>
  ),
  MrtRowActions: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

let root: Root | null = null;

function makePalitra(overrides: Partial<Palitra> = {}): Palitra {
  return {
    id: 10,
    name: 'GOI Palette',
    folder: null,
    isArchived: false,
    colorHex: '#00bcd4',
    author: 'operator',
    sourceFileName: 'source.gpx',
    lastUploadedAtTs: 1,
    conversionStatus: 'error',
    sourceFormat: 'gpx',
    conversionError: null,
    missingInGoi: false,
    importedFromGoi: true,
    goiOwned: false,
    goiSourceRefreshRetryAvailable: true,
    latestChangelogWarning: true,
    changelog: [
      {
        isOk: false,
        timestamp: '2026-07-17T12:00:00Z',
        text: 'conversion failed',
        description: 'Не вдалося сконвертувати файл ГОІ.',
      },
    ],
    accessLogins: [],
    accessOrganismIds: [],
    accessAorId: [],
    ...overrides,
  } as Palitra;
}

function makeRow(palitra: Palitra, canModify = true): PalitraRowView {
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
    canModify,
    canSelect: true,
    archiveInFlight: false,
    deleteInFlight: false,
    downloadInFlight: false,
    uploadInFlight: false,
    retryInFlight: false,
  };
}

function renderActions(row: PalitraRowView, overrides: Record<string, unknown> = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const props = {
    row,
    loading: false,
    bulkDeleteInFlight: false,
    externalBusy: false,
    onOpenEdit: vi.fn(),
    onRequestArchive: vi.fn(),
    onRequestAssignFolder: vi.fn(),
    onRequestUnarchive: vi.fn(),
    onDownload: vi.fn(),
    onRequestPreview: vi.fn(),
    onRequestUploadPoints: vi.fn(),
    onRetryConversion: vi.fn(),
    onRetryGoiSourceConversion: vi.fn(),
    onOpenHistory: vi.fn(),
    onDelete: vi.fn(),
    onToggleFolderExpanded: vi.fn(),
    onRequestRenameFolder: vi.fn(),
    onRequestArchiveFolder: vi.fn(),
    onRequestDeleteFolder: vi.fn(),
    ...overrides,
  };

  act(() => {
    root?.render(createElement(() => renderPalitraTableRowActions(props as never)));
  });

  return { container, props };
}

afterEach(() => {
  root?.unmount();
  root = null;
  document.body.innerHTML = '';
});

describe('PalitraTable row actions', () => {
  it('shows history and GOI source retry while hiding generic conversion retry', () => {
    const onRetryGoiSourceConversion = vi.fn();
    const onOpenHistory = vi.fn();
    const palitra = makePalitra();
    const { container } = renderActions(makeRow(palitra), {
      onRetryGoiSourceConversion,
      onOpenHistory,
    });
    const labels = Array.from(container.querySelectorAll('button[data-label]')).map((button) =>
      button.getAttribute('data-label'),
    );

    expect(labels).toContain('Історія');
    expect(labels).toContain('Повторити оновлення з ГОІ');
    expect(labels).not.toContain('Повторити конвертацію');

    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-label="Повторити оновлення з ГОІ"]')
        ?.click();
      container.querySelector<HTMLButtonElement>('[data-label="Історія"]')?.click();
    });

    expect(onRetryGoiSourceConversion).toHaveBeenCalledWith(palitra);
    expect(onOpenHistory).toHaveBeenCalledWith(palitra);
  });

  it('disables Echo-side edit actions for GOI-owned rows', () => {
    const { container } = renderActions(makeRow(makePalitra({ goiOwned: true }), false));

    expect(
      container.querySelector<HTMLButtonElement>('[data-label="Редагувати"]')?.dataset.disabled,
    ).toBe('true');
    expect(
      container.querySelector<HTMLButtonElement>('[data-label="Додати точки"]')?.dataset.disabled,
    ).toBe('true');
  });
});
