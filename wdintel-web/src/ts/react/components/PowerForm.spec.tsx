/**
 * @vitest-environment happy-dom
 */
import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const boxProps: Array<{ component?: string; className?: string }> = [];

vi.mock('@mui/material', () => ({
  Box: ({
    children,
    component = 'div',
    onSubmit,
    onKeyDown,
    className,
    sx,
    ...props
  }: {
    children?: ReactNode;
    component?: string;
    onSubmit?: (event: Event) => void;
    onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
    className?: string;
  } & Record<string, unknown>) => {
    boxProps.push({ component, className });
    const Component = component as keyof HTMLElementTagNameMap;
    return (
      <Component className={className} onSubmit={onSubmit} onKeyDown={onKeyDown} {...props}>
        {children}
      </Component>
    );
  },
}));

import { PowerForm } from './PowerForm';

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
  Object.defineProperty(form, 'requestSubmit', {
    configurable: true,
    value: vi.fn(() => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    }),
  });
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

describe('PowerForm', () => {
  afterEach(() => {
    boxProps.splice(0);
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
    expect(boxProps.at(-1)?.component).toBe('form');
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

    expect(event.defaultPrevented).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
    root.unmount();
  });

  it('blocks native submit when canSubmit is false', () => {
    const onSubmit = vi.fn();
    const { container, root } = renderComponent(
      <PowerForm canSubmit={false} onSubmit={onSubmit}>
        <input aria-label="value" />
        <button type="submit">Save</button>
      </PowerForm>,
    );

    const form = container.querySelector('form') as HTMLFormElement | null;
    const submitEvent = new Event('submit', { bubbles: true, cancelable: true });
    expect(form).toBeTruthy();

    act(() => {
      form?.dispatchEvent(submitEvent);
    });

    expect(submitEvent.defaultPrevented).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
    root.unmount();
  });

  it('blocks native submit when canSubmit function returns false', () => {
    const onSubmit = vi.fn();
    const { container, root } = renderComponent(
      <PowerForm canSubmit={() => false} onSubmit={onSubmit}>
        <input aria-label="value" />
        <button type="submit">Save</button>
      </PowerForm>,
    );

    const form = container.querySelector('form') as HTMLFormElement | null;
    const submitEvent = new Event('submit', { bubbles: true, cancelable: true });
    expect(form).toBeTruthy();

    act(() => {
      form?.dispatchEvent(submitEvent);
    });

    expect(submitEvent.defaultPrevented).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
    root.unmount();
  });

  it('still allows normal form submission', () => {
    const onSubmit = vi.fn((event: Event) => {
      event.preventDefault();
    });
    const { container, root } = renderComponent(
      <PowerForm onSubmit={onSubmit}>
        <input aria-label="value" />
        <button type="submit">Save</button>
      </PowerForm>,
    );

    const form = container.querySelector('form') as HTMLFormElement | null;
    const button = container.querySelector('button[type="submit"]') as HTMLButtonElement | null;
    expect(form).toBeTruthy();
    expect(button).toBeTruthy();

    act(() => {
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(onSubmit).toHaveBeenCalledTimes(1);
    root.unmount();
  });
});
