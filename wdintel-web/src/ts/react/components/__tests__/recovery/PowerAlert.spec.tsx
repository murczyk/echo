/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PowerAlert } from '../../PowerAlert';

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

// @test-scope safeguard: prevents operational alerts from disappearing unexpectedly or becoming impossible to dismiss
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

    const view = renderComponent(<PowerAlert severity="success">done</PowerAlert>);
    rendered.push(view);

    act(() => {
      vi.advanceTimersByTime(6000);
    });

    expect(view.container.textContent).not.toContain('done');
  });

  it('shows a close button for success alerts with onClose', () => {
    const view = renderComponent(
      <PowerAlert severity="success" onClose={() => {}}>
        done
      </PowerAlert>,
    );
    rendered.push(view);

    expect(view.container.querySelector('button[aria-label="Close"]')).not.toBeNull();
  });

  it('does not auto-hide info alerts by default', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();

    const view = renderComponent(
      <PowerAlert severity="info" onClose={onClose}>
        info
      </PowerAlert>,
    );
    rendered.push(view);

    act(() => {
      vi.advanceTimersByTime(6000);
    });

    expect(onClose).not.toHaveBeenCalled();
    expect(view.container.querySelector('[role="alert"]')).not.toBeNull();
    expect(view.container.querySelector('button[aria-label="Close"]')).toBeNull();
  });

  it('auto-hides timed info alerts and calls onClose', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();

    const view = renderComponent(
      <PowerAlert severity="info" autoHideDuration={10} onClose={onClose}>
        info
      </PowerAlert>,
    );
    rendered.push(view);

    expect(view.container.querySelector('button[aria-label="Close"]')).toBeNull();

    act(() => {
      vi.advanceTimersByTime(10);
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(view.container.textContent).not.toContain('info');
  });

  it('shows a close button for explicitly dismissible info alerts', () => {
    const view = renderComponent(
      <PowerAlert severity="info" dismissible>
        info
      </PowerAlert>,
    );
    rendered.push(view);

    expect(view.container.querySelector('button[aria-label="Close"]')).not.toBeNull();
  });

  it('shows close button for warning and error alerts', () => {
    const withoutOnClose = renderComponent(<PowerAlert severity="error">error</PowerAlert>);
    rendered.push(withoutOnClose);
    expect(withoutOnClose.container.querySelector('button[aria-label="Close"]')).not.toBeNull();

    const withOnClose = renderComponent(
      <PowerAlert severity="error" onClose={() => {}}>
        error
      </PowerAlert>,
    );
    rendered.push(withOnClose);
    expect(withOnClose.container.querySelector('button[aria-label="Close"]')).not.toBeNull();
  });
});
