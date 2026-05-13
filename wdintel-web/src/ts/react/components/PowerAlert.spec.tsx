/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PowerAlert } from './PowerAlert';

type Rendered = {
  container: HTMLDivElement;
  root: Root;
};

const rendered: Rendered[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const item of rendered.splice(0)) {
    act(() => {
      item.root.unmount();
    });
    item.container.remove();
  }
});

function renderComponent(node: React.ReactNode): Rendered {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return { container, root };
}

describe('PowerAlert', () => {
  it('calls onClose when auto-hide timeout expires', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();

    const view = renderComponent(
      <PowerAlert severity="success" autoHideDuration={10} onClose={onClose}>
        done
      </PowerAlert>,
    );
    rendered.push(view);

    act(() => {
      vi.advanceTimersByTime(10);
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(view.container.textContent).not.toContain('done');
  });

  it('auto-hides success alert by default', () => {
    vi.useFakeTimers();

    const view = renderComponent(
      <PowerAlert severity="success">done</PowerAlert>,
    );
    rendered.push(view);

    act(() => {
      vi.advanceTimersByTime(4000);
    });

    expect(view.container.textContent).not.toContain('done');
  });

  it('shows close button for warning and error alerts', () => {
    const withoutOnClose = renderComponent(
      <PowerAlert severity="error">error</PowerAlert>,
    );
    rendered.push(withoutOnClose);
    expect(
      withoutOnClose.container.querySelector('button[aria-label="Close"]'),
    ).not.toBeNull();

    const withOnClose = renderComponent(
      <PowerAlert severity="error" onClose={() => {}}>
        error
      </PowerAlert>,
    );
    rendered.push(withOnClose);
    expect(
      withOnClose.container.querySelector('button[aria-label="Close"]'),
    ).not.toBeNull();
  });
});
