/**
 * @vitest-environment happy-dom
 */
import type { ComponentProps, ElementType, ReactNode } from 'react';
import React, { act, forwardRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTheme } from '@mui/material/styles';

import type { InboxMessage, InboxMessageMetadata, Network, Tag } from '../../../../../Bindings';
import { ELLIPSIS } from '../../../utils/misc';
import { inboxMessageWithMockImages } from '../../rer-duty-neo/inbox-message-mocks';
import { emptyFilter } from '../../rer-duty-neo/utils';
import { formatMessageCardTooltipTime, MessageCard } from './MessageCard';
import { MessageCardHeader } from './MessageCardHeader';
import {
  normalizeLocationDisplayValue,
  resolveEtalonBindingDisplayValue,
  resolveMessageCardEtalonDisplayModel,
} from './message-card.utils';

const COPY_TITLE = `Копіювати${ELLIPSIS}`;
const NAVIGATE_TITLE = `Перейти${ELLIPSIS}`;
const EXCLUDE_TITLE = `Виключити${ELLIPSIS}`;

type PrimitiveProps = { children?: ReactNode; component?: string } & Record<string, unknown>;

function omitMuiLayoutProps(props: Record<string, unknown>) {
  const clone = { ...props };
  delete clone.sx;
  delete clone.spacing;
  delete clone.direction;
  delete clone.alignItems;
  delete clone.justifyContent;
  delete clone.fullWidth;
  delete clone.useFlexGap;
  delete clone.flexWrap;
  delete clone.divider;
  delete clone.noWrap;
  delete clone.endIcon;
  delete clone.variant;
  delete clone.underline;
  delete clone.color;
  delete clone.onChange;
  delete clone.onKeyDown;
  delete clone.anchorEl;
  delete clone.onClose;
  delete clone.open;
  delete clone.anchorOrigin;
  delete clone.transformOrigin;
  delete clone.disablePortal;
  delete clone.disableAutoFocus;
  delete clone.disableEnforceFocus;
  delete clone.disableRestoreFocus;
  delete clone.keepMounted;
  delete clone.marginThreshold;
  delete clone.transitionDuration;
  delete clone.PaperProps;
  delete clone.MenuListProps;
  delete clone.slotProps;
  return clone;
}

vi.mock('@mui/icons-material/ExpandMore', () => ({
  default: () => <span>expand</span>,
}));

vi.mock('@mui/icons-material/ExpandLess', () => ({
  default: () => <span>collapse</span>,
}));

/** Narrow width for tag-row measurement in compact layout (MessageCardTagChips `useLayoutEffect`). */
const TAG_ROW_MEASURE_WIDTH_PX = 200;
const LIGHT_CARD_BG = '#F8F9FB';

function normalizeCssColor(value: string): { r: number; g: number; b: number; a: number } {
  const trimmed = value.trim();
  if (trimmed.startsWith('#')) {
    const hex = trimmed.slice(1);
    const normalized = hex.length === 3 ? hex.split('').map((part) => part + part).join('') : hex;
    return {
      r: Number.parseInt(normalized.slice(0, 2), 16),
      g: Number.parseInt(normalized.slice(2, 4), 16),
      b: Number.parseInt(normalized.slice(4, 6), 16),
      a: 1,
    };
  }
  const rgbaMatch = trimmed.match(/^rgba?\(([^)]+)\)$/i);
  if (!rgbaMatch) throw new Error(`Unsupported color format: ${value}`);
  const parts = rgbaMatch[1].split(',').map((part) => part.trim());
  return {
    r: Number.parseFloat(parts[0]),
    g: Number.parseFloat(parts[1]),
    b: Number.parseFloat(parts[2]),
    a: parts[3] != null ? Number.parseFloat(parts[3]) : 1,
  };
}

function compositeOver(fg: { r: number; g: number; b: number; a: number }, bg: { r: number; g: number; b: number; a: number }) {
  const alpha = fg.a + bg.a * (1 - fg.a);
  return {
    r: Math.round((fg.r * fg.a + bg.r * bg.a * (1 - fg.a)) / alpha),
    g: Math.round((fg.g * fg.a + bg.g * bg.a * (1 - fg.a)) / alpha),
    b: Math.round((fg.b * fg.a + bg.b * bg.a * (1 - fg.a)) / alpha),
    a: alpha,
  };
}

function relativeLuminance({ r, g, b }: { r: number; g: number; b: number }): number {
  const srgb = [r, g, b].map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * srgb[0] + 0.7152 * srgb[1] + 0.0722 * srgb[2];
}

function contrastRatio(fg: string, bg: string): number {
  const foreground = normalizeCssColor(fg);
  const background = normalizeCssColor(bg);
  const composed = foreground.a < 1 ? compositeOver(foreground, background) : foreground;
  const fgLum = relativeLuminance(composed);
  const bgLum = relativeLuminance(background);
  const lighter = Math.max(fgLum, bgLum);
  const darker = Math.min(fgLum, bgLum);
  return (lighter + 0.05) / (darker + 0.05);
}

vi.mock('@mui/material', () => ({
  Box: forwardRef<HTMLElement, PrimitiveProps>(({ children, component, ...props }, ref) => {
    const Comp = (component ?? 'div') as ElementType;
    return (
      <Comp ref={ref} {...omitMuiLayoutProps(props)}>
        {children}
      </Comp>
    );
  }),
  Button: ({
    children,
    startIcon,
    endIcon,
    ...props
  }: { children?: ReactNode; startIcon?: ReactNode; endIcon?: ReactNode } & Record<string, unknown>) => (
    <button {...omitMuiLayoutProps(props)}>
      {startIcon}
      <span>{children}</span>
      {endIcon}
    </button>
  ),
  ButtonGroup: ({ children, component, ...props }: PrimitiveProps) => {
    const Component = component ?? 'div';
    return <Component {...omitMuiLayoutProps(props)}>{children}</Component>;
  },
  CircularProgress: () => <span>tags-loading</span>,
  Collapse: ({ children, in: open }: { children?: ReactNode; in?: boolean }) => (open ? <>{children}</> : null),
  Chip: ({ label, onClick, onDelete }: { label?: ReactNode; onClick?: () => void; onDelete?: () => void }) => (
    <span>
      <button type="button" onClick={onClick}>
        {label}
      </button>
      {onDelete ? (
        <button type="button" onClick={onDelete} aria-label={`delete-${String(label)}`}>
          delete
        </button>
      ) : null}
    </span>
  ),
  IconButton: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => (
    <button {...omitMuiLayoutProps(props)}>{children}</button>
  ),
  Link: ({ children, href, ...props }: { children?: ReactNode; href?: string } & Record<string, unknown>) => (
    <a href={href} {...omitMuiLayoutProps(props)}>
      {children}
    </a>
  ),
  Popover: ({ children, open, ...props }: { children?: ReactNode; open?: boolean } & Record<string, unknown>) =>
    open ? <div {...omitMuiLayoutProps(props)}>{children}</div> : null,
  Menu: ({ children, open, ...props }: { children?: ReactNode; open?: boolean } & Record<string, unknown>) =>
    open ? <div {...omitMuiLayoutProps(props)}>{children}</div> : null,
  MenuItem: ({
    children,
    component,
    href,
    target,
    rel,
    onClick,
    ...props
  }: {
    children?: ReactNode;
    component?: string;
    href?: string;
    target?: string;
    rel?: string;
    onClick?: () => void;
  } & Record<string, unknown>) => {
    const Component = (component ?? 'button') as ElementType;
    return (
      <Component
        {...(Component === 'button' ? { type: 'button' } : {})}
        href={href}
        target={target}
        rel={rel}
        onClick={onClick}
        {...omitMuiLayoutProps(props)}
      >
        {children}
      </Component>
    );
  },
  Stack: ({ children, component, ...props }: PrimitiveProps) => {
    const Component = component ?? 'div';
    return <Component {...omitMuiLayoutProps(props)}>{children}</Component>;
  },
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TextField: ({
    label,
    value,
    onChange,
    onKeyDown,
    placeholder,
    inputProps,
    ...props
  }: {
    label?: ReactNode;
    value?: string;
    onChange?: (event: { target: { value: string } }) => void;
    onKeyDown?: (event: { key: string; preventDefault: () => void }) => void;
    placeholder?: string;
    inputProps?: Record<string, unknown>;
  } & Record<string, unknown>) => (
    <label>
      <span>{label}</span>
      <input
        placeholder={placeholder}
        value={value ?? ''}
        onChange={(event) => onChange?.({ target: { value: event.currentTarget.value } })}
        onKeyDown={(event) => onKeyDown?.({ key: event.key, preventDefault: () => event.preventDefault() })}
        {...(inputProps ?? {})}
        {...omitMuiLayoutProps(props)}
      />
    </label>
  ),
  Typography: ({ children, component, ...props }: PrimitiveProps) => {
    const Component = component ?? 'div';
    return <Component {...omitMuiLayoutProps(props)}>{children}</Component>;
  },
}));

