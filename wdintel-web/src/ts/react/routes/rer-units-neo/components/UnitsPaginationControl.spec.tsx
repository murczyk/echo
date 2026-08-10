/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { UnitsPaginationControl } from './UnitsPaginationControl';

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('UnitsPaginationControl', () => {
  it('shows the current range and navigates between pages', async () => {
    const onPrevPage = vi.fn();
    const onNextPage = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <UnitsPaginationControl
          pageIndex={1}
          pageSize={20}
          totalCount={57}
          loading={false}
          onPrevPage={onPrevPage}
          onNextPage={onNextPage}
        />,
      );
    });

    expect(container.textContent).toContain('21-40 з 57');
    act(() =>
      container.querySelector<HTMLButtonElement>('[aria-label="Попередня сторінка"]')?.click(),
    );
    act(() =>
      container.querySelector<HTMLButtonElement>('[aria-label="Наступна сторінка"]')?.click(),
    );

    expect(onPrevPage).toHaveBeenCalledOnce();
    expect(onNextPage).toHaveBeenCalledOnce();
  });
});
