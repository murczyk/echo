/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { listAors } from '../../services/api/aor';
import { uploadUnitAttachment } from '../../services/api/units';
import { UnitAttachmentUploader } from './UnitAttachmentUploader';

vi.mock('@mui/material', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mui/material')>();
  return {
    ...actual,
    Autocomplete: ({
      options,
      onChange,
    }: {
      options: unknown[];
      onChange: (event: unknown, value: unknown[]) => void;
    }) => (
      <button type="button" data-testid="select-aor" onClick={() => onChange({}, [options[0]])}>
        Обрати AOR
      </button>
    ),
  };
});

vi.mock('../../services/api/aor', () => ({
  listAors: vi.fn(),
}));

vi.mock('../../services/api/units', () => ({
  uploadUnitAttachment: vi.fn(),
}));

describe('UnitAttachmentUploader', () => {
  beforeEach(() => {
    vi.mocked(listAors).mockResolvedValue([
      {
        id: 4,
        name: 'AOR 4',
        description: null,
        isTopLevel: true,
        orderForReport: 1,
        leftBound: 0,
        rightBound: 1,
        leftCoordinates: null,
        rightCoordinates: null,
        createdAt: 1,
      },
    ]);
    vi.mocked(uploadUnitAttachment).mockResolvedValue({} as never);
  });

  afterEach(() => {
    vi.clearAllMocks();
    document.body.replaceChildren();
  });

  it('uploads every selected file and reports one completed batch', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onUploaded = vi.fn();
    await act(async () => {
      root.render(<UnitAttachmentUploader unitId={7} onUploaded={onUploaded} />);
    });

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const files = [
      new File(['first'], 'first.txt', { type: 'text/plain', lastModified: 1 }),
      new File(['second'], 'second.txt', { type: 'text/plain', lastModified: 2 }),
    ];
    Object.defineProperty(input, 'files', { configurable: true, value: files });
    act(() => input.dispatchEvent(new Event('change', { bubbles: true })));

    const textareas = Array.from(container.querySelectorAll('textarea')).filter(
      (textarea) => textarea.getAttribute('aria-hidden') !== 'true',
    );
    const setTextareaValue = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )?.set;
    act(() => {
      setTextareaValue?.call(textareas[0], 'Короткий опис');
      textareas[0].dispatchEvent(new Event('input', { bubbles: true }));
      setTextareaValue?.call(textareas[1], 'Повний опис');
      textareas[1].dispatchEvent(new Event('input', { bubbles: true }));
      container
        .querySelector<HTMLButtonElement>('[data-testid="select-aor"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const uploadButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Додати файли (2)'),
    );
    expect(textareas).toHaveLength(2);
    expect(uploadButton).toBeDefined();
    expect(uploadButton?.disabled).toBe(false);
    await act(async () => {
      uploadButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(uploadUnitAttachment).toHaveBeenCalledTimes(2);
    expect(uploadUnitAttachment).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ unitId: 7, file: files[0], aorIds: [4] }),
    );
    expect(uploadUnitAttachment).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ unitId: 7, file: files[1], aorIds: [4] }),
    );
    expect(onUploaded).toHaveBeenCalledOnce();
    expect(onUploaded).toHaveBeenCalledWith(2);

    act(() => root.unmount());
  });
});
