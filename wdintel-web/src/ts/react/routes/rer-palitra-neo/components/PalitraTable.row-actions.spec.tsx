/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from 'react';
import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Palitra } from '../../../../../Bindings';
import type { FolderTableRowView, PalitraRowView } from '../types';
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
vi.mock('@mui/icons-material/VisibilityOffOutlined', () => ({
  default: () => <span>preview unavailable</span>,
}));
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
    highlightBlacklistCount: 1,
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

function makeRow(
  palitra: Palitra,
  canModify = true,
  canRetryGoiSourceConversion = true,
): PalitraRowView {
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
    canRetryGoiSourceConversion,
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
    id: 'folder:GOI',
    kind: 'folder',
    folderPath: 'GOI',
    hiddenByCollapsedFolder: false,
    name: 'GOI',
    depth: 0,
    totalCount: 1,
    modifiableCount: 1,
    childCount: 0,
    isExpanded: true,
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
    accessSummary: 'У папці: 1',
  };
}

function renderActions(
  row: PalitraRowView | FolderTableRowView,
  overrides: Record<string, unknown> = {},
) {
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
    onOpenHighlightBlacklist: vi.fn(),
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
  it('disables preview with a crossed-out icon for failed imports', () => {
    const onRequestPreview = vi.fn();
    const { container } = renderActions(makeRow(makePalitra()), { onRequestPreview });
    const previewButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Попередній перегляд недоступний"]',
    );

    expect(previewButton?.disabled).toBe(true);
    expect(previewButton?.textContent).toBe('preview unavailable');

    act(() => {
      previewButton?.click();
    });

    expect(onRequestPreview).not.toHaveBeenCalled();
  });

  it('shows a disabled crossed-out preview icon for folders', () => {
    const { container } = renderActions(makeFolderRow());
    const previewButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Попередній перегляд недоступний"]',
    );

    expect(previewButton?.disabled).toBe(true);
    expect(previewButton?.textContent).toBe('preview unavailable');
  });

  it('keeps successful palette previews active', () => {
    const onRequestPreview = vi.fn();
    const palitra = makePalitra({ conversionStatus: 'success' });
    const { container } = renderActions(makeRow(palitra), { onRequestPreview });
    const previewButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Попередній перегляд"]',
    );

    expect(previewButton?.disabled).toBe(false);
    expect(previewButton?.textContent).toBe('preview');

    act(() => {
      previewButton?.click();
    });

    expect(onRequestPreview).toHaveBeenCalledWith(palitra);
  });

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

  it('disables GOI source retry without management permission', () => {
    const onRetryGoiSourceConversion = vi.fn();
    const { container } = renderActions(makeRow(makePalitra(), true, false), {
      onRetryGoiSourceConversion,
    });
    const retryButton = container.querySelector<HTMLButtonElement>(
      '[data-label="Повторити оновлення з ГОІ"]',
    );

    expect(retryButton?.dataset.disabled).toBe('true');

    act(() => {
      retryButton?.click();
    });

    expect(onRetryGoiSourceConversion).not.toHaveBeenCalled();
  });

  it('allows GOI source retry for management users on read-only rows', () => {
    const { container } = renderActions(makeRow(makePalitra(), false, true));

    expect(
      container.querySelector<HTMLButtonElement>('[data-label="Повторити оновлення з ГОІ"]')
        ?.dataset.disabled,
    ).toBe('false');
  });

  it('shows the highlight blacklist action for accessible read-only palettes', () => {
    const onOpenHighlightBlacklist = vi.fn();
    const palitra = makePalitra({ goiOwned: true });
    const { container } = renderActions(makeRow(palitra, false), { onOpenHighlightBlacklist });
    const action = container.querySelector<HTMLButtonElement>('[data-label="Чорний список"]');

    expect(action?.dataset.disabled).toBe('false');
    act(() => action?.click());
    expect(onOpenHighlightBlacklist).toHaveBeenCalledWith(palitra);
  });

  it('hides the highlight blacklist action when the count is zero', () => {
    const { container } = renderActions(makeRow(makePalitra({ highlightBlacklistCount: 0 })));

    expect(container.querySelector('[data-label="Чорний список"]')).toBeNull();
  });

  it('hides generic conversion retry for a malformed direct GOI import', () => {
    const palitra = makePalitra({
      goiOwned: false,
      goiSourceRefreshRetryAvailable: false,
    });
    const { container } = renderActions(makeRow(palitra));

    expect(container.querySelector('[data-label="Повторити конвертацію"]')).toBeNull();
  });
});
