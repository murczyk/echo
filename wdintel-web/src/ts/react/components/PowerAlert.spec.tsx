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
});
