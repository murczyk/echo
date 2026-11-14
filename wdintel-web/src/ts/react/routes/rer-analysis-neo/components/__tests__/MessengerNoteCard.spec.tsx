/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MessengerNoteCard } from '../MessengerNoteCard';

describe('MessengerNoteCard', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const click = (label: string) =>
    act(async () => {
      [...container.querySelectorAll('button')]
        .find(
          (button) => button.textContent === label || button.getAttribute('aria-label') === label,
        )
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

  const type = (value: string) =>
    act(async () => {
      const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
        textarea,
        value,
      );
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });

  it('is read-only without onSave and shows a placeholder for an empty text', () => {
    act(() => root.render(<MessengerNoteCard title="Опис" text={null} />));
    expect(container.querySelector('[aria-label="Редагувати"]')).toBeNull();
    expect(container.textContent).not.toContain('null');
  });

  it('edits through a textarea and saves the typed text', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    act(() =>
      root.render(<MessengerNoteCard title="Внутрішній опис" text="old" onSave={onSave} />),
    );

    await click('Редагувати');
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('old');
    await type('new text');
    await click('Зберегти');

    expect(onSave).toHaveBeenCalledWith('new text');
    expect(container.querySelector('textarea')).toBeNull();
  });

  it('keeps the editor open and shows the error when saving fails, and cancel drops the draft', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('Сервер недоступний'));
    act(() =>
      root.render(<MessengerNoteCard title="Внутрішній опис" text="old" onSave={onSave} />),
    );

    await click('Редагувати');
    await type('draft');
    await click('Зберегти');
    expect(container.querySelector('textarea')).not.toBeNull();
    expect(container.textContent).toContain('Сервер недоступний');

    await click('Скасувати');
    expect(container.querySelector('textarea')).toBeNull();
    await click('Редагувати');
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('old');
  });
});
