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
    expect(container?.textContent?.match(/C:\\duplicate\.log/g)).toHaveLength(2);
    expect(container?.querySelector('[aria-description="Контент файлу відсутній"]')).not.toBeNull();

    const directoryButton = Array.from(container?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent === 'nested',
    );
    act(() => directoryButton?.click());
    expect(onOpenDirectory).toHaveBeenCalledWith(DIRECTORY_ID);
    act(() => {
      container
        ?.querySelector<HTMLButtonElement>(`[data-entry-id="${firstFile.entryId}"] button`)
        ?.click();
    });
    expect(onSelectFile).toHaveBeenCalledWith(firstFile);
  });
});
