/**
 * @vitest-environment happy-dom
 */
import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@mui/material', () => ({
  Tabs: ({ children }: { children?: ReactNode }) => <div role="tablist">{children}</div>,
  Tab: ({ label, value }: { label?: ReactNode; value?: string }) => (
    <button role="tab" data-value={value}>
      {label}
    </button>
  ),
}));

import { AnalysisRightDock } from '../AnalysisRightDock';

function renderDock({ editorOpen = true, analyticsOpen = false } = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = () =>
    root.render(
      <AnalysisRightDock
        presentation="embedded"
        editorOpen={editorOpen}
        analyticsOpen={analyticsOpen}
        editor={<div data-testid="editor-mount-counter">1</div>}
        analytics={<div data-testid="analytics">analytics</div>}
      />,
    );
  act(() => render());
  return { container, root };
}

describe('AnalysisRightDock', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('shows no tabs when only one dock destination exists', () => {
    const { container, root } = renderDock();
    expect(container.querySelector('[role="tablist"]')).toBeNull();
    root.unmount();
  });

  it('renders only the editor when both destinations are requested', () => {
    const { container, root } = renderDock({ analyticsOpen: true });
    const editorPanel = container.querySelector('[data-analysis-dock-panel="editor"]');
    expect(editorPanel).not.toBeNull();
    expect(container.querySelector('[data-testid="editor-mount-counter"]')?.textContent).toBe('1');
    expect(container.querySelector('[data-analysis-dock-panel="analytics"]')).toBeNull();
    expect(container.querySelector('[role="tablist"]')).toBeNull();
    root.unmount();
  });

  it('fills the fluid right grid track when the editor is active', () => {
    const { container, root } = renderDock({ analyticsOpen: true });
    const dock = container.querySelector('[data-testid="analysis-right-dock"]') as HTMLElement;
    expect(dock.style.width).toBe('100%');
    root.unmount();
  });

  it('renders only Analytics when the editor is closed', () => {
    const { container, root } = renderDock({ editorOpen: false, analyticsOpen: true });
    expect(container.querySelector('[data-analysis-dock-panel="editor"]')).toBeNull();
    expect(container.querySelector('[data-analysis-dock-panel="analytics"]')).not.toBeNull();
    root.unmount();
  });

  it('constrains the active editor panel so its own content can scroll', () => {
    const { container, root } = renderDock();
    const editorPanel = container.querySelector(
      '[data-analysis-dock-panel="editor"]',
    ) as HTMLElement;
    expect(editorPanel.style.display).toBe('flex');
    expect(editorPanel.style.height).toBe('100%');
    root.unmount();
  });

  it('keeps the editor panel mounted while the dock track finishes closing', async () => {
    vi.useFakeTimers();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const render = (editorOpen: boolean) =>
      root.render(
        <AnalysisRightDock
          presentation="embedded"
          editorOpen={editorOpen}
          analyticsOpen={false}
          editor={<div data-testid="editor-mount-counter">1</div>}
          analytics={<div data-testid="analytics">analytics</div>}
        />,
      );

    act(() => render(true));
    act(() => render(false));
    expect(container.querySelector('[data-analysis-dock-panel="editor"]')).not.toBeNull();

    await act(async () => vi.advanceTimersByTimeAsync(180));
    expect(container.querySelector('[data-analysis-dock-panel="editor"]')).toBeNull();
    root.unmount();
    vi.useRealTimers();
  });
});
