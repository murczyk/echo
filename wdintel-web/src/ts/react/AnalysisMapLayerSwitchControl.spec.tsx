/**
 * @vitest-environment happy-dom
 */
import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const badgeProps: Array<{ invisible?: boolean; color?: string; variant?: string; overlap?: string }> = [];

vi.mock('@mui/material', () => ({
  Badge: ({
    children,
    invisible,
    color,
    variant,
    overlap,
    className,
  }: {
    children?: ReactNode;
    invisible?: boolean;
    color?: string;
    variant?: string;
    overlap?: string;
    className?: string;
  }) => {
    badgeProps.push({ invisible, color, variant, overlap });
    return (
      <span className={className} data-badge-invisible={String(invisible ?? false)} data-badge-color={color} data-badge-variant={variant} data-badge-overlap={overlap}>
        {children}
      </span>
    );
  },
  Box: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => <div {...props}>{children}</div>,
  Checkbox: ({ checked, onChange }: { checked?: boolean; onChange?: () => void }) => (
    <input type="checkbox" checked={checked ?? false} onChange={onChange} />
  ),
  IconButton: ({ children, onClick, ...props }: { children?: ReactNode; onClick?: () => void } & Record<string, unknown>) => (
    <button type="button" onClick={onClick} {...props}>
      {children}
    </button>
  ),
  Radio: ({ checked, onChange }: { checked?: boolean; onChange?: () => void }) => (
    <input type="radio" checked={checked ?? false} onChange={onChange} />
  ),
  ThemeProvider: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Typography: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => <div {...props}>{children}</div>,
}));

vi.mock('./mui-theme', () => ({
  useNeoMuiTheme: () => ({}),
}));

import { AnalysisMapLayerSwitchControl } from './AnalysisMapLayerSwitchControl';

describe('AnalysisMapLayerSwitchControl', () => {
  afterEach(() => {
    badgeProps.splice(0);
    document.body.innerHTML = '';
  });

  async function render(features: { palitrasEnabled: boolean; pelengsEnabled: boolean; kmzEnabled: boolean }) {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <AnalysisMapLayerSwitchControl
          currentLayer="openStreetMap"
          features={features}
          onLayerChange={vi.fn()}
          onFeatureToggle={vi.fn()}
        />,
      );
    });
    return { container, root };
  }

  it('shows the layers badge when pelengs are disabled', async () => {
    const view = await render({ palitrasEnabled: true, pelengsEnabled: false, kmzEnabled: true });

    expect(view.container.querySelector('[data-badge-invisible="false"]')).not.toBeNull();
    expect(badgeProps.at(-1)).toMatchObject({
      invisible: false,
      color: 'error',
      variant: 'dot',
      overlap: 'circular',
    });

    view.root.unmount();
  });

  it('hides the layers badge when pelengs are enabled', async () => {
    const view = await render({ palitrasEnabled: false, pelengsEnabled: true, kmzEnabled: false });

    expect(view.container.querySelector('[data-badge-invisible="true"]')).not.toBeNull();
    expect(badgeProps.at(-1)).toMatchObject({
      invisible: true,
      color: 'error',
      variant: 'dot',
      overlap: 'circular',
    });

    view.root.unmount();
  });

  it('does not react to unrelated feature toggles', async () => {
    const view = await render({ palitrasEnabled: false, pelengsEnabled: true, kmzEnabled: true });

    expect(view.container.querySelector('[data-badge-invisible="true"]')).not.toBeNull();
    expect(badgeProps.at(-1)?.invisible).toBe(true);

    view.root.unmount();
  });
});
