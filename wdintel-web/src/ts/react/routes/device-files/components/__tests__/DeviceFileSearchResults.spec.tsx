/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DeviceFileTreeEntry } from '../../../../../../Bindings';
import { DeviceFileSearchResults } from '../DeviceFileSearchResults';

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
    absolutePath: kind === 'file' ? 'C:\\duplicate.log' : null,
    hasContent: false,
    mimeType: kind === 'file' ? 'text/plain' : null,
    extension: kind === 'file' ? 'log' : null,
    contentUploadedAt: null,
    fileMetadataCreatedAt: null,
    fileMetadataModifiedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    tags: [],
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

describe('DeviceFileSearchResults', () => {
  it('#3930 #4101 disables only the file revision whose viewed marker is pending', () => {
    const first = {
      ...buildEntry('first', 'file'),
      fileId: 'source',
      revision: 1,
      isViewed: false,
    };
    const second = {
      ...buildEntry('second', 'file'),
      fileId: 'source',
      revision: 2,
      isViewed: true,
    };
    const onViewed = vi.fn();
    const render = (viewedPending: Set<string>) =>
      act(() =>
        root?.render(
          <DeviceFileSearchResults
            entries={[first, second]}
            loading={false}
            refreshing={false}
            loadingMore={false}
            nextCursor={null}
            error={null}
            loadMoreError={null}
            onOpenDirectory={vi.fn()}
            onSelectFile={vi.fn()}
            onViewed={onViewed}
            viewedPending={viewedPending}
            onRetry={vi.fn()}
            onLoadMore={vi.fn()}
          />,
        ),
      );
    render(new Set(['source/1']));
    const firstButton = container!.querySelector<HTMLButtonElement>(
      '[data-entry-id="first"] button[aria-pressed]',
    )!;
    const secondButton = container!.querySelector<HTMLButtonElement>(
      '[data-entry-id="second"] button[aria-pressed]',
    )!;
    expect(firstButton.disabled).toBe(true);
    expect(secondButton.disabled).toBe(false);
    act(() => {
      firstButton.click();
      secondButton.click();
    });
    expect(onViewed).toHaveBeenCalledExactlyOnceWith(second);
    render(new Set());
    expect(firstButton.disabled).toBe(false);
    act(() => firstButton.click());
    expect(onViewed).toHaveBeenLastCalledWith(first);
  });

  it('renders duplicate paths as separate ID-keyed rows and navigates by entry ID', () => {
    const onOpenDirectory = vi.fn();
    const onSelectFile = vi.fn();
    const directory = buildEntry(DIRECTORY_ID, 'directory');
    const firstFile = buildEntry('018f0000-0000-7000-8000-000000000010', 'file');
    const secondFile = buildEntry('018f0000-0000-7000-8000-000000000011', 'file');

    act(() => {
      root?.render(
        <DeviceFileSearchResults
          entries={[directory, firstFile, secondFile]}
          loading={false}
          refreshing={false}
          loadingMore={false}
          nextCursor={null}
          error={null}
          loadMoreError={null}
          onOpenDirectory={onOpenDirectory}
          onSelectFile={onSelectFile}
          onRetry={vi.fn()}
          onLoadMore={vi.fn()}
        />,
      );
    });

    expect(container?.querySelectorAll('[data-entry-id]')).toHaveLength(3);
    expect(container?.querySelectorAll('td[title="C:\\\\"]')).toHaveLength(2);
    expect(container?.querySelector('[aria-description="Контент файлу відсутній"]')).not.toBeNull();

    const directoryButton = Array.from(container?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent === 'nested',
    );
    act(() => directoryButton?.click());
    expect(onOpenDirectory).toHaveBeenCalledWith(DIRECTORY_ID, null);
    act(() => {
      container
        ?.querySelector<HTMLButtonElement>(`[data-entry-id="${firstFile.entryId}"] button`)
        ?.click();
    });
    expect(onSelectFile).toHaveBeenCalledWith(firstFile);
  });
});
