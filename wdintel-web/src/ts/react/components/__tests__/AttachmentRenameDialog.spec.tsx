/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AttachmentRenameDialog } from '../AttachmentRenameDialog';

describe('AttachmentRenameDialog', () => {
  afterEach(() => document.body.replaceChildren());

  it('keeps a pending attachment rename open when saving fails #3595', async () => {
    const onRename = vi.fn().mockRejectedValue(new Error('rename failed'));
    const onClose = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <AttachmentRenameDialog
          open
          fileName="pending.png"
          onClose={onClose}
          onRename={onRename}
        />,
      );
    });

    await act(async () => {
      Array.from(document.querySelectorAll('button'))
        .find((button) => button.textContent === 'Перейменувати')
        ?.click();
      await Promise.resolve();
    });

    expect(onRename).toHaveBeenCalledWith('pending.png');
    expect(onClose).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('rename failed');
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => root.unmount());
  });
});
