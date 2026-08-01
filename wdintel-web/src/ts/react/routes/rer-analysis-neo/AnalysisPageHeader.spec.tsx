/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const useMediaQueryMock = vi.hoisted(() => vi.fn());

vi.mock('@mui/material', () => ({
  Button: ({
    children,
    color,
    onClick,
    sx,
    variant,
  }: {
    children: ReactNode;
    color?: string;
    onClick?: () => void;
    sx?: { borderColor?: string };
    variant?: string;
  }) => (
    <button
      type="button"
      data-border-color={sx?.borderColor}
      data-color={color}
      data-variant={variant}
      onClick={onClick}
    >
      {children}
    </button>
  ),
  CircularProgress: () => <span data-testid="loading-spinner" />,
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
  ListItemIcon: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  ListItemText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  Menu: ({ children, open }: { children: ReactNode; open?: boolean }) =>
    open ? <div role="menu">{children}</div> : null,
  MenuItem: ({
    children,
    disabled,
    onClick,
    role,
    'aria-checked': ariaChecked,
  }: {
    children: ReactNode;
    disabled?: boolean;
    onClick?: () => void;
    role?: string;
    'aria-checked'?: boolean;
  }) => (
    <button
      type="button"
      role={role ?? 'menuitem'}
      aria-checked={ariaChecked}
      disabled={disabled}
      onClick={onClick}
    >
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
vi.mock('@mui/icons-material/SettingsOutlined', () => ({ default: () => <span /> }));

vi.mock('../../components/PageHeader', () => ({
  PageHeader: ({
    middle,
    titleLeadingActions,
    titleTrailing,
    titleActions,
    actions,
    pinTitleActionsToRight,
    fullWidthActions,
  }: {
    middle?: ReactNode;
    titleLeadingActions?: ReactNode;
    titleTrailing?: ReactNode;
    titleActions?: ReactNode;
    actions?: ReactNode;
    pinTitleActionsToRight?: boolean;
    fullWidthActions?: boolean;
  }) => (
    <header
      data-pin-title-actions={pinTitleActionsToRight ? 'true' : 'false'}
      data-full-width-actions={fullWidthActions ? 'true' : 'false'}
    >
      <div data-testid="title-leading-actions">{titleLeadingActions}</div>
      <div data-testid="title-trailing">{titleTrailing}</div>
      <div data-testid="title-actions">{titleActions}</div>
      <div data-testid="header-middle">{middle}</div>
      <div data-testid="header-actions">{actions}</div>
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

vi.mock('./components/AnalysisHeaderControls', () => ({
  AnalysisHeaderControls: ({ isCompactLayout }: { isCompactLayout?: boolean }) => (
    <span data-testid={isCompactLayout ? 'compact-header-controls' : 'regular-header-controls'} />
  ),
}));
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
  isNarrowLayout = isCompactLayout,
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
        isNarrowLayout={isNarrowLayout}
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

  it('shows and wires both shared panel controls in compact layouts', () => {
    useMediaQueryMock.mockReturnValue(true);
    const page = buildPage();
    const view = renderHeader(page, true, false);
    rendered.push(view);

    const openButton = view.container.querySelector<HTMLButtonElement>(
      '[aria-label="Розгорнути праву панель"]',
    );
    expect(openButton).not.toBeNull();
    expect(view.container.querySelector('[data-side="left"]')).not.toBeNull();
    expect(view.container.querySelector('[data-side="right"]')).not.toBeNull();
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
    expect(view.container.querySelector('[aria-label="Згорнути праву панель"]')).not.toBeNull();
  });

  it('moves compact search and date controls beside the title', () => {
    const page = buildPage();
    const compactView = renderHeader(page, true, false);
    const desktopView = renderHeader(page, false, false, 'messages', false);
    rendered.push(compactView, desktopView);

    expect(
      compactView.container.querySelector(
        '[data-testid="title-trailing"] [data-testid="compact-header-controls"]',
      ),
    ).not.toBeNull();
    expect(
      compactView.container.querySelector('[data-testid="header-middle"]')?.children,
    ).toHaveLength(0);
    expect(
      desktopView.container.querySelector(
        '[data-testid="header-middle"] [data-testid="regular-header-controls"]',
      ),
    ).not.toBeNull();
    expect(
      desktopView.container.querySelector('[data-testid="title-trailing"]')?.children,
    ).toHaveLength(0);
    expect(
      compactView.container.querySelector(
        '[data-testid="header-actions"] [data-testid="pagination"]',
      ),
    ).toBeNull();
    expect(
      desktopView.container.querySelector(
        '[data-testid="header-actions"] [data-testid="pagination"]',
      ),
    ).not.toBeNull();
  });

  it('moves actions into the settings menu as soon as the layout is narrow', () => {
    const page = buildPage();
    const view = renderHeader(page, false, false, 'messages', true);
    rendered.push(view);

    const settingsButton = view.container.querySelector<HTMLButtonElement>(
      '[data-testid="title-actions"] button[aria-label="Налаштування аналізу"]',
    );
    expect(settingsButton).not.toBeNull();
    expect(view.container.querySelector('[role="menu"]')).toBeNull();

    act(() => settingsButton?.click());

    const menu = view.container.querySelector('[role="menu"]');
    expect(menu?.textContent).toContain('Спочатку нові');
    expect(menu?.textContent).toContain('Оновити');
    expect(menu?.textContent).toContain('Звіти');
    expect(
      view.container.querySelector('[data-testid="header-actions"] [aria-label="Оновити"]'),
    ).toBeNull();
    expect(
      view.container.querySelector('[data-testid="header-actions"] [aria-label="Спочатку нові"]'),
    ).toBeNull();
    expect(view.container.querySelector('[data-testid="pagination"]')).toBeNull();

    const newestFirst = view.container.querySelector<HTMLButtonElement>(
      '[role="menuitemcheckbox"]',
    );
    act(() => newestFirst?.click());
    expect(page.setNewestFirst).toHaveBeenCalledWith(true);

    const refreshButton = Array.from(
      view.container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ).find((button) => button.textContent?.includes('Оновити'));
    act(() => refreshButton?.click());
    expect(page.reload).toHaveBeenCalledWith({ preserveMessagePage: true });

    act(() => settingsButton?.click());
    const reportButton = Array.from(
      view.container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ).find((button) => button.textContent?.includes('Звіти'));
    act(() => reportButton?.click());
    expect(page.openReport).toHaveBeenCalledTimes(1);
  });

  it('does not duplicate the map date-range loading indicator in the desktop header', () => {
    const page = buildPage();
    page.messagesLoading = true;
    page.mapAttrs = {
      daterangeLoading: 'true',
    } as AnalysisPageViewModel['mapAttrs'];
    const view = renderHeader(page, false, false, 'map', false);
    rendered.push(view);

    const refreshButton = view.container.querySelector('[aria-label="Оновити"]');
    expect(refreshButton?.querySelector('[data-testid="loading-spinner"]')).toBeNull();
  });

  it('keeps the desktop right-panel toggle and omits the mobile opening control', () => {
    useMediaQueryMock.mockReturnValue(false);
    const page = buildPage();
    const view = renderHeader(page, false, true);
    rendered.push(view);

    expect(view.container.querySelector('[data-side="right"]')).not.toBeNull();
    expect(
      view.container.querySelector('[data-testid="header-actions"] [data-side="right"]'),
    ).not.toBeNull();
    expect(
      view.container.querySelector('[data-testid="title-actions"] [data-side="right"]'),
    ).toBeNull();
    expect(view.container.querySelector('header')?.dataset.pinTitleActions).toBe('false');
    expect(view.container.querySelector('header')?.dataset.fullWidthActions).toBe('false');
    expect(view.container.querySelector('[aria-label="Згорнути праву панель"]')).not.toBeNull();
    expect(view.container.querySelector('[aria-label="Розгорнути праву панель"]')).toBeNull();
  });

  it('renders the report action as a neutral grey outlined button', () => {
    const view = renderHeader(buildPage(), false, false);
    rendered.push(view);

    const reportButton = Array.from(
      view.container.querySelectorAll<HTMLButtonElement>('[data-testid="header-actions"] button'),
    ).find((button) => button.textContent?.trim() === 'ЗВІТИ');

    expect(reportButton?.dataset.variant).toBe('outlined');
    expect(reportButton?.dataset.color).toBe('inherit');
    expect(reportButton?.dataset.borderColor).toBe('divider');
  });

  it('keeps the narrow right-panel toggle in the title row', () => {
    const page = buildPage();
    const view = renderHeader(page, false, false, 'messages', true);
    rendered.push(view);

    expect(
      view.container.querySelector('[data-testid="title-actions"] [data-side="right"]'),
    ).not.toBeNull();
    expect(
      view.container.querySelector('[data-testid="header-actions"] [data-side="right"]'),
    ).toBeNull();
    expect(view.container.querySelector('header')?.dataset.pinTitleActions).toBe('true');
    expect(view.container.querySelector('header')?.dataset.fullWidthActions).toBe('true');
  });

  it('keeps both compact collapse controls available while panels are open', () => {
    const page = buildPage();
    const view = renderHeader(page, true, true);
    rendered.push(view);

    expect(view.container.querySelectorAll('[aria-label="Згорнути ліву панель"]')).toHaveLength(1);
    expect(view.container.querySelectorAll('[aria-label="Згорнути праву панель"]')).toHaveLength(1);
  });

  it('keeps narrow non-message actions right-aligned without pagination', () => {
    const page = buildPage();
    const view = renderHeader(page, true, false, 'summary');
    rendered.push(view);

    expect(view.container.querySelector('[data-testid="pagination"]')).toBeNull();
    expect(view.container.querySelector('[aria-label="Налаштування аналізу"]')).not.toBeNull();
    expect(view.container.querySelector('[aria-label="Розгорнути праву панель"]')).not.toBeNull();
  });
});
