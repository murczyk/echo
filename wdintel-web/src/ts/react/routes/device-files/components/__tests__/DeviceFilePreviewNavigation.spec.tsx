/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { DeviceFilesState } from '../../use-device-files';
import { getDeviceFilePreviewNavigation } from '../DeviceFilePreviewNavigation';
import { MessageCardAttachmentPreviewHeader } from '../../../shared/message-card/attachment-preview/MessageCardAttachmentPreviewHeader';

it('#3930 navigates sibling files without selecting directories and returns to the retained folder', () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const selectFile = vi.fn();
  const clearSelectedFile = vi.fn();
  const first = { entryId: 'first', kind: 'file', name: 'first.pdf' };
  const second = { entryId: 'second', kind: 'file', name: 'second.pdf' };
  const files = {
    selectedFile: first,
    directory: {
      entries: [
        first,
        { entryId: 'folder', kind: 'directory' },
        { entryId: 'zip', kind: 'file', isArchive: true, archive: { state: 'ready' } },
        second,
      ],
    },
    selectFile,
    clearSelectedFile,
    favoritePending: new Set(),
    toggleFavorite: vi.fn(),
  } as unknown as DeviceFilesState;
  try {
    act(() =>
      root.render(
        <MessageCardAttachmentPreviewHeader
          navigation={getDeviceFilePreviewNavigation(files)}
          onClose={clearSelectedFile}
          closeLabel="До папки"
        />,
      ),
    );
    expect(
      container.querySelector<HTMLButtonElement>('button[aria-label="Попереднє"]')?.disabled,
    ).toBe(true);
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Наступне"]')!.click());
    expect(selectFile).toHaveBeenCalledWith(second);
    act(() =>
      root.render(
        <MessageCardAttachmentPreviewHeader
          navigation={getDeviceFilePreviewNavigation({
            ...files,
            selectedFile: second,
          } as DeviceFilesState)}
          onClose={clearSelectedFile}
          closeLabel="До папки"
        />,
      ),
    );
    expect(
      container.querySelector<HTMLButtonElement>('button[aria-label="Наступне"]')?.disabled,
    ).toBe(true);
    const back = container.querySelector<HTMLButtonElement>('button[aria-label="До папки"]')!;
    act(() => back.click());
    expect(clearSelectedFile).toHaveBeenCalledTimes(1);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
