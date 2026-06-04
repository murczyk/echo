/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@mui/icons-material/Clear', () => ({ default: () => <span data-testid="clear-icon" /> }));
vi.mock('@mui/icons-material/Search', () => ({ default: () => <span data-testid="search-icon" /> }));

vi.mock('@mui/material', () => ({
  InputAdornment: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TextField: (props: {
    slotProps?: {
      input?: {
        startAdornment?: ReactNode;
        endAdornment?: ReactNode;
      };
    };
    value?: string;
    placeholder?: string;
    disabled?: boolean;
  }) => (
    <div data-testid="text-field" data-placeholder={props.placeholder ?? ''} data-disabled={props.disabled ? 'true' : 'false'}>
      <div>{props.slotProps?.input?.startAdornment}</div>
      <div>{props.slotProps?.input?.endAdornment}</div>
    </div>
  ),
}));

vi.mock('../../../../../PowerIconButton', () => ({
  PowerIconButton: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
}));

import { GlobalFilterTextField } from './global-filter-text-field';

type Rendered = {
  container: HTMLDivElement;
  root: Root;
};

async function renderComponent(): Promise<Rendered> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<GlobalFilterTextField globalFilter="abc" setGlobalFilter={() => {}} />);
  });
  return { container, root };
}

describe('GlobalFilterTextField', () => {
  const rendered: Rendered[] = [];

  afterEach(() => {
    for (const item of rendered.splice(0)) {
      act(() => {
        item.root.unmount();
      });
      item.container.remove();
    }
    vi.clearAllMocks();
  });

  it('uses the search icon for the leading adornment', async () => {
    const view = await renderComponent();
    rendered.push(view);

    expect(view.container.querySelector('[data-testid="search-icon"]')).toBeTruthy();
    expect(view.container.querySelector('[data-testid="clear-icon"]')).toBeTruthy();
  });
});
