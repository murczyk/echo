/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DeviceFileTreeEntry } from '../../../../../Bindings';
import { DeviceFileEntries } from './DeviceFileEntries';

const ROOT_ID = '018f0000-0000-7000-8000-000000000001';
const DIRECTORY_ID = '018f0000-0000-7000-8000-000000000002';
const NOW = '2026-07-24T08:00:00Z';

function buildEntry(entryId: string, kind: 'directory' | 'file'): DeviceFileTreeEntry {
  return {
    entryId,
    parentEntryId: ROOT_ID,
    kind,
    fileId: kind === 'file' ? `${entryId}-file` : null,
    name: kind === 'file' ? 'duplicate.log' : 'nested',
    pathComponents: [kind === 'file' ? 'duplicate.log' : 'nested'],
    pathSyntax: kind === 'file' ? 'posix' : null,
    absolutePath: kind === 'file' ? '/duplicate.log' : null,
    mimeType: kind === 'file' ? 'text/plain' : null,
    extension: kind === 'file' ? 'log' : null,
    fileMetadataCreatedAt: null,
    fileMetadataModifiedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('DeviceFileEntries', () => {
  it('renders duplicate paths as separate ID-keyed rows and navigates by entry ID', () => {
    const onOpenDirectory = vi.fn();
    const onSyncFile = vi.fn();
    const directory = buildEntry(DIRECTORY_ID, 'directory');
    const firstFile = buildEntry('018f0000-0000-7000-8000-000000000010', 'file');
    const secondFile = buildEntry('018f0000-0000-7000-8000-000000000011', 'file');

    act(() => {
      root?.render(
        <DeviceFileEntries
          breadcrumbs={[
            { entryId: ROOT_ID, name: '/' },
            { entryId: DIRECTORY_ID, name: 'nested' },
          ]}
          entries={[directory, firstFile, secondFile]}
          mode="browse"
          loading={false}
          refreshing={false}
          loadingMore={false}
          nextCursor={null}
          error={null}
          loadMoreError={null}
          canSync
          onOpenDirectory={onOpenDirectory}
          onSyncFile={onSyncFile}
          onRetry={vi.fn()}
          onLoadMore={vi.fn()}
        />,
      );
    });

    expect(container?.querySelectorAll('[data-entry-id]')).toHaveLength(3);
    expect(container?.textContent?.match(/\/duplicate\.log/g)).toHaveLength(2);

    const directoryButton = Array.from(container?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent === 'nested',
    );
    act(() => directoryButton?.click());
    expect(onOpenDirectory).toHaveBeenCalledWith(DIRECTORY_ID);

    const rootBreadcrumb = Array.from(container?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent === '/',
    );
    act(() => rootBreadcrumb?.click());
    expect(onOpenDirectory).toHaveBeenCalledWith(ROOT_ID);

    const syncButton = container?.querySelector(
      'button[aria-label="Синхронізувати метадані duplicate.log"]',
    );
    act(() => syncButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onSyncFile).toHaveBeenCalledWith(firstFile);
  });

  it('renders a local empty search state without a retry action', () => {
    act(() => {
      root?.render(
        <DeviceFileEntries
          breadcrumbs={[]}
          entries={[]}
          mode="search"
          loading={false}
          refreshing={false}
          loadingMore={false}
          nextCursor={null}
          error={null}
          loadMoreError={null}
          canSync={false}
          onOpenDirectory={vi.fn()}
          onSyncFile={vi.fn()}
          onRetry={vi.fn()}
          onLoadMore={vi.fn()}
        />,
      );
    });

    expect(container?.textContent).toContain('За заданими фільтрами нічого не знайдено.');
    expect(container?.textContent).not.toContain('Повторити');
  });
});
