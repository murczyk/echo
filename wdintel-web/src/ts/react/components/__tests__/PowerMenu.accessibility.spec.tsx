/**
 * @vitest-environment happy-dom
 */
import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const muiMenuSpy = vi.fn();

vi.mock('@mui/material', () => ({
  Menu: (props: Record<string, unknown>) => {
    muiMenuSpy(props);
    return <div>{props.children as ReactNode}</div>;
  },
}));

import { PowerMenu } from '../PowerMenu.tsx';

type Rendered = {
  container: HTMLDivElement;
  root: Root;
};
describe('PowerMenu accessibility', () => {
  const rendered: Rendered[] = [];

  afterEach(() => {
    muiMenuSpy.mockClear();
    for (const item of rendered.splice(0)) {
      act(() => {
        item.root.unmount();
      });
      item.container.remove();
    }
  });

  it('preserves a caller-provided aria-labelledby on MenuListProps', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    rendered.push({ container, root });

    act(() => {
      root.render(
        <PowerMenu
          open
          anchorEl={document.createElement('button')}
          MenuListProps={{
            'aria-labelledby': 'overflow-trigger',
          }}
        >
          <div>items</div>
        </PowerMenu>,
      );
    });

    expect(muiMenuSpy).toHaveBeenCalledTimes(1);
    expect(muiMenuSpy.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        slotProps: expect.objectContaining({
          list: expect.objectContaining({
            'aria-labelledby': 'overflow-trigger',
          }),
        }),
      }),
    );
  });
});
