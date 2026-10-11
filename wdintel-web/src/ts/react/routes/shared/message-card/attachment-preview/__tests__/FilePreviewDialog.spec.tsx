/** @vitest-environment happy-dom */
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FilePreviewDialog } from '../FilePreviewDialog';

let container: HTMLDivElement;
let root: Root;
function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Переглянути</button>
      <FilePreviewDialog open={open} title="notes.txt" onClose={() => setOpen(false)}>
        <p data-testid="viewer">Вміст файлу</p>
      </FilePreviewDialog>
    </>
  );
}
beforeEach(async () => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Harness />));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

// Regression boundary: specs/002-device-file-formats/contracts/ui.md.
describe('neutral file preview dialog', () => {
  it('keeps a closed heavy viewer unmounted', () => {
    expect(document.querySelector('[data-testid="viewer"]')).toBeNull();
  });
  it('closes on Escape and restores focus to the opener', async () => {
    const opener = container.querySelector('button')!;
    opener.focus();
    await act(async () => opener.click());
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('notes.txt');
    expect(document.querySelector('[data-testid="viewer"]')).not.toBeNull();
    await act(async () =>
      dialog?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
