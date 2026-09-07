/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';

import { AttachmentFileRow } from './AttachmentPickerUi';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

it('ECHO-3324 keeps a contained upload status aligned with the attachment content column', () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  act(() => {
    root?.render(
      <AttachmentFileRow
        file={{ id: 'upload', name: 'attachment.bin', size: 1024 }}
        busy
        onRemove={() => {}}
        upload={{ label: 'Завантажено, обробка…', percentage: null, color: 'primary' }}
      />,
    );
  });

  const statusRow = container.querySelector<HTMLElement>('[data-attachment-upload-status-row]');
  const status = statusRow?.querySelector<HTMLElement>('.MuiTypography-root');
  expect(statusRow).not.toBeNull();
  expect(getComputedStyle(statusRow!).paddingLeft).toBe('60px');
  expect(getComputedStyle(statusRow!).paddingRight).toBe('8px');
  expect(getComputedStyle(status!).textAlign).toBe('right');
  expect(getComputedStyle(status!).whiteSpace).toBe('nowrap');
});
