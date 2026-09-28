/**
 * @vitest-environment happy-dom
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MANAGE_MESSAGE_EDITOR_WIDTH,
  ManageMessageEditorSurface,
} from '../ManageMessageEditorSurface';

function EditorContent(): ReactNode {
  return <h2 id="message-editor-title">Створити повідомлення</h2>;
}

describe('ManageMessageEditorSurface', () => {
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
    vi.restoreAllMocks();
  });

  it('renders an embedded editor as a labelled non-modal aside', async () => {
    await act(async () =>
      root.render(
        <ManageMessageEditorSurface
          dismissDisabled={false}
          onRequestClose={vi.fn()}
          open
          presentation="embedded"
          titleId="message-editor-title"
        >
          <EditorContent />
        </ManageMessageEditorSurface>,
      ),
    );

    const surface = document.querySelector<HTMLElement>(
      '[data-manage-message-presentation="embedded"]',
    );
    expect(surface?.tagName).toBe('ASIDE');
    expect(surface?.getAttribute('aria-labelledby')).toBe('message-editor-title');
    expect(surface?.style.getPropertyValue('--manage-message-editor-width')).toBe(
      MANAGE_MESSAGE_EDITOR_WIDTH,
    );
    expect(document.querySelector('.MuiBackdrop-root')).toBeNull();
  });

  it('renders the embedded editor flat and animates its entrance', async () => {
    await act(async () =>
      root.render(
        <ManageMessageEditorSurface
          dismissDisabled={false}
          onRequestClose={vi.fn()}
          open
          presentation="embedded"
          titleId="message-editor-title"
        >
          <EditorContent />
        </ManageMessageEditorSurface>,
      ),
    );

    const surface = document.querySelector<HTMLElement>(
      '[data-manage-message-presentation="embedded"]',
    );
    expect(surface?.classList.contains('MuiPaper-elevation0')).toBe(true);
    expect(surface?.style.marginLeft).toBe('16px');
    expect(surface?.style.animationName).toBe('manage-message-editor-enter');
    expect(surface?.style.animationDuration).not.toBe('0s');
  });

  it('allows an embedded host to keep the editor surface flush, transparent, and borderless', async () => {
    await act(async () =>
      root.render(
        <ManageMessageEditorSurface
          dismissDisabled={false}
          onRequestClose={vi.fn()}
          open
          presentation="embedded"
          titleId="message-editor-title"
          transparentEmbeddedSurface
        >
          <EditorContent />
        </ManageMessageEditorSurface>,
      ),
    );

    const surface = document.querySelector<HTMLElement>(
      '[data-manage-message-presentation="embedded"]',
    );
    expect(surface?.style.backgroundColor).toBe('transparent');
    expect(surface?.style.marginLeft).toBe('0px');
    expect(surface && getComputedStyle(surface).borderLeftStyle).toBe('none');
  });

  it('allows the Analysis host to fill its fluid grid track', async () => {
    await act(async () =>
      root.render(
        <ManageMessageEditorSurface
          dismissDisabled={false}
          onRequestClose={vi.fn()}
          open
          presentation="embedded"
          titleId="message-editor-title"
          fillEmbeddedSurface
        >
          <EditorContent />
        </ManageMessageEditorSurface>,
      ),
    );

    const surface = document.querySelector<HTMLElement>(
      '[data-manage-message-presentation="embedded"]',
    );
    expect(surface?.style.width).toBe('100%');
    expect(surface?.style.flex).toBe('1 1 auto');
  });

  it('renders the modal presentation through a temporary Drawer', async () => {
    await act(async () =>
      root.render(
        <ManageMessageEditorSurface
          dismissDisabled={false}
          onRequestClose={vi.fn()}
          open
          presentation="modal"
          titleId="message-editor-title"
        >
          <EditorContent />
        </ManageMessageEditorSurface>,
      ),
    );

    expect(document.querySelector('[data-manage-message-presentation="modal"]')).not.toBeNull();
    expect(document.querySelector('.MuiBackdrop-root')).not.toBeNull();
    expect(document.querySelector<HTMLElement>('.MuiDrawer-paper')?.style.width).toBe('100vw');
  });

  it('does not render a closed embedded surface', async () => {
    await act(async () =>
      root.render(
        <ManageMessageEditorSurface
          dismissDisabled={false}
          onRequestClose={vi.fn()}
          open={false}
          presentation="embedded"
          titleId="message-editor-title"
        >
          <EditorContent />
        </ManageMessageEditorSurface>,
      ),
    );

    expect(document.querySelector('[data-manage-message-presentation="embedded"]')).toBeNull();
  });

  it('keeps an embedded surface mounted for its exit animation before removing it', async () => {
    vi.useFakeTimers();
    await act(async () =>
      root.render(
        <ManageMessageEditorSurface
          dismissDisabled={false}
          onRequestClose={vi.fn()}
          open
          presentation="embedded"
          titleId="message-editor-title"
        >
          <EditorContent />
        </ManageMessageEditorSurface>,
      ),
    );

    await act(async () =>
      root.render(
        <ManageMessageEditorSurface
          dismissDisabled={false}
          onRequestClose={vi.fn()}
          open={false}
          presentation="embedded"
          titleId="message-editor-title"
        >
          <EditorContent />
        </ManageMessageEditorSurface>,
      ),
    );

    const exitingSurface = document.querySelector<HTMLElement>(
      '[data-manage-message-presentation="embedded"]',
    );
    expect(exitingSurface?.style.animationName).toBe('manage-message-editor-exit');
    expect(exitingSurface?.getAttribute('aria-hidden')).toBe('true');
    expect(exitingSurface?.hasAttribute('inert')).toBe(true);

    await act(async () => vi.advanceTimersByTimeAsync(180));
    expect(document.querySelector('[data-manage-message-presentation="embedded"]')).toBeNull();
    vi.useRealTimers();
  });

  it('requests close on Escape only while focus belongs to the embedded editor', async () => {
    const onRequestClose = vi.fn();
    await act(async () =>
      root.render(
        <>
          <button type="button">Стрічка</button>
          <ManageMessageEditorSurface
            dismissDisabled={false}
            onRequestClose={onRequestClose}
            open
            presentation="embedded"
            titleId="message-editor-title"
          >
            <EditorContent />
            <button type="button">Редактор</button>
          </ManageMessageEditorSurface>
        </>,
      ),
    );

    const [feedButton, editorButton] = document.querySelectorAll('button');
    feedButton.focus();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onRequestClose).not.toHaveBeenCalled();

    editorButton.focus();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onRequestClose).toHaveBeenCalledTimes(1);
  });
});
