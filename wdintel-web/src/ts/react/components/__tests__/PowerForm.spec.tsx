/**
 * @vitest-environment happy-dom
 */
import type { ReactNode } from 'react';
import { act, forwardRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@mui/material', () => ({
  Box: forwardRef<HTMLElement, Record<string, unknown>>(function MockBox(
    { children, component = 'div', onSubmit, onKeyDown, className, sx, ...props },
    ref,
  ) {
    const Component = component as keyof HTMLElementTagNameMap;
    return (
      <Component
        ref={ref as never}
        className={className as string | undefined}
        onSubmit={onSubmit as never}
        onKeyDown={onKeyDown as never}
        {...props}
      >
        {children as ReactNode}
      </Component>
    );
  }),
}));

import { PowerForm } from '../PowerForm';

function renderComponent(node: ReactNode) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return { container, root };
}

function wireRequestSubmit(form: HTMLFormElement) {
  const requestSubmit = vi.fn(() => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  Object.defineProperty(form, 'requestSubmit', {
    configurable: true,
    value: requestSubmit,
  });
  return requestSubmit;
}

function buildKeyboardEvent(
  target: EventTarget | null,
  init: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean } = {},
) {
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    key: 'Enter',
    ctrlKey: init.ctrlKey ?? false,
    metaKey: init.metaKey ?? false,
    shiftKey: init.shiftKey ?? false,
    altKey: init.altKey ?? false,
  });

  Object.defineProperty(event, 'target', { configurable: true, value: target });
  return event;
}

