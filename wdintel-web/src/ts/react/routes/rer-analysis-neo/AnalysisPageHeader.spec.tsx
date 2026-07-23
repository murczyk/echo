/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const useMediaQueryMock = vi.hoisted(() => vi.fn());

vi.mock('@mui/material', () => ({
  Button: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  CircularProgress: () => <span />,
  FormControlLabel: (props: { control: ReactNode; label: ReactNode }) => (
    <label>
      {props.control}
      <span>{props.label}</span>
    </label>
  ),
  IconButton: ({
    children,
    onClick,
    'aria-label': ariaLabel,
  }: {
    children: ReactNode;
    onClick?: () => void;
    'aria-label'?: string;
  }) => (
    <button type="button" aria-label={ariaLabel} onClick={onClick}>
      {children}
    </button>
  ),
  Stack: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Switch: (props: {
    checked?: boolean;
    onChange?: (_event: Event, checked: boolean) => void;
    inputProps?: { 'aria-label'?: string };
  }) => (
    <input
      type="checkbox"
      aria-label={props.inputProps?.['aria-label']}
      checked={props.checked ?? false}
      onChange={(event) => props.onChange?.(event.nativeEvent, event.currentTarget.checked)}
    />
  ),
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  useMediaQuery: useMediaQueryMock,
}));

vi.mock('@mui/material/styles', () => ({}));

vi.mock('@mui/icons-material/DescriptionOutlined', () => ({ default: () => <span /> }));
vi.mock('@mui/icons-material/KeyboardArrowDown', () => ({ default: () => <span /> }));
vi.mock('@mui/icons-material/KeyboardArrowUp', () => ({ default: () => <span /> }));
vi.mock('@mui/icons-material/RefreshOutlined', () => ({ default: () => <span /> }));

vi.mock('../../components/PageHeader', () => ({
  PageHeader: ({ titleLeadingActions, titleActions, actions }: Record<string, ReactNode>) => (
    <header>
      {titleLeadingActions}
      {titleActions}
      {actions}
    </header>
  ),
}));

vi.mock('../../components/SidePanelToggleButton', () => ({
  SidePanelToggleButton: ({
    side,
    label,
    onClick,
  }: {
    side: string;
    label: string;
    onClick: () => void;
  }) => (
    <button type="button" data-side={side} aria-label={label} onClick={onClick}>
      {label}
    </button>
  ),
}));

vi.mock('./components/AnalysisHeaderControls', () => ({ AnalysisHeaderControls: () => null }));
vi.mock('./components/AnalysisPaginationControl', () => ({
  AnalysisPaginationControl: () => <span data-testid="pagination" />,
}));

import { AnalysisPageHeader } from './AnalysisPageHeader';
import type { AnalysisPageViewModel } from './types';

function buildPage(): AnalysisPageViewModel {
  return {
    countsLoading: false,
    messagesLoading: false,
    summaryLoading: false,
    messages: [],
    messagesTotalCount: 0,
    messagesTotalLoading: false,
    pageIndex: 0,
    noMoreToLoad: false,
    messagesPaging: false,
    queryState: {} as AnalysisPageViewModel['queryState'],
    openReport: vi.fn(),
    reload: vi.fn(),
    toggleLeftPanel: vi.fn(),
    toggleRightPanel: vi.fn(),
    newestFirst: false,
    setNewestFirst: vi.fn(),
  } as unknown as AnalysisPageViewModel;
}

function renderHeader(
  page: AnalysisPageViewModel,
  isCompactLayout: boolean,
  rightPanelVisible: boolean,
  centerTab: 'messages' | 'summary' | 'map' = 'messages',
  isInitialLoading = false,
) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <AnalysisPageHeader
        page={page}
        centerTab={centerTab}
        isCompactLayout={isCompactLayout}
        isInitialLoading={isInitialLoading}
        isNarrowLayout={isCompactLayout}
        leftPanelVisible
        rightPanelVisible={rightPanelVisible}
      />,
    );
  });
  return { container, root };
}

describe('AnalysisPageHeader', () => {
  const rendered: Array<{ container: HTMLDivElement; root: Root }> = [];

  afterEach(() => {
    for (const item of rendered.splice(0)) {
      act(() => item.root.unmount());
      item.container.remove();
    }
  });

  it('shows and wires the mobile right-panel opening control only when closed', () => {
    useMediaQueryMock.mockReturnValue(true);
    const page = buildPage();
    const view = renderHeader(page, true, false);
    rendered.push(view);

    const openButton = view.container.querySelector<HTMLButtonElement>(
      '[aria-label="Розгорнути праву панель"]',
    );
    expect(openButton).not.toBeNull();
    act(() => openButton?.click());
    expect(page.toggleRightPanel).toHaveBeenCalledTimes(1);

    act(() => {
      view.root.render(
        <AnalysisPageHeader
          page={page}
          centerTab="messages"
          isCompactLayout
          isNarrowLayout
          leftPanelVisible
          rightPanelVisible
        />,
      );
    });
    expect(view.container.querySelector('[aria-label="Розгорнути праву панель"]')).toBeNull();
  });

  it('keeps the desktop right-panel toggle and omits the mobile opening control', () => {
    useMediaQueryMock.mockReturnValue(false);
    const page = buildPage();
    const view = renderHeader(page, false, true);
    rendered.push(view);

    expect(view.container.querySelector('[data-side="right"]')).not.toBeNull();
    expect(view.container.querySelector('[aria-label="Згорнути праву панель"]')).not.toBeNull();
    expect(view.container.querySelector('[aria-label="Розгорнути праву панель"]')).toBeNull();
  });

  it('uses the shared narrow right-panel toggle dimensions', async () => {
    const page = buildPage();
    const view = renderHeader(page, true, false);
    rendered.push(view);

    const openButton = view.container.querySelector<HTMLButtonElement>(
      '[aria-label="Розгорнути праву панель"]',
    );
    expect(openButton).not.toBeNull();
    expect(openButton?.tagName).toBe('BUTTON');
  });

  it('keeps a compact collapse control available while the initial skeleton is visible', () => {
    const page = buildPage();
    const view = renderHeader(page, true, true, 'messages', true);
    rendered.push(view);

    expect(view.container.querySelectorAll('[aria-label="Згорнути праву панель"]')).toHaveLength(1);
  });

  it('leaves compact panel collapse to the mounted sidebar after loading', () => {
    const page = buildPage();
    const view = renderHeader(page, true, true, 'messages', false);
    rendered.push(view);

    expect(view.container.querySelector('[aria-label="Згорнути праву панель"]')).toBeNull();
  });

  it('moves newest-first into narrow message actions without duplicating it in tabs', () => {
    const page = buildPage();
    const view = renderHeader(page, true, false);
    rendered.push(view);

    const newestFirst = view.container.querySelector<HTMLInputElement>(
      '[aria-label="Спочатку нові"]',
    );
    expect(newestFirst).not.toBeNull();
    act(() => newestFirst?.click());
    expect(page.setNewestFirst).toHaveBeenCalledWith(true);
    expect(view.container.querySelectorAll('[aria-label="Спочатку нові"]')).toHaveLength(1);
  });

  it('keeps narrow non-message actions right-aligned without pagination', () => {
    const page = buildPage();
    const view = renderHeader(page, true, false, 'summary');
    rendered.push(view);

    expect(view.container.querySelector('[data-testid="pagination"]')).toBeNull();
    expect(view.container.querySelector('[aria-label="Оновити"]')).not.toBeNull();
    expect(view.container.querySelector('[aria-label="Розгорнути праву панель"]')).not.toBeNull();
  });
});