vi.mock('../../../components/PowerChip', () => ({
  PowerChip: ({
    label,
    onDelete,
    onClick,
  }: {
    label: ReactNode;
    onClick?: () => void;
    onDelete?: () => void;
  }) =>
    (
      <span>
        <button type="button" onClick={onClick}>
          {label}
        </button>
        {onDelete ? (
          <button type="button" onClick={onDelete} aria-label={`delete-${String(label)}`}>
            delete
          </button>
        ) : null}
      </span>
    ),
}));

vi.mock('./useRelativeTimeDisplayMs', () => ({
  useRelativeTimeDisplayMs: () => [null, 1_710_000_000_000],
}));

vi.mock('./MarkedText', () => ({
  renderMarkedText: (_nodes: unknown, text: string) => [text],
}));

type Rendered = {
  container: HTMLDivElement;
  root: Root;
  props?: ComponentProps<typeof MessageCard>;
};

type ResizeObserverCallback = () => void;

const resizeObserverCallbacks: ResizeObserverCallback[] = [];

class ResizeObserverMock {
  constructor(private readonly callback: ResizeObserverCallback) {
    resizeObserverCallbacks.push(callback);
  }

  observe() {}

  disconnect() {}
}

function buildMessage(overrides: Partial<InboxMessage> = {}): InboxMessage {
  return {
    text: 'Повідомлення для перевірки вузького макета',
    freq: '153.6250',
    bookmarked: false,
    important: false,
    extendedForm: 'Коментар',
    sender: 'sender-1',
    groupMasterKey: 'group-1',
    networkIds: [7],
    tags: [3, 4, 5, 6, 7, 8, 9],
    inboxTags: [{ id: 1, tagId: 3, confidence: 1, login: 'tester', model: null, organismId: null }],
    timestamp: 1_709_999_940_000,
    time: '02:45',
    date: '2026-03-23',
    callsigns: ['ALPHA'],
    callsignsAlg2: ['ALPHA', 'BRAVO'],
    location: 'ЛИМАН ПЕРШИЙ',
    pointTokens: [],
    textMarked: [],
    metadata: [],
    ...overrides,
  } as InboxMessage;
}

function buildMetadata(overrides: Partial<InboxMessageMetadata> = {}): InboxMessageMetadata {
  return {
    colorCode: null,
    colorCodeStartIndex: null,
    colorCodeEndIndex: null,
    callGroupId: null,
    callGroupIdStartIndex: null,
    callGroupIdEndIndex: null,
    callGroupName: null,
    callGroupNameStartIndex: null,
    callGroupNameEndIndex: null,
    senderId: null,
    senderIdStartIndex: null,
    senderIdEndIndex: null,
    senderName: null,
    senderNameStartIndex: null,
    senderNameEndIndex: null,
    hashId: null,
    hashIdStartIndex: null,
    hashIdEndIndex: null,
    ...overrides,
  };
}

async function renderCard(overrides: Partial<ComponentProps<typeof MessageCard>> = {}): Promise<Rendered> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const tagsMap = {
    3: { id: 3, label: 'переміщення', isPalitra: false },
    4: { id: 4, label: 'зв’язок', isPalitra: false },
    5: { id: 5, label: 'РЕБ', isPalitra: false },
    6: { id: 6, label: 'арта', isPalitra: false },
    7: { id: 7, label: 'палітра', isPalitra: false },
    8: { id: 8, label: 'іфо', isPalitra: false },
    9: { id: 9, label: 'розвідка', isPalitra: false },
  } as Record<number, Tag>;
  const networkMap = { 7: { id: 7, name: 'Alpha', unitIds: [], location: null } as Network };
  const props: ComponentProps<typeof MessageCard> = {
    id: 42,
    msg: buildMessage(),
    feedCount: 3,
    referenceTimeMs: 1_710_000_000_000,
    authUserName: 'tester',
    groupName: "Куп'янськ пеленг",
    senderName: 'Dow_Jones_2',
    copiedFeedbackId: null,
    networkDisplayMap: { 7: 'р/м Alpha' },
    networkMap,
    tagsMap,
    filterState: emptyFilter(),
    onBookmark: vi.fn(),
    onImportant: vi.fn(),
    onCopyText: vi.fn(),
    onCopyFreq: vi.fn(),
    onCopyEtalon: vi.fn(),
    onCopyLocation: vi.fn(),
    onAddFrequencyToFilter: vi.fn(),
    onComment: vi.fn(),
    onExcludeMessageEntity: vi.fn(),
    onToggleTag: vi.fn(),
    ...overrides,
  };

  await act(async () => {
    root.render(<MessageCard {...props} />);
  });

  return { container, root, props };
}

async function renderHeader(overrides: Partial<ComponentProps<typeof MessageCardHeader>> = {}): Promise<Rendered> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const msg = buildMessage();
  const etalonDisplayModel = resolveMessageCardEtalonDisplayModel(msg, {
    featureStrictNetworks: false,
    networkDisplayMap: { 7: 'р/м Alpha' },
    networkMap: { 7: { id: 7, name: 'Alpha', unitIds: [], location: null } as Network },
    networks: undefined,
  });
  const props: ComponentProps<typeof MessageCardHeader> = {
    compact: true,
    displayMode: 'duty',
    excludeMenuOptions: [],
    networkRowContentWidthPct: 90,
    id: 42,
    msg,
    copiedFeedbackId: null,
    groupName: "Куп'янськ пеленг",
    senderName: 'Dow_Jones_2',
    etalonDisplayModel,
    mapHref: undefined,
    analysisHref: undefined,
    rightInsetPx: 0,
    topRight: <div />,
    onBookmark: vi.fn(),
    onImportant: vi.fn(),
    onComment: vi.fn(),
    onCopyText: vi.fn(),
    onCopyFreq: vi.fn(),
    onCopyEtalon: vi.fn(),
    onCopyLocation: vi.fn(),
    onAddFrequencyToFilter: vi.fn(),
    onDelete: vi.fn(),
    onEditDetails: vi.fn(),
    onExcludeMessageEntity: vi.fn(),
    ...overrides,
  };

  await act(async () => {
    root.render(<MessageCardHeader {...props} />);
  });

  return { container, root };
}

function setClientWidth(element: HTMLElement, width: number) {
  Object.defineProperty(element, 'clientWidth', {
    configurable: true,
    value: width,
  });
}

function getButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.includes(label));
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Button not found: ${label}`);
  return button;
}

function getTagButtonLabels(container: HTMLElement): string[] {
  const tagLabels = new Set(['переміщення', 'зв’язок', 'РЕБ', 'арта', 'палітра', 'іфо', 'розвідка']);
  return Array.from(container.querySelectorAll('button'))
    .map((button) => button.textContent?.trim() ?? '')
    .filter((label) => tagLabels.has(label));
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

async function setInputValue(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('MessageCard', () => {
  const rendered: Rendered[] = [];

  beforeEach(() => {
    const storage = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        },
        removeItem: (key: string) => {
          storage.delete(key);
        },
        clear: () => {
          storage.clear();
        },
      },
    });
  });

  afterEach(() => {
    resizeObserverCallbacks.splice(0);
    if (typeof window.localStorage?.clear === 'function') {
      window.localStorage.clear();
    }
    for (const item of rendered.splice(0)) {
      act(() => {
        item.root.unmount();
      });
      item.container.remove();
    }
    vi.unstubAllGlobals();
  });

  it('resolves etalon display and copy values consistently', () => {
    expect(
      resolveEtalonBindingDisplayValue(buildMessage({ networkIds: [], unit: ' 1-й танк ' }), {
        featureStrictNetworks: false,
      }),
    ).toEqual({
      displayValue: '1-й танк',
      copyValue: '1-й танк',
    });
    expect(
      resolveEtalonBindingDisplayValue(buildMessage({ unit: null }), {
        featureStrictNetworks: false,
      }),
    ).toEqual({
      displayValue: '—',
      copyValue: null,
    });
    expect(
      resolveEtalonBindingDisplayValue(buildMessage({ unit: '1-й танк' }), {
        featureStrictNetworks: true,
      }),
    ).toEqual({
      displayValue: '—',
      copyValue: null,
    });
    expect(
      resolveEtalonBindingDisplayValue(buildMessage({ networkIds: [123], unit: '1-й танк' }), {
        networkMap: {},
        networkDisplayMap: {},
      }),
    ).toEqual({
      displayValue: '—',
      copyValue: null,
    });
  });

  it('resolves the shared etalon and location display model with normalized display values', () => {
    expect(
      resolveMessageCardEtalonDisplayModel(buildMessage({ networkIds: [], location: '  ПІЩАНКА  ' }), {
        featureStrictNetworks: false,
      }),
    ).toMatchObject({
      primaryKind: 'location',
      displayValue: 'Піщанка',
      copyEtalonValue: null,
      copyLocationValue: 'Піщанка',
      showInlineLocationTooltip: false,
      locationDisplayValue: 'Піщанка',
    });
    expect(normalizeLocationDisplayValue('ЛИМАН ПЕРШИЙ')).toBe('Лиман Перший');
    expect(
      resolveMessageCardEtalonDisplayModel(buildMessage({ networkIds: [], unit: ' 1-й танк ', location: null }), {
        featureStrictNetworks: false,
      }),
    ).toMatchObject({
      primaryKind: 'unit',
      displayValue: '1-й танк',
      copyEtalonValue: '1-й танк',
      copyLocationValue: null,
      showInlineLocationTooltip: false,
    });
    expect(
      resolveMessageCardEtalonDisplayModel(buildMessage({ networkIds: [], unit: null, location: 'Не встановлена' }), {
        featureStrictNetworks: true,
      }),
    ).toMatchObject({
      primaryKind: 'empty',
      displayValue: '—',
      copyEtalonValue: null,
      copyLocationValue: null,
      showInlineLocationTooltip: false,
    });
  });

  it('renders compact divider layout content for narrow multi-feed columns', async () => {
    const view = await renderCard();
    rendered.push(view);

    expect(view.container.textContent).toContain("Куп'янськ пеленг");
    expect(view.container.textContent).toContain('Dow_Jones_2');
    expect(view.container.textContent).toContain('153.6250');
    expect(view.container.textContent).toContain('Повідомлення для перевірки вузького макета');
    expect(view.container.textContent).toContain('Коментар');
    expect(view.container.textContent).toContain('переміщення');
    expect(view.container.querySelector(`button[aria-label="${NAVIGATE_TITLE}"]`)).not.toBeNull();
    expect(view.container.querySelector('button[aria-label="Відкрити аналіз"]')).toBeNull();
    expect(view.container.querySelector('button[aria-label="Відкрити мапу"]')).toBeNull();
  });

  it('renders the network label in the header as bold text', async () => {
    const view = await renderHeader();
    rendered.push(view);

    const networkLabel = Array.from(view.container.querySelectorAll('strong')).find((element) =>
      element.textContent?.includes('р/м Alpha'),
    );

    expect(networkLabel).not.toBeNull();
    expect(networkLabel?.textContent).toBe('р/м Alpha');
  });

  it('renders duty actions with timer and the shared navigation menu button', async () => {
    const view = await renderCard();
    rendered.push(view);

    expect(view.container.textContent).toContain('1 хв');
    expect(view.container.textContent).not.toContain('Відкрити аналіз');
    expect(view.container.textContent).not.toContain('Відкрити мапу');
    expect(view.container.querySelector(`button[aria-label="${NAVIGATE_TITLE}"]`)).not.toBeNull();
    expect(view.container.querySelector('button[aria-label="Відкрити аналіз"]')).toBeNull();
    expect(view.container.querySelector('button[aria-label="Відкрити мапу"]')).toBeNull();
    expect(view.container.querySelector(`button[aria-label="${EXCLUDE_TITLE}"]`)).not.toBeNull();
  });

  it('shows normalized DMR metadata in analysis mode when metadata exists', async () => {
    const view = await renderCard({
      displayMode: 'analysis',
      msg: buildMessage({
        metadata: [
          buildMetadata({
            colorCode: ' 3 ',
            senderId: ' 123 ',
            senderName: ' Alpha ',
            callGroupId: ' 456 ',
            callGroupName: ' Bravo ',
            hashId: ' hash-1 ',
          }),
          buildMetadata({
            colorCode: '3',
            senderId: '123',
            senderName: 'Alpha',
            callGroupId: '456',
            callGroupName: 'Bravo',
            hashId: 'hash-1',
          }),
        ],
      }),
    });
    rendered.push(view);

    const trigger = view.container.querySelector('button[aria-label="DMR метадані"]');
    if (!(trigger instanceof HTMLButtonElement)) throw new Error('dmr metadata trigger not found');
    await click(trigger);

    expect(view.container.textContent).toContain('DMR метадані');
    expect(view.container.textContent).toContain('CC');
    expect(view.container.textContent).toContain('3');
    expect(view.container.textContent).toContain('Відправник');
    expect(view.container.textContent).toContain('123 / Alpha');
    expect(view.container.textContent).toContain('Група');
    expect(view.container.textContent).toContain('456 / Bravo');
    expect(view.container.textContent).toContain('Хеш');
    expect(view.container.textContent).toContain('hash-1');
  });

  it('hides the DMR metadata trigger in analysis mode when metadata is absent', async () => {
    const view = await renderCard({
      displayMode: 'analysis',
      msg: buildMessage({ metadata: [] }),
    });
    rendered.push(view);

    expect(view.container.querySelector('button[aria-label="DMR метадані"]')).toBeNull();
  });

  it('hides the DMR metadata trigger in duty mode even when metadata exists', async () => {
    const view = await renderCard({
      msg: buildMessage({
        metadata: [
          buildMetadata({
            colorCode: ' 3 ',
            senderId: ' 123 ',
            senderName: ' Alpha ',
          }),
        ],
      }),
    });
    rendered.push(view);

    expect(view.container.querySelector('button[aria-label="DMR метадані"]')).toBeNull();
  });

  it('uses the timestamp for minute-only hover time so seconds are preserved', () => {
    const tooltipTime = formatMessageCardTooltipTime({ time: '02:45', timestamp: 1_710_000_000_000 } as InboxMessage);
    expect(tooltipTime).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(tooltipTime).not.toBe('02:45');
  });

  it('opens the duty navigation menu and routes the old destinations through it', async () => {
    const view = await renderCard({
      msg: { ...buildMessage(), messageUid: 'uid-1' },
    });
    rendered.push(view);

    const navigateButton = view.container.querySelector(`button[aria-label="${NAVIGATE_TITLE}"]`);
    if (!(navigateButton instanceof HTMLButtonElement)) throw new Error('navigate button not found');
    expect(navigateButton.getAttribute('aria-haspopup')).toBe('menu');
    await click(navigateButton);
    expect(navigateButton.getAttribute('aria-expanded')).toBe('true');

    const networkLinks = Array.from(view.container.querySelectorAll('a[href^="/rer-networks/"]'));
    expect(networkLinks).toHaveLength(1);
    expect(networkLinks[0]?.textContent).toContain('В мережу');
    expect(networkLinks[0]?.textContent).toContain('р/м Alpha');
    expect(networkLinks[0]?.getAttribute('target')).toBe('_blank');
    expect(networkLinks[0]?.getAttribute('rel')).toBe('noopener noreferrer');

    const networkUrl = new URL(String(networkLinks[0]?.getAttribute('href') ?? ''), 'https://example.test');
    expect(networkUrl.pathname).toBe('/rer-networks/7');

    const mapLink = Array.from(view.container.querySelectorAll('a')).find((link) => link.textContent?.includes('На мапу'));
    if (!(mapLink instanceof HTMLAnchorElement)) throw new Error('map link not found');
    const mapUrl = new URL(String(mapLink.getAttribute('href') ?? ''), 'https://example.test');
    expect(mapUrl.pathname).toBe('/rer-analysis');
    expect(mapUrl.searchParams.get('showMap')).toBe('true');
    expect(JSON.parse(mapUrl.searchParams.get('state') ?? '')).toMatchObject({
      search: 'uid-1',
    });
    expect(mapLink.getAttribute('target')).toBe('_blank');
    expect(mapLink.getAttribute('rel')).toBe('noopener noreferrer');

    const analysisLink = Array.from(view.container.querySelectorAll('a')).find((link) =>
      link.textContent?.includes('В аналіз'),
    );
    if (!(analysisLink instanceof HTMLAnchorElement)) throw new Error('analysis link not found');
    const analysisUrl = new URL(String(analysisLink.getAttribute('href') ?? ''), 'https://example.test');
    expect(analysisUrl.pathname).toBe('/rer-analysis');
    expect(JSON.parse(analysisUrl.searchParams.get('state') ?? '')).toMatchObject({
      search: 'uid-1',
    });
    expect(analysisLink.getAttribute('target')).toBe('_blank');
    expect(analysisLink.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('uses the stored classic preference for network drill-down links', async () => {
    window.localStorage.setItem('rer-network-details.preferredView', 'classic');
    const view = await renderCard({
      msg: { ...buildMessage(), messageUid: 'uid-1' },
    });
    rendered.push(view);

    const navigateButton = view.container.querySelector(`button[aria-label="${NAVIGATE_TITLE}"]`);
    if (!(navigateButton instanceof HTMLButtonElement)) throw new Error('navigate button not found');
    await click(navigateButton);

    const networkUrl = new URL(
      String(view.container.querySelector('a[href^="/rer-networks/"]')?.getAttribute('href') ?? ''),
      'https://example.test',
    );
    expect(networkUrl.pathname).toBe('/rer-networks/7');
    expect(networkUrl.searchParams.get('view')).toBe('classic');
  });

  it('keeps analysis navigation limited to network destinations', async () => {
    const view = await renderCard({
      displayMode: 'analysis',
      msg: { ...buildMessage(), messageUid: 'uid-1' },
    });
    rendered.push(view);

    const navigateButton = view.container.querySelector(`button[aria-label="${NAVIGATE_TITLE}"]`);
    if (!(navigateButton instanceof HTMLButtonElement)) throw new Error('navigate button not found');
    await click(navigateButton);

    expect(view.container.textContent).toContain('В мережу');
    expect(view.container.textContent).not.toContain('На мапу');
    expect(view.container.textContent).not.toContain('В аналіз');
    expect(view.container.querySelector('a[href^="/rer-networks/"]')).not.toBeNull();
    expect(view.container.querySelector('a[href*="showMap=true"]')).toBeNull();
    expect(view.container.querySelector('a[href*="/rer-analysis?"]')).toBeNull();
  });

  it('keeps distinct network ids visible even when the rendered labels match', async () => {
    const view = await renderCard({
      msg: { ...buildMessage(), networkIds: [7, 8] },
      networkMap: {
        7: { id: 7, name: 'Alpha', unitIds: [], location: null } as Network,
        8: { id: 8, name: 'Alpha', unitIds: [], location: null } as Network,
      },
      networkDisplayMap: { 7: 'р/м Alpha', 8: 'р/м Alpha' },
    });
    rendered.push(view);

    expect(view.container.textContent).toContain('р/м Alpha');
    const navigateButton = view.container.querySelector(`button[aria-label="${NAVIGATE_TITLE}"]`);
    if (!(navigateButton instanceof HTMLButtonElement)) throw new Error('navigate button not found');
    await click(navigateButton);

    const networkLinks = Array.from(view.container.querySelectorAll('a[href^="/rer-networks/"]'));
    expect(networkLinks).toHaveLength(2);
    expect(networkLinks.map((link) => link.getAttribute('href'))).toEqual(['/rer-networks/7', '/rer-networks/8']);
  });

  it('renders the location as the primary etalon row when no networks resolve', async () => {
    const onCopyLocation = vi.fn();
    const view = await renderCard({
      msg: buildMessage({ networkIds: [], location: '  ПІЩАНКА  ' }),
      onCopyLocation,
    });
    rendered.push(view);

    expect(view.container.querySelector('a[href^="/rer-networks/"]')).toBeNull();
    expect(view.container.textContent).toContain('Піщанка');
    expect(view.container.querySelector('svg[data-testid="PlaceOutlinedIcon"]')).not.toBeNull();
    expect(view.container.querySelector('svg[data-testid="PeopleOutlineOutlinedIcon"]')).toBeNull();
    expect(view.container.querySelector('[aria-label^="Локація:"]')).toBeNull();
    const copyButton = view.container.querySelector(`button[aria-label="${COPY_TITLE}"]`);
    if (!(copyButton instanceof HTMLButtonElement)) throw new Error('copy button not found');
    await click(copyButton);
    expect(view.container.textContent).toContain('Копіювати локацію');
    await click(getButton(view.container, 'Копіювати локацію'));
    expect(onCopyLocation).toHaveBeenCalledTimes(1);
  });

  it('keeps the location tooltip inline when resolved networks exist', async () => {
    const view = await renderCard({
      msg: buildMessage({ location: 'ХАРКІВ', networkIds: [7] }),
    });
    rendered.push(view);

    expect(view.container.textContent).toContain('р/м Alpha');
    expect(view.container.querySelector('svg[data-testid="PeopleOutlineOutlinedIcon"]')).not.toBeNull();
    expect(view.container.querySelector('[aria-label^="Локація:"]')).not.toBeNull();
    const copyButton = view.container.querySelector(`button[aria-label="${COPY_TITLE}"]`);
    if (!(copyButton instanceof HTMLButtonElement)) throw new Error('copy button not found');
    await click(copyButton);
    expect(view.container.textContent).not.toContain('Копіювати локацію');
  });

  it('renders the unit fallback when no networks resolve and no real location exists', async () => {
    const view = await renderCard({
      msg: buildMessage({ networkIds: [], location: null, unit: ' 1-й танк ' }),
    });
    rendered.push(view);

    expect(view.container.textContent).toContain('1-й танк');
    expect(view.container.textContent).not.toContain('—');
    expect(view.container.querySelector('svg[data-testid="PeopleOutlineOutlinedIcon"]')).not.toBeNull();
    const copyButton = view.container.querySelector(`button[aria-label="${COPY_TITLE}"]`);
    if (!(copyButton instanceof HTMLButtonElement)) throw new Error('copy button not found');
    await click(copyButton);
    expect(view.container.textContent).toContain('Копіювати прив\'язку');
    expect(view.container.textContent).not.toContain('Копіювати локацію');
  });

  it('renders a dash when no networks resolve and location is missing or unset', async () => {
    const view = await renderCard({
      msg: buildMessage({ networkIds: [], location: 'Не встановлена' }),
    });
    rendered.push(view);

    expect(view.container.textContent).toContain('—');
    expect(view.container.querySelector('svg[data-testid="PeopleOutlineOutlinedIcon"]')).not.toBeNull();
    expect(view.container.querySelector('svg[data-testid="PlaceOutlinedIcon"]')).toBeNull();
    expect(view.container.querySelector('[aria-label^="Локація:"]')).toBeNull();
  });

  it('renders analysis actions without timer and with analysis-only callsign controls', async () => {
    const onAddCallsign = vi.fn().mockResolvedValue(true);
    const onRemoveCallsign = vi.fn().mockResolvedValue(true);
    const onAddSuggestedCallsign = vi.fn().mockResolvedValue(true);
    const view = await renderCard({
      displayMode: 'analysis',
      analysisCallsignActions: {
        onAddCallsign,
        onRemoveCallsign,
        onAddSuggestedCallsign,
      },
    });
    rendered.push(view);

    expect(view.container.textContent).not.toContain('1 хв');
    expect(view.container.textContent).not.toContain('Відкрити аналіз');
    expect(view.container.textContent).not.toContain('Відкрити мапу тут');
    expect(view.container.textContent).not.toContain('Відкрити мапу в новому вікні');
    expect(view.container.querySelector('button[aria-label="Відкрити мапу тут"]')).toBeNull();
    expect(view.container.querySelector('button[aria-label="Відкрити мапу в новому вікні"]')).toBeNull();
    expect(view.container.querySelector('button[aria-label="Виключити"]')).toBeNull();
    expect(view.container.querySelector('button[aria-label="Мінус"]')).toBeNull();
    expect(view.container.querySelector(`button[aria-label="${NAVIGATE_TITLE}"]`)).not.toBeNull();
    expect(view.container.textContent).toContain('Запропоновані позивні');
    expect(view.container.querySelector('input[placeholder="Позивний"]')).not.toBeNull();
    expect(view.container.textContent).toContain('ALPHA');
    expect(view.container.textContent).toContain('BRAVO');
    expect(view.container.textContent).toContain('перевірки вузького макета');

    const input = view.container.querySelector('input');
    if (!(input instanceof HTMLInputElement)) throw new Error('callsign input not found');
    await setInputValue(input, 'charlie');

    const addButton = Array.from(view.container.querySelectorAll('button')).find(
      (button) => button.getAttribute('aria-label') === 'Додати позивний',
    );
    if (addButton == null) throw new Error('add button not found');

    const removeButton = Array.from(view.container.querySelectorAll('button')).find(
      (button) => button.getAttribute('aria-label') === 'delete-ALPHA',
    );
    if (removeButton == null) throw new Error('remove button not found');
    await click(removeButton);
    expect(onRemoveCallsign).toHaveBeenCalledWith('ALPHA');

    const suggestedButton = Array.from(view.container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('BRAVO'),
    );
    if (suggestedButton == null) throw new Error('suggested button not found');
    await click(suggestedButton);
    expect(onAddSuggestedCallsign).toHaveBeenCalledWith('BRAVO');
  });

  it('orders duty toolbar actions as comment, important, bookmark, copy, navigate, minus', async () => {
    const view = await renderCard();
    rendered.push(view);

    const toolbar = view.container.querySelector('[aria-label="Дії повідомлення"]');
    if (!(toolbar instanceof HTMLElement)) throw new Error('toolbar not found');

    const labels = Array.from(toolbar.querySelectorAll('button')).map((button) => button.getAttribute('aria-label'));
    expect(labels).toEqual([
      'Редагувати коментар',
      'Позначити як важливе',
      'Додати в закладки',
      COPY_TITLE,
      NAVIGATE_TITLE,
      EXCLUDE_TITLE,
    ]);
  });

  it('orders analysis toolbar actions as comment, important, bookmark, copy, navigate, overflow', async () => {
    const view = await renderCard({
      displayMode: 'analysis',
      onEditDetails: vi.fn(),
      onDelete: vi.fn(),
    });
    rendered.push(view);

    const toolbar = view.container.querySelector('[aria-label="Дії повідомлення"]');
    if (!(toolbar instanceof HTMLElement)) throw new Error('toolbar not found');

    const labels = Array.from(toolbar.querySelectorAll('button')).map((button) => button.getAttribute('aria-label'));
    expect(labels).toEqual([
      'Редагувати коментар',
      'Позначити як важливе',
      'Додати в закладки',
      COPY_TITLE,
      NAVIGATE_TITLE,
      'Більше дій',
    ]);
  });

  it('keeps the compact duty toolbar inline when the action column still has room', async () => {
    vi.stubGlobal('ResizeObserver', ResizeObserverMock as unknown as typeof ResizeObserver);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    const view = await renderHeader();
    rendered.push(view);

    const toolbar = view.container.querySelector('[aria-label="Дії повідомлення"]');
    if (!(toolbar instanceof HTMLElement)) throw new Error('toolbar not found');
    const root = toolbar.parentElement;
    if (!(root instanceof HTMLElement)) throw new Error('toolbar root not found');

    setClientWidth(root, 240);
    await act(async () => {
      resizeObserverCallbacks.at(-1)?.();
    });

    const updatedToolbar = view.container.querySelector('[aria-label="Дії повідомлення"]');
    if (!(updatedToolbar instanceof HTMLElement)) throw new Error('toolbar not found after resize');
    expect(updatedToolbar.getAttribute('role')).toBeNull();
  });

  it('ignores hidden width measurements before wrapping the compact duty toolbar', async () => {
    vi.stubGlobal('ResizeObserver', ResizeObserverMock as unknown as typeof ResizeObserver);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    const view = await renderHeader();
    rendered.push(view);

    const toolbar = view.container.querySelector('[aria-label="Дії повідомлення"]');
    if (!(toolbar instanceof HTMLElement)) throw new Error('toolbar not found');
    const root = toolbar.parentElement;
    if (!(root instanceof HTMLElement)) throw new Error('toolbar root not found');

    setClientWidth(root, 240);
    await act(async () => {
      resizeObserverCallbacks.at(-1)?.();
    });

    const inlineToolbar = view.container.querySelector('[aria-label="Дії повідомлення"]');
    if (!(inlineToolbar instanceof HTMLElement)) throw new Error('toolbar not found after inline resize');
    expect(inlineToolbar.getAttribute('role')).toBeNull();

    setClientWidth(root, 0);
    await act(async () => {
      resizeObserverCallbacks.at(-1)?.();
    });

    const hiddenToolbar = view.container.querySelector('[aria-label="Дії повідомлення"]');
    if (!(hiddenToolbar instanceof HTMLElement)) throw new Error('toolbar not found after hidden resize');
    expect(hiddenToolbar.getAttribute('role')).toBeNull();

    setClientWidth(root, 180);
    await act(async () => {
      resizeObserverCallbacks.at(-1)?.();
    });

    const wrappedToolbar = view.container.querySelector('[aria-label="Дії повідомлення"]');
    if (!(wrappedToolbar instanceof HTMLElement)) throw new Error('toolbar not found after narrow resize');
    expect(wrappedToolbar.getAttribute('role')).toBe('group');
  });

  it('wraps the compact duty toolbar into a 3-column grid when the action column is narrow', async () => {
    vi.stubGlobal('ResizeObserver', ResizeObserverMock as unknown as typeof ResizeObserver);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    const view = await renderHeader();
    rendered.push(view);

    const toolbar = view.container.querySelector('[aria-label="Дії повідомлення"]');
    if (!(toolbar instanceof HTMLElement)) throw new Error('toolbar not found');
    const root = toolbar.parentElement;
    if (!(root instanceof HTMLElement)) throw new Error('toolbar root not found');

    setClientWidth(root, 180);
    await act(async () => {
      resizeObserverCallbacks.at(-1)?.();
    });

    const updatedToolbar = view.container.querySelector('[aria-label="Дії повідомлення"]');
    if (!(updatedToolbar instanceof HTMLElement)) throw new Error('toolbar not found after resize');
    expect(updatedToolbar.getAttribute('role')).toBe('group');
    expect(updatedToolbar.getAttribute('data-action-grid-columns')).toBe('3');
  });

  it('hides overflow in duty mode when no edit or delete actions are available', async () => {
    const view = await renderCard();
    rendered.push(view);

    expect(view.container.querySelector('button[aria-label="Більше дій"]')).toBeNull();
  });

  it('shows only edit and delete in the overflow menu when those handlers exist', async () => {
    const view = await renderCard({
      onEditDetails: vi.fn(),
      onDelete: vi.fn(),
    });
    rendered.push(view);

    const overflowButton = view.container.querySelector('button[aria-label="Більше дій"]');
    if (!(overflowButton instanceof HTMLButtonElement)) throw new Error('overflow button not found');
    await click(overflowButton);

    expect(view.container.textContent).toContain('Редагувати додаткові поля та позивні');
    expect(view.container.textContent).toContain('Видалити');
    expect(view.container.textContent).not.toContain('Позначити як важливе');
    expect(view.container.textContent).not.toContain('Додати в закладки');
  });

  it('renders inactive and active important and bookmark icons in the toolbar', async () => {
    const view = await renderCard();
    rendered.push(view);

    expect(view.container.querySelector('svg[data-testid="FlagOutlinedIcon"]')).not.toBeNull();
    expect(view.container.querySelector('svg[data-testid="BookmarkBorderOutlinedIcon"]')).not.toBeNull();

    const activeView = await renderCard({
      msg: buildMessage({ important: true, bookmarked: true }),
    });
    rendered.push(activeView);

    expect(activeView.container.querySelector('svg[data-testid="FlagIcon"]')).not.toBeNull();
    expect(activeView.container.querySelector('svg[data-testid="BookmarkIcon"]')).not.toBeNull();
  });

  it('renders the frequency filter button when frequency is present and calls the handler', async () => {
    const onAddFrequencyToFilter = vi.fn();
    const view = await renderCard({
      onAddFrequencyToFilter,
    });
    rendered.push(view);

    const filterButton = view.container.querySelector('button[aria-label="В фільтр"]');
    if (!(filterButton instanceof HTMLButtonElement)) throw new Error('frequency filter button not found');
    await click(filterButton);

    expect(onAddFrequencyToFilter).toHaveBeenCalledWith('153.6250');
  });

  it('hides the frequency filter button when frequency is missing or blank', async () => {
    const view = await renderCard({
      msg: buildMessage({ freq: '   ' }),
      onAddFrequencyToFilter: vi.fn(),
    });
    rendered.push(view);

    expect(view.container.querySelector('button[aria-label="В фільтр"]')).toBeNull();
  });

  it('uses the selected important and bookmark labels in the toolbar', async () => {
    const view = await renderCard({
      msg: buildMessage({ important: true, bookmarked: true }),
    });
    rendered.push(view);

    expect(view.container.querySelector('button[aria-label="Позначити як не важливе"]')).not.toBeNull();
    expect(view.container.querySelector('button[aria-label="Прибрати з закладок"]')).not.toBeNull();
  });

  it('calls the toolbar important/bookmark actions and the overflow edit/delete actions', async () => {
    const onImportant = vi.fn();
    const onBookmark = vi.fn();
    const onEditDetails = vi.fn();
    const onDelete = vi.fn();
    const view = await renderCard({
      onImportant,
      onBookmark,
      onEditDetails,
      onDelete,
    });
    rendered.push(view);

    const overflowButton = view.container.querySelector('button[aria-label="Більше дій"]');
    if (!(overflowButton instanceof HTMLButtonElement)) throw new Error('overflow button not found');

    const importantButton = view.container.querySelector('button[aria-label="Позначити як важливе"]');
    if (!(importantButton instanceof HTMLButtonElement)) throw new Error('important button not found');
    await click(importantButton);
    expect(onImportant).toHaveBeenCalledTimes(1);

    const bookmarkButton = view.container.querySelector('button[aria-label="Додати в закладки"]');
    if (!(bookmarkButton instanceof HTMLButtonElement)) throw new Error('bookmark button not found');
    await click(bookmarkButton);
    expect(onBookmark).toHaveBeenCalledTimes(1);

    await click(overflowButton);
    await click(getButton(view.container, 'Редагувати додаткові поля та позивні'));
    expect(onEditDetails).toHaveBeenCalledTimes(1);

    await click(overflowButton);
    await click(getButton(view.container, 'Видалити'));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('omits edit and delete from the overflow menu when handlers are absent', async () => {
    const view = await renderCard();
    rendered.push(view);

    expect(view.container.querySelector('button[aria-label="Більше дій"]')).toBeNull();
    expect(view.container.textContent).not.toContain('Редагувати додаткові поля та позивні');
    expect(view.container.textContent).not.toContain('Видалити');
  });

  it('opens the copy menu and routes message, frequency, and etalon copies through the shared handlers', async () => {
    const onCopyText = vi.fn();
    const onCopyFreq = vi.fn();
    const onCopyEtalon = vi.fn();
    const view = await renderCard({
      msg: buildMessage({ unit: '1-й танк' }),
      onCopyText,
      onCopyFreq,
      onCopyEtalon,
    });
    rendered.push(view);

    expect(view.container.querySelector(`button[aria-label="${COPY_TITLE}"]`)).not.toBeNull();
    expect(view.container.querySelector('button[aria-label="Копіювати частоту"]')).toBeNull();

    const copyButton = view.container.querySelector(`button[aria-label="${COPY_TITLE}"]`);
    if (!(copyButton instanceof HTMLButtonElement)) throw new Error('copy button not found');
    await click(copyButton);

    expect(view.container.textContent).toContain('Копіювати повідомлення');
    expect(view.container.textContent).toContain('Копіювати частоту');
    expect(view.container.textContent).toContain('Копіювати прив\'язку');

    await click(getButton(view.container, 'Копіювати повідомлення'));
    expect(onCopyText).toHaveBeenCalledTimes(1);

    await click(copyButton);
    await click(getButton(view.container, 'Копіювати частоту'));
    expect(onCopyFreq).toHaveBeenCalledTimes(1);

    await click(copyButton);
    await click(getButton(view.container, 'Копіювати прив\'язку'));
    expect(onCopyEtalon).toHaveBeenCalledTimes(1);
  });

  it('hides the frequency and etalon copy items when values are missing', async () => {
    const view = await renderCard({
      msg: buildMessage({ freq: null, unit: null, networkIds: [] }),
    });
    rendered.push(view);

    const copyButton = view.container.querySelector(`button[aria-label="${COPY_TITLE}"]`);
    if (!(copyButton instanceof HTMLButtonElement)) throw new Error('copy button not found');
    await click(copyButton);

    expect(view.container.textContent).toContain('Копіювати повідомлення');
    expect(view.container.textContent).not.toContain('Копіювати частоту');
    expect(view.container.textContent).not.toContain('Копіювати прив\'язку');
    expect(view.container.textContent).toContain('—');
    expect(view.container.textContent).not.toContain('Не встановлена');
  });

  it('opens the exclude menu and applies the selected exclusion', async () => {
    const onExcludeMessageEntity = vi.fn();
    const view = await renderCard({
      msg: { ...buildMessage(), post: 'POST-1' },
      onExcludeMessageEntity,
    });
    rendered.push(view);

    const excludeButton = view.container.querySelector(`button[aria-label="${EXCLUDE_TITLE}"]`);
    if (!(excludeButton instanceof HTMLButtonElement)) throw new Error('exclude button not found');
    await click(excludeButton);

    const excludeGroupButton = Array.from(view.container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Виключити групу'),
    );
    if (excludeGroupButton == null) throw new Error('exclude group menu item not found');
    await click(excludeGroupButton);

    expect(onExcludeMessageEntity).toHaveBeenCalledWith('group', 'group-1');
    expect(view.container.textContent).not.toContain('Виключити групу');
  });

  it('hides the exclude button when every visible entity is already excluded', async () => {
    const view = await renderCard({
      msg: { ...buildMessage(), post: 'POST-1' },
      filterState: {
        ...emptyFilter(),
        groupsDenied: ['group-1'],
        deniedSenders: ['sender-1'],
        freqsDenied: ['153.6250'],
        postsDenied: ['POST-1'],
      },
    });
    rendered.push(view);

    expect(view.container.querySelector(`button[aria-label="${EXCLUDE_TITLE}"]`)).toBeNull();
  });

  it('renders provided analysis comments', async () => {
    const view = await renderCard({
      displayMode: 'analysis',
      messageComments: [
        { id: 11, messageId: 42, comment: 'visible comment', login: 'peer-login' },
        { id: 12, messageId: 42, comment: 'hidden comment', login: 'tester' },
      ],
    });
    rendered.push(view);

    expect(view.container.textContent).toContain('visible comment');
    expect(view.container.textContent).toContain('peer-login');
    expect(view.container.textContent).toContain('hidden comment');
  });

  it('collapses other comments after the first three and expands on demand', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const view = await renderCard({
        displayMode: 'analysis',
        messageComments: [
          { id: 11, messageId: 42, comment: 'first comment', login: 'other-login-1' },
          { id: 11, messageId: 42, comment: 'second comment', login: 'other-login-2' },
          { id: 11, messageId: 42, comment: 'third comment', login: 'other-login-3' },
          { id: 11, messageId: 42, comment: 'fourth comment', login: 'other-login-4' },
        ],
      });
      rendered.push(view);

      expect(view.container.textContent).toContain('first comment');
      expect(view.container.textContent).toContain('second comment');
      expect(view.container.textContent).toContain('third comment');
      expect(view.container.textContent).not.toContain('fourth comment');

      const toggleButton = Array.from(view.container.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('розгорнути'),
      );
      if (toggleButton == null) throw new Error('expand button not found');
      await click(toggleButton);

      expect(view.container.textContent).toContain('fourth comment');
      expect(
        consoleErrorSpy.mock.calls.some((call) => String(call[0] ?? '').includes('Encountered two children with the same key')),
      ).toBe(false);
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it('keeps analysis-only callsign chips visible even without a catalog match', async () => {
    const view = await renderCard({
      displayMode: 'analysis',
      msg: {
        ...buildMessage(),
        callsigns: ['ALPHA', 'BRAVO', 'CHARLIE', 'GHOST'],
      },
      callsignInfoMap: {
        alpha: { callsign: 'alpha', res: [{ id: 1, callsign: 'alpha', position: '', comment: '', unit1: '', unit2: '', unitId: 1, networkIdsReportedIn: [] }] },
        bravo: { callsign: 'bravo', res: [{ id: 2, callsign: 'bravo', position: '', comment: '', unit1: '', unit2: '', unitId: 1, networkIdsReportedIn: [] }] },
        charlie: { callsign: 'charlie', res: [{ id: 3, callsign: 'charlie', position: '', comment: '', unit1: '', unit2: '', unitId: 1, networkIdsReportedIn: [] }] },
      },
      analysisCallsignActions: {
        onAddCallsign: vi.fn().mockResolvedValue(true),
        onRemoveCallsign: vi.fn().mockResolvedValue(true),
        onAddSuggestedCallsign: vi.fn().mockResolvedValue(true),
      },
    });
    rendered.push(view);

    expect(view.container.textContent).toContain('ALPHA');
    expect(view.container.textContent).toContain('BRAVO');
    expect(view.container.textContent).toContain('CHARLIE');
    expect(view.container.textContent).toContain('GHOST');
  });

  it('shows human and bot contribution badges and renders the bot-error prompt', async () => {
    const onToggleTag = vi.fn();
    const onMarkBotTagWrong = vi.fn();
    const onCancelBotTagAction = vi.fn();
    const view = await renderCard({
      msg: buildMessage({
        inboxTags: [
          { id: 1, tagId: 3, confidence: 1, login: 'tester', model: null, organismId: 1 },
          { id: 2, tagId: 3, confidence: 0.92, login: null, model: 'bot', organismId: null },
        ],
      }),
      botTagAction: { messageId: 42, tagId: 3 },
      onToggleTag,
      onMarkBotTagWrong,
      onCancelBotTagAction,
    });
    rendered.push(view);

    expect(view.container.querySelector('[title="Боти"]')?.textContent).toContain('1');
    expect(view.container.querySelector('[title="Користувачі"]')?.textContent).toContain('1');
    expect(view.container.textContent).toContain('бот помилився');
    expect(view.container.textContent).toContain('закрити');

    await click(getButton(view.container, 'бот помилився'));
    await click(getButton(view.container, 'закрити'));

    expect(onMarkBotTagWrong).toHaveBeenCalledWith(42, 3);
    expect(onCancelBotTagAction).toHaveBeenCalledTimes(1);
    expect(onToggleTag).not.toHaveBeenCalled();
  });

  it('does not render analysis-only callsign controls in duty mode', async () => {
    const view = await renderCard();
    rendered.push(view);

    expect(view.container.textContent).not.toContain('Позивні ще не додані');
    expect(view.container.textContent).not.toContain('Додати позивний');
  });

  it('renders wav and ogg attachments with a compact audio host and top padding for the unavailable state', async () => {
    const view = await renderCard({
      msg: {
        ...buildMessage(),
        media: [
          {
            id: 'audio-wav',
            href: 'https://example.test/files/recording.wav',
            contentType: 'audio/wav',
            fileName: 'recording.wav',
            sizeBytes: 1024,
          },
          {
            id: 'audio-ogg',
            href: 'https://example.test/files/recording.ogg',
            fileName: 'recording.ogg',
            sizeBytes: 1024,
          },
        ] as InboxMessage['media'],
      },
    });
    rendered.push(view);

    const players = view.container.querySelectorAll('custom-audio-player');
    expect(players).toHaveLength(2);
    expect(view.container.querySelector('[data-audio-player-host]')?.getAttribute('data-audio-player-min-height-px')).toBe('120');
    expect(view.container.querySelector('[data-audio-player-host]')?.getAttribute('data-audio-player-top-padding-px')).toBe('12');
    expect(view.container.querySelector('[data-audio-player-host]')?.getAttribute('data-audio-player-z-index')).toBe('0');
  });

  it('does not treat video/mpeg attachments as audio', async () => {
    const view = await renderCard({
      msg: {
        ...buildMessage(),
        media: [
          {
            id: 'video-mpeg',
            href: 'https://example.test/files/demo.mpeg',
            contentType: 'video/mpeg',
            fileName: 'demo.mpeg',
            sizeBytes: 2048,
          },
        ] as InboxMessage['media'],
      },
    });
    rendered.push(view);

    expect(view.container.querySelector('custom-audio-player')).toBeNull();
    expect(view.container.querySelector('button')).not.toBeNull();
  });

  it('renders audio attachments with the custom audio player instead of a download button', async () => {
    const view = await renderCard({
      msg: {
        ...buildMessage(),
        media: [
          {
            id: 'audio-1',
            href: 'https://example.test/files/recording.mp3',
            contentType: 'audio/mpeg',
            fileName: 'recording.mp3',
            sizeBytes: 1024,
          },
        ] as InboxMessage['media'],
      },
    });
    rendered.push(view);

    const player = view.container.querySelector('custom-audio-player');
    expect(player).not.toBeNull();
    expect(player?.getAttribute('src')).toBe('https://example.test/files/recording.mp3');
    expect(player?.getAttribute('mode')).toBe('compact');
    expect(player?.getAttribute('storage-key')).toBe('echo-inbox-audio-1');
    expect(player?.getAttribute('wave-src')).toBe('/api/messenger/media/audio-1/wave');
    expect(player?.getAttribute('spectrum-src')).toBe('/api/messenger/media/audio-1/spectrogram');
    expect(view.container.querySelector('audio')).toBeNull();
    expect(view.container.textContent).toContain('recording.mp3');
    expect(
      Array.from(view.container.querySelectorAll('button')).some((button) => button.textContent?.includes('recording.mp3')),
    ).toBe(false);
  });

  it('renders audio attachments from snake_case API media fields', async () => {
    const view = await renderCard({
      msg: {
        ...buildMessage(),
        media: [
          {
            id: 'audio-2',
            href: '/api/messenger/media/audio-2',
            content_type: 'audio/mpeg',
            file_name: 'intercept.mp3',
            size_bytes: 2048,
          },
        ] as InboxMessage['media'],
      },
    });
    rendered.push(view);

    expect(view.container.querySelector('custom-audio-player')).not.toBeNull();
    expect(
      Array.from(view.container.querySelectorAll('button')).some((button) => button.textContent?.includes('intercept.mp3')),
    ).toBe(false);
  });

  it('renders attachments with a download icon and consistent minimum width', async () => {
    const view = await renderCard({
      msg: {
        ...buildMessage(),
        media: [
          {
            id: 1,
            href: 'https://example.test/files/HByMR1VD5nrYaiQRyaFV.txt',
            contentType: 'text/plain',
            fileName: 'HByMR1VD5nrYaiQRyaFV.txt',
          },
          {
            id: 2,
            href: 'https://example.test/files/8a7d0703-4f44-4ce8-b95a-8a2e.txt',
            contentType: 'text/plain',
            fileName: '8a7d0703-4f44-4ce8-b95a-8a2e.txt',
          },
        ] as InboxMessage['media'],
      },
    });
    rendered.push(view);

    const downloadButtons = Array.from(view.container.querySelectorAll('button')).filter((button) =>
      button.textContent?.includes('.txt'),
    );
    expect(downloadButtons).toHaveLength(2);
    expect(downloadButtons[0]?.querySelector('svg')).not.toBeNull();
    expect(downloadButtons[1]?.querySelector('svg')).not.toBeNull();
    expect(downloadButtons[0]?.textContent).toContain('HByMR1VD5nrYaiQRyaFV.txt');
    expect(downloadButtons[1]?.textContent).toContain('8a7d0703-4f44-4ce8-b95a-8a2e.txt');
  });

  it('shows selected tags first and can reveal the rest on demand', async () => {
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: TAG_ROW_MEASURE_WIDTH_PX,
      height: 32,
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: TAG_ROW_MEASURE_WIDTH_PX,
      bottom: 32,
      toJSON: () => ({}),
    } as DOMRect);

    try {
      const view = await renderCard({ tagsLayout: 'compact' });
      rendered.push(view);

      // Compact layout: selected (inbox) tag first, then the rest; row packs until width + «розгорнути» reserve.
      expect(view.container.textContent).toContain('переміщення');
      expect(view.container.textContent).toContain('розгорнути');
      expect(view.container.textContent).not.toContain('іфо');
      expect(view.container.textContent).not.toContain('розвідка');

      await click(getButton(view.container, 'розгорнути'));

      expect(view.container.textContent).toContain('згорнути');
      expect(view.container.textContent).toContain('зв’язок');
      expect(view.container.textContent).toContain('РЕБ');
      expect(view.container.textContent).toContain('арта');
      expect(view.container.textContent).toContain('палітра');
      expect(view.container.textContent).toContain('іфо');
      expect(view.container.textContent).toContain('розвідка');
    } finally {
      rectSpy.mockRestore();
    }
  });

  it('keeps compact tag order stable when a chip is unchecked', async () => {
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: TAG_ROW_MEASURE_WIDTH_PX,
      height: 32,
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: TAG_ROW_MEASURE_WIDTH_PX,
      bottom: 32,
      toJSON: () => ({}),
    } as DOMRect);

    try {
      const onToggleTag = vi.fn();
      const view = await renderCard({
        tagsLayout: 'compact',
        msg: buildMessage({
          inboxTags: [{ id: 1, tagId: 3, confidence: 1, login: 'tester', model: null, organismId: 1 }],
        }),
        onToggleTag,
      });
      rendered.push(view);

      const before = getTagButtonLabels(view.container).slice(0, 4);
      expect(before[0]).toBe('переміщення');

      await click(getButton(view.container, 'переміщення'));
      expect(onToggleTag).toHaveBeenCalledWith(3);

      const nextProps = {
        ...view.props,
        msg: buildMessage({
          inboxTags: [],
          tags: [4, 5, 6, 7, 8, 9],
        }),
      };

      await act(async () => {
        view.root.render(<MessageCard {...nextProps} />);
      });

      const after = getTagButtonLabels(view.container).slice(0, 4);
      expect(after).toEqual(before);
    } finally {
      rectSpy.mockRestore();
    }
  });

  it('keeps full tag ordering aligned with the tag map', async () => {
    const view = await renderCard({
      msg: buildMessage({
        inboxTags: [{ id: 1, tagId: 7, confidence: 1, login: 'tester', model: null, organismId: 1 }],
      }),
    });
    rendered.push(view);

    expect(getTagButtonLabels(view.container)).toEqual(['переміщення', 'зв’язок', 'РЕБ', 'арта', 'палітра', 'іфо', 'розвідка']);
  });

  it('shows a tags spinner before analysis tags load', async () => {
    const view = await renderCard({ displayMode: 'analysis', tagsLoading: true, tagsMap: {} });
    rendered.push(view);

    expect(view.container.textContent).toContain('tags-loading');
    expect(view.container.textContent).not.toContain('переміщення');
  });

  it('hides tags completely when the shared tag layout is set to hidden', async () => {
    const view = await renderCard({ tagsLayout: 'hidden' });
    rendered.push(view);

    expect(view.container.textContent).not.toContain('переміщення');
    expect(view.container.textContent).not.toContain('зв’язок');
    expect(view.container.textContent).not.toContain('РЕБ');
    expect(view.container.textContent).not.toContain('теги');
  });

  it('keeps light-theme secondary text contrast within WCAG AA bounds', () => {
    const theme = createTheme({ palette: { mode: 'light' } });
    const cardBg = '#F8F9FB';

    expect(contrastRatio(theme.palette.text.secondary, cardBg)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(theme.palette.text.primary, cardBg)).toBeGreaterThanOrEqual(4.5);
  });

  it('renders mock image thumbnails with links opening full image in a new tab', async () => {
    const view = await renderCard({
      msg: { ...buildMessage(), ...inboxMessageWithMockImages() },
    });
    rendered.push(view);

    const imgs = view.container.querySelectorAll('img');
    expect(imgs.length).toBe(2);
    imgs.forEach((img) => {
      const link = img.closest('a');
      expect(link).not.toBeNull();
      expect(link?.getAttribute('target')).toBe('_blank');
      expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
      expect(link?.getAttribute('href')?.startsWith('data:image/svg+xml')).toBe(true);
      expect(link?.getAttribute('data-picture-thumb-state')).toBe('loaded');
    });
  });

  it('keeps the image thumbnail footprint visible when the image fails to load', async () => {
    const view = await renderCard({
      msg: {
        ...buildMessage(),
        images: ['https://example.test/files/broken.png'],
      },
    });
    rendered.push(view);

    const img = view.container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.closest('a')?.getAttribute('data-picture-thumb-state')).toBe('loading');
    expect(view.container.textContent).toContain('Зображення');

    await act(async () => {
      img?.dispatchEvent(new Event('error', { bubbles: true }));
    });

    expect(view.container.querySelector('img')).not.toBeNull();
    const link = view.container.querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://example.test/files/broken.png');
    expect(link?.getAttribute('data-picture-thumb-state')).toBe('failed');
    expect(link?.getAttribute('data-picture-thumb-error-height-px')).toBe('36');
    expect(view.container.textContent).toContain('Зображення недоступне');
  });
});