// Regression: https://github.com/echoua/echo/issues/2746
describe('PowerForm', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('submits on enter from a single-line input when allowed', () => {
    const onSubmit = vi.fn((event: Event) => {
      event.preventDefault();
    });
    const { container, root } = renderComponent(
      <PowerForm onSubmit={onSubmit}>
        <input aria-label="value" />
      </PowerForm>,
    );

    const form = container.querySelector('form') as HTMLFormElement | null;
    const input = container.querySelector('input') as HTMLInputElement | null;
    expect(form).toBeTruthy();
    expect(input).toBeTruthy();
    wireRequestSubmit(form as HTMLFormElement);

    act(() => {
      input?.dispatchEvent(buildKeyboardEvent(input));
    });

    expect(onSubmit).toHaveBeenCalledTimes(1);
    root.unmount();
  });

  it('prevents enter on a single-line input when submission is blocked', () => {
    const onSubmit = vi.fn();
    const { container, root } = renderComponent(
      <PowerForm canSubmit={false} onSubmit={onSubmit}>
        <input aria-label="value" />
      </PowerForm>,
    );

    const form = container.querySelector('form') as HTMLFormElement | null;
    const input = container.querySelector('input') as HTMLInputElement | null;
    expect(form).toBeTruthy();
    expect(input).toBeTruthy();
    wireRequestSubmit(form as HTMLFormElement);

    const event = buildKeyboardEvent(input);
    act(() => {
      input?.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
    root.unmount();
  });

  it('submits on cmd+enter and ctrl+enter from a textarea', () => {
    const onSubmit = vi.fn((event: Event) => {
      event.preventDefault();
    });
    const { container, root } = renderComponent(
      <PowerForm onSubmit={onSubmit}>
        <textarea aria-label="value" />
      </PowerForm>,
    );

    const form = container.querySelector('form') as HTMLFormElement | null;
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement | null;
    expect(form).toBeTruthy();
    expect(textarea).toBeTruthy();
    wireRequestSubmit(form as HTMLFormElement);

    act(() => {
      textarea?.dispatchEvent(buildKeyboardEvent(textarea, { metaKey: true }));
      textarea?.dispatchEvent(buildKeyboardEvent(textarea, { ctrlKey: true }));
    });

    expect(onSubmit).toHaveBeenCalledTimes(2);
    root.unmount();
  });

  it('disables keyboard submit when requested', () => {
    const onSubmit = vi.fn();
    const { container, root } = renderComponent(
      <PowerForm keyboardSubmit={false} onSubmit={onSubmit}>
        <input aria-label="value" />
      </PowerForm>,
    );

    const form = container.querySelector('form') as HTMLFormElement | null;
    const input = container.querySelector('input') as HTMLInputElement | null;
    expect(form).toBeTruthy();
    expect(input).toBeTruthy();
    wireRequestSubmit(form as HTMLFormElement);

    const event = buildKeyboardEvent(input);
    act(() => {
      input?.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
    root.unmount();
  });

  it('prevents textarea keyboard submit when keyboardSubmit is false', () => {
    const onSubmit = vi.fn();
    const { container, root } = renderComponent(
      <PowerForm keyboardSubmit={false} onSubmit={onSubmit}>
        <textarea aria-label="value" />
      </PowerForm>,
    );

    const form = container.querySelector('form') as HTMLFormElement | null;
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement | null;
    expect(form).toBeTruthy();
    expect(textarea).toBeTruthy();
    wireRequestSubmit(form as HTMLFormElement);

    const metaEvent = buildKeyboardEvent(textarea, { metaKey: true });
    const ctrlEvent = buildKeyboardEvent(textarea, { ctrlKey: true });
    act(() => {
      textarea?.dispatchEvent(metaEvent);
      textarea?.dispatchEvent(ctrlEvent);
    });

    expect(metaEvent.defaultPrevented).toBe(true);
    expect(ctrlEvent.defaultPrevented).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
    root.unmount();
  });

  it('submits globally only while this form owns the active interaction', async () => {
    const addEventListener = vi.spyOn(window, 'addEventListener');
    const onSubmit = vi.fn((event: Event) => {
      event.preventDefault();
    });
    const { container, root } = renderComponent(
      <>
        <PowerForm globalSubmitShortcut onSubmit={onSubmit}>
          <input aria-label="editor" />
        </PowerForm>
        <input aria-label="filter" />
      </>,
    );
    const form = container.querySelector('form') as HTMLFormElement;
    const editor = container.querySelector('[aria-label="editor"]') as HTMLInputElement;
    const filter = container.querySelector('[aria-label="filter"]') as HTMLInputElement;
    const requestSubmit = wireRequestSubmit(form);
    await act(async () => undefined);
    expect(addEventListener).toHaveBeenCalledWith('keydown', expect.any(Function));
    const globalKeydown = addEventListener.mock.calls.find(
      ([type, listener]) =>
        type === 'keydown' && (listener as Function).name === 'handleGlobalSubmit',
    )?.[1] as EventListener | undefined;
    expect(globalKeydown).toBeTruthy();
    expect(String(globalKeydown)).toContain('requestSubmit');
    const shortcut = () =>
      new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'Enter',
        ctrlKey: true,
      });
    expect(shortcut()).toMatchObject({ key: 'Enter', ctrlKey: true, defaultPrevented: false });

    act(() => {
      filter.focus();
      globalKeydown?.(shortcut());
    });
    expect(requestSubmit).not.toHaveBeenCalled();

    act(() => {
      editor.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      globalKeydown?.(shortcut());
    });
    expect(requestSubmit).toHaveBeenCalledTimes(1);
    root.unmount();
    addEventListener.mockRestore();
  });

  it('disables the global shortcut after rerender', () => {
    const onSubmit = vi.fn((event: Event) => {
      event.preventDefault();
    });
    const { container, root } = renderComponent(
      <PowerForm globalSubmitShortcut onSubmit={onSubmit}>
        <input aria-label="editor" />
      </PowerForm>,
    );
    wireRequestSubmit(container.querySelector('form') as HTMLFormElement);

    act(() => {
      root.render(
        <PowerForm globalSubmitShortcut={false} onSubmit={onSubmit}>
          <input aria-label="editor" />
        </PowerForm>,
      );
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', {
          bubbles: true,
          cancelable: true,
          key: 'Enter',
          metaKey: true,
        }),
      );
    });

    expect(onSubmit).not.toHaveBeenCalled();
    root.unmount();
  });
});
