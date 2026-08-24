/**
 * @vitest-environment happy-dom
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import type { ComponentProps, ElementType, ReactNode } from 'react';
import React, { act, forwardRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTheme } from '@mui/material/styles';

import type {
  InboxMessage,
  InboxMessageMetadata,
  MessageMediaInfo,
  Network,
  Tag,
  ContentNode,
} from '../../../../../../../Bindings';
import { ELLIPSIS } from '../../../../../utils/misc';
import { inboxMessageWithMockImages } from '../../../../rer-duty-neo/inbox-message-mocks';
import { emptyFilter } from '../../../../rer-duty-neo/utils';
import { formatMessageCardTooltipTime, MessageCard } from '../../MessageCard';
import { MessageCardContent } from '../../MessageCardContent';
import { MessageCardHeader } from '../../MessageCardHeader';
import {
  canDownloadAllMessageAttachments,
  isAudioMediaAttachment,
  isVideoMediaAttachment,
  MESSAGE_CARD_DOWNLOAD_START_COOLDOWN_MS,
  RER_MESSAGE_ATTACHMENTS_ZIP_MAX_FILES,
  RER_MESSAGE_ATTACHMENTS_ZIP_MAX_TOTAL_BYTES,
} from '../../MessageCardMedia';
import { AudioTranscriptionPreferencesProvider } from '../../MessageCardAudioTranscription';
import {
  normalizeLocationDisplayValue,
  resolveEtalonBindingDisplayValue,
  resolveMessageCardEtalonDisplayModel,
} from '../../message-card.utils';

const COPY_TITLE = `Копіювати${ELLIPSIS}`;
const NAVIGATE_TITLE = `Перейти${ELLIPSIS}`;
const EXCLUDE_TITLE = `Виключити${ELLIPSIS}`;
const latestMenuProps: Array<{
  anchorReference?: string;
  anchorPosition?: { top: number; left: number } | null;
  open?: boolean;
  id?: string;
}> = [];
const latestDocumentDialogProps: Array<{
  currentIndex?: number;
  open?: boolean;
  document?: { id?: string | number | null; kind: string; href: string };
}> = [];

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
  delete clone.valueLabelDisplay;
  delete clone.anchorEl;
  delete clone.anchorReference;
  delete clone.anchorPosition;
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

vi.mock('../../renderers/DocumentAttachmentPreviewRenderer', () => ({
  DocumentAttachmentPreviewRenderer: ({
    document,
    navigation,
    onClose,
    isDownloadStarting,
    onDownloadStart,
  }: {
    document: { id?: string | number | null; kind: string; href: string };
    navigation: {
      index: number;
      count: number;
      onPrevious: () => void;
      onNext: () => void;
    };
    onClose: () => void;
    isDownloadStarting?: (downloadKey: string) => boolean;
    onDownloadStart?: (downloadKey: string) => boolean;
  }) => {
    const downloadKey = `media:${String(document.id ?? '')}`;
    const downloading = isDownloadStarting?.(downloadKey) ?? false;
    latestDocumentDialogProps.push({
      currentIndex: navigation.index,
      open: true,
      document,
    });
    return (
      <>
        <a
          data-preview-download
          href={document.href}
          download
          aria-label={downloading ? 'Завантаження…' : 'Завантажити файл'}
          aria-busy={downloading}
          disabled={downloading}
          onClick={(event) => {
            if (downloading || !onDownloadStart?.(downloadKey)) event.preventDefault();
          }}
        >
          {downloading ? 'spinner' : 'download'}
        </a>
        {navigation.count > 1 ? (
          <button
            type="button"
            aria-label="Попереднє"
            data-attachment-preview-nav="prev"
            onClick={navigation.onPrevious}
          />
        ) : null}
        <span>{`${navigation.index + 1} / ${navigation.count}`}</span>
        {navigation.count > 1 ? (
          <button
            type="button"
            aria-label="Наступне"
            data-attachment-preview-nav="next"
            onClick={navigation.onNext}
          />
        ) : null}
        <button type="button" aria-label="Закрити" onClick={onClose} />
        document-dialog
      </>
    );
  },
}));

vi.mock('../../MessageCardWatermark', () => ({
  MessageCardWatermark: () => null,
}));

/** Narrow width for tag-row measurement in compact layout (MessageCardTagChips `useLayoutEffect`). */
const TAG_ROW_MEASURE_WIDTH_PX = 200;
const LIGHT_CARD_BG = '#F8F9FB';

function normalizeCssColor(value: string): { r: number; g: number; b: number; a: number } {
  const trimmed = value.trim();
  if (trimmed.startsWith('#')) {
    const hex = trimmed.slice(1);
    const normalized =
      hex.length === 3
        ? hex
            .split('')
            .map((part) => part + part)
            .join('')
        : hex;
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

function compositeOver(
  fg: { r: number; g: number; b: number; a: number },
  bg: { r: number; g: number; b: number; a: number },
) {
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
    component,
    size,
    variant,
    color,
    sx,
    ...props
  }: { children?: ReactNode; startIcon?: ReactNode; endIcon?: ReactNode } & Record<
    string,
    unknown
  >) => {
    const Component = component ?? 'button';
    return (
      <Component
        {...(Component === 'button' ? { type: 'button' } : {})}
        data-mui-size={size}
        data-mui-variant={variant}
        data-mui-color={color}
        data-mui-sx={JSON.stringify(sx ?? {})}
        {...omitMuiLayoutProps(props)}
      >
        {startIcon}
        <span>{children}</span>
        {endIcon}
      </Component>
    );
  },
  ButtonBase: ({ children, component, ...props }: PrimitiveProps) => {
    const Component = component ?? 'button';
    return (
      <Component
        {...(Component === 'button' ? { type: 'button' } : {})}
        {...omitMuiLayoutProps(props)}
      >
        {children}
      </Component>
    );
  },
  ButtonGroup: ({ children, component, ...props }: PrimitiveProps) => {
    const Component = component ?? 'div';
    return <Component {...omitMuiLayoutProps(props)}>{children}</Component>;
  },
  CircularProgress: (props: Record<string, unknown>) => <span {...props}>tags-loading</span>,
  Collapse: ({ children, in: open }: { children?: ReactNode; in?: boolean }) =>
    open ? <>{children}</> : null,
  Chip: ({
    label,
    onClick,
    onDelete,
  }: {
    label?: ReactNode;
    onClick?: () => void;
    onDelete?: () => void;
  }) => (
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
  IconButton: ({
    children,
    component,
    href,
    target,
    rel,
    ...props
  }: { children?: ReactNode; component?: string } & Record<string, unknown>) => {
    const Component = component ?? 'button';
    return (
      <Component
        {...(Component === 'button' ? { type: 'button' } : {})}
        href={href}
        target={target}
        rel={rel}
        {...omitMuiLayoutProps(props)}
      >
        {children}
      </Component>
    );
  },
  Dialog: ({
    children,
    open,
  }: { children?: ReactNode; open?: boolean } & Record<string, unknown>) =>
    open ? <div role="dialog">{children}</div> : null,
  DialogActions: ({ children, ...props }: PrimitiveProps) => (
    <div {...omitMuiLayoutProps(props)}>{children}</div>
  ),
  DialogContent: ({ children, ...props }: PrimitiveProps) => (
    <div {...omitMuiLayoutProps(props)}>{children}</div>
  ),
  Divider: (props: Record<string, unknown>) => <hr {...omitMuiLayoutProps(props)} />,
  DialogTitle: ({ children, ...props }: PrimitiveProps) => (
    <div {...omitMuiLayoutProps(props)}>{children}</div>
  ),
  ImageList: ({ children, ...props }: PrimitiveProps) => (
    <div {...omitMuiLayoutProps(props)}>{children}</div>
  ),
  ImageListItem: ({ children, ...props }: PrimitiveProps) => (
    <div {...omitMuiLayoutProps(props)}>{children}</div>
  ),
  Link: ({
    children,
    href,
    ...props
  }: { children?: ReactNode; href?: string } & Record<string, unknown>) => (
    <a href={href} {...omitMuiLayoutProps(props)}>
      {children}
    </a>
  ),
  Popover: ({
    children,
    open,
    ...props
  }: { children?: ReactNode; open?: boolean } & Record<string, unknown>) =>
    open ? <div {...omitMuiLayoutProps(props)}>{children}</div> : null,
  Menu: ({
    children,
    open,
    ...props
  }: { children?: ReactNode; open?: boolean } & Record<string, unknown>) =>
    open
      ? (() => {
          latestMenuProps.push({
            anchorReference: props.anchorReference as string | undefined,
            anchorPosition:
              (props.anchorPosition as { top: number; left: number } | undefined) ?? null,
            open,
            id: props.id as string | undefined,
          });
          return <div {...omitMuiLayoutProps(props)}>{children}</div>;
        })()
      : null,
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
  Slider: ({
    value,
    onChange,
    min,
    max,
    step,
    marks,
    ...props
  }: {
    value?: number;
    onChange?: (event: { currentTarget: HTMLInputElement }, value: number | number[]) => void;
    min?: number;
    max?: number;
    step?: number;
    marks?: Array<{ value: number; label?: ReactNode }>;
  } & Record<string, unknown>) => (
    <input
      type="range"
      value={value ?? 0}
      min={min}
      max={max}
      step={step}
      data-marks={JSON.stringify(marks ?? [])}
      onChange={(event) =>
        onChange?.({ currentTarget: event.currentTarget }, Number(event.currentTarget.value))
      }
      onInput={(event) =>
        onChange?.({ currentTarget: event.currentTarget }, Number(event.currentTarget.value))
      }
      {...omitMuiLayoutProps(props)}
    />
  ),
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  Skeleton: ({ children }: { children?: ReactNode }) => <span>{children ?? 'skeleton'}</span>,
  useTheme: () => ({
    breakpoints: {
      down: () => '(max-width: 600px)',
    },
    palette: {
      grey: { 900: '#111827' },
      background: { default: '#0b0f14' },
    },
  }),
  useMediaQuery: () => false,
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
        onKeyDown={(event) =>
          onKeyDown?.({ key: event.key, preventDefault: () => event.preventDefault() })
        }
        {...(inputProps ?? {})}
        {...omitMuiLayoutProps(props)}
      />
    </label>
  ),
  Typography: ({ children, component, variant, sx, style, ...props }: PrimitiveProps) => {
    const Component = component ?? 'div';
    const typographyStyle = {
      ...(style as Record<string, unknown> | undefined),
      ...(sx != null && typeof sx === 'object' && !Array.isArray(sx)
        ? {
            fontWeight: (sx as { fontWeight?: unknown }).fontWeight,
          }
        : {}),
    };
    if (typographyStyle.fontWeight == null) delete typographyStyle.fontWeight;
    return (
      <Component
        data-mui-variant={variant ?? 'body1'}
        style={Object.keys(typographyStyle).length > 0 ? typographyStyle : undefined}
        {...omitMuiLayoutProps(props)}
      >
        {children}
      </Component>
    );
  },
}));

vi.mock('../../../../../components/PowerChip', () => ({
  PowerChip: ({
    label,
    onDelete,
    onClick,
  }: {
    label: ReactNode;
    onClick?: () => void;
    onDelete?: () => void;
  }) => (
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

vi.mock('../../useRelativeTimeDisplayMs', () => ({
  useRelativeTimeDisplayMs: () => [null, 1_710_000_000_000],
}));

vi.mock('../../MarkedText', () => ({
  renderMarkedText: (_nodes: unknown, text: string) => [text],
}));

type Rendered = {
  container: HTMLDivElement;
  root: Root;
  props?: ComponentProps<typeof MessageCard>;
  headerProps?: ComponentProps<typeof MessageCardHeader>;
};

type ResizeObserverCallback = () => void;

const resizeObserverCallbacks: ResizeObserverCallback[] = [];
const resizeObserverTargets = new Map<ResizeObserverCallback, Set<Element>>();
let originalWindowResizeObserver: PropertyDescriptor | undefined;

class ResizeObserverMock {
  constructor(private readonly callback: ResizeObserverCallback) {
    resizeObserverCallbacks.push(callback);
    resizeObserverTargets.set(callback, new Set());
  }

  observe(element: Element) {
    resizeObserverTargets.get(this.callback)?.add(element);
  }

  disconnect() {
    resizeObserverTargets.delete(this.callback);
  }
}

function triggerResizeFor(element: Element) {
  resizeObserverCallbacks
    .filter((callback) => resizeObserverTargets.get(callback)?.has(element))
    .forEach((callback) => callback());
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

async function renderCard(
  overrides: Partial<ComponentProps<typeof MessageCard>> = {},
  options: {
    audioTranscriptionCollapsed?: boolean;
    audioTranscriptionEnabled?: boolean;
  } = {},
): Promise<Rendered> {
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
    // Specs assert mounted media by default; Duty collapses unless a test opts in.
    collapseMediaPreviews: false,
    onBookmark: vi.fn(),
    onImportant: vi.fn(),
    onCopyText: vi.fn(),
    onCopyFreq: vi.fn(),
    onCopyEtalon: vi.fn(),
    onCopyLocation: vi.fn(),
    onAddFrequencyToFilter: vi.fn(),
    onCreateReport: vi.fn(),
    onExcludeMessageEntity: vi.fn(),
    onToggleTag: vi.fn(),
    ...overrides,
  };

  await act(async () => {
    root.render(
      <AudioTranscriptionPreferencesProvider
        collapsedByDefault={options.audioTranscriptionCollapsed ?? false}
        enabled={options.audioTranscriptionEnabled ?? true}
      >
        <MessageCard {...props} />
      </AudioTranscriptionPreferencesProvider>,
    );
  });

  return { container, root, props };
}

async function renderHeader(
  overrides: Partial<ComponentProps<typeof MessageCardHeader>> = {},
): Promise<Rendered> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const msg = overrides.msg ?? buildMessage();
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
    onCreateReport: vi.fn(),
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

  return { container, root, headerProps: props };
}

function setClientWidth(element: HTMLElement, width: number) {
  Object.defineProperty(element, 'clientWidth', {
    configurable: true,
    value: width,
  });
}

function setScrollWidth(element: HTMLElement, width: number) {
  Object.defineProperty(element, 'scrollWidth', {
    configurable: true,
    value: width,
  });
}

function getButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((item) =>
    item.textContent?.includes(label),
  );
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Button not found: ${label}`);
  return button;
}

function getTagButtonLabels(container: HTMLElement): string[] {
  const tagLabels = new Set([
    'переміщення',
    'зв’язок',
    'РЕБ',
    'арта',
    'палітра',
    'іфо',
    'розвідка',
  ]);
  return Array.from(container.querySelectorAll('button'))
    .map((button) => button.textContent?.trim() ?? '')
    .filter((label) => tagLabels.has(label));
}

function getHeaderBody2ElementByText(container: HTMLElement, text: string): HTMLElement {
  const element = Array.from(container.querySelectorAll('[data-message-card-text="body2"]')).find(
    (node) => node.textContent?.trim() === text,
  );
  if (!(element instanceof HTMLElement)) {
    throw new Error(`Header body2 element not found for text: ${text}`);
  }
  return element;
}

function getMuiTypographyElementByText(container: HTMLElement, text: string): HTMLElement {
  const element = Array.from(container.querySelectorAll('[data-mui-variant]')).find(
    (node) => node.textContent?.trim() === text,
  );
  if (!(element instanceof HTMLElement)) {
    throw new Error(`Typography element not found for text: ${text}`);
  }
  return element;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

async function dispatchCancelableClick(element: HTMLElement): Promise<MouseEvent> {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true });
  await act(async () => {
    element.dispatchEvent(event);
  });
  return event;
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
    originalWindowResizeObserver = Object.getOwnPropertyDescriptor(window, 'ResizeObserver');
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
    resizeObserverTargets.clear();
    latestMenuProps.splice(0);
    latestDocumentDialogProps.splice(0);
    if (typeof window.localStorage?.clear === 'function') {
      window.localStorage.clear();
    }
    for (const item of rendered.splice(0)) {
      act(() => {
        item.root.unmount();
      });
      item.container.remove();
    }
    if (originalWindowResizeObserver) {
      Object.defineProperty(window, 'ResizeObserver', originalWindowResizeObserver);
    } else {
      delete (window as Window & { ResizeObserver?: unknown }).ResizeObserver;
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
      resolveMessageCardEtalonDisplayModel(
        buildMessage({ networkIds: [], location: '  ПІЩАНКА  ' }),
        {
          featureStrictNetworks: false,
        },
      ),
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
      resolveMessageCardEtalonDisplayModel(
        buildMessage({ networkIds: [], unit: ' 1-й танк ', location: null }),
        {
          featureStrictNetworks: false,
        },
      ),
    ).toMatchObject({
      primaryKind: 'unit',
      displayValue: '1-й танк',
      copyEtalonValue: '1-й танк',
      copyLocationValue: null,
      showInlineLocationTooltip: false,
      locationDisplayValue: null,
    });
    // Unit and location present together: the unit is the primary, but the
    // location is still surfaced (shown in the row's location slot), not dropped.
    expect(
      resolveMessageCardEtalonDisplayModel(
        buildMessage({ networkIds: [], unit: ' 1-й танк ', location: '  ПІЩАНКА  ' }),
        {
          featureStrictNetworks: false,
        },
      ),
    ).toMatchObject({
      primaryKind: 'unit',
      displayValue: '1-й танк',
      copyEtalonValue: '1-й танк',
      copyLocationValue: 'Піщанка',
      locationDisplayValue: 'Піщанка',
    });
    expect(
      resolveMessageCardEtalonDisplayModel(
        buildMessage({ networkIds: [], unit: null, location: 'Не встановлена' }),
        {
          featureStrictNetworks: true,
        },
      ),
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

    const card = view.container.querySelector('li');
    if (!(card instanceof HTMLElement)) throw new Error('card root not found');
    expect(card.style.contentVisibility).toBe('');
    expect(
      card.style.containIntrinsicBlockSize ||
        card.style.getPropertyValue('contain-intrinsic-block-size'),
    ).toBe('');

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

  it.each([
    ['classic', '/rer-analysis', true],
    ['neo', '/rer-analysis-neo', false],
  ] as const)(
    'builds %s duty analysis menu links',
    async (analysisDestination, pathname, legacy) => {
      const view = await renderCard({
        analysisDestination,
        msg: buildMessage({ messageUid: 'message-uid-1', pointTokens: [] }),
      });
      rendered.push(view);

      const navigateButton = view.container.querySelector<HTMLButtonElement>(
        `button[aria-label="${NAVIGATE_TITLE}"]`,
      );
      if (navigateButton == null) throw new Error('Navigate button not found');
      await click(navigateButton);

      const links = Array.from(view.container.querySelectorAll<HTMLAnchorElement>('a')).filter(
        (link) => link.pathname === pathname,
      );
      expect(links).toHaveLength(2);
      const [mapUrl, analysisUrl] = links.map((link) => new URL(link.href));
      expect(mapUrl.searchParams.get('state') != null).toBe(legacy);
      expect(analysisUrl.searchParams.get('state') != null).toBe(legacy);
      expect(mapUrl.searchParams.get('search')).toBe(legacy ? null : 'message-uid-1');
      expect(analysisUrl.searchParams.get('search')).toBe(legacy ? null : 'message-uid-1');
      expect(mapUrl.searchParams.get('freqs')).toBe(legacy ? null : '153.6250');
      expect(analysisUrl.searchParams.get('freqs')).toBe(legacy ? null : '153.6250');
      expect(mapUrl.searchParams.get('showMap')).toBe('true');
      expect(analysisUrl.searchParams.get('showMap')).toBeNull();
      expect(mapUrl.searchParams.get('fromDateTime')).toBe(
        legacy ? null : analysisUrl.searchParams.get('fromDateTime'),
      );
      expect(mapUrl.searchParams.get('toDateTime')).toBe(
        legacy ? null : analysisUrl.searchParams.get('toDateTime'),
      );
    },
  );

  it('keeps deferred off-screen layout limited to analysis cards', async () => {
    const view = await renderCard({ displayMode: 'analysis' });
    rendered.push(view);

    const card = view.container.querySelector('li');
    if (!(card instanceof HTMLElement)) throw new Error('card root not found');
    expect(card.style.contentVisibility).toBe('auto');
    expect(
      card.style.containIntrinsicBlockSize ||
        card.style.getPropertyValue('contain-intrinsic-block-size'),
    ).toBe('auto 120px');
  });

  it('keeps closed menus unmounted and preserves the header hot-path structure', async () => {
    const view = await renderCard({
      displayMode: 'analysis',
      onEditDetails: vi.fn(),
      onDelete: vi.fn(),
    });
    rendered.push(view);

    expect(latestMenuProps).toHaveLength(0);

    const headerSource = readFileSync(
      join(
        process.cwd(),
        new URL('../../MessageCardHeader.tsx', import.meta.url).pathname.slice(1),
      ),
      'utf8',
    );
    expect(headerSource).not.toContain('<Box');
    expect(headerSource).not.toContain('<Stack');
    expect(headerSource).toContain(
      'isPresent(overflowMenuAnchorPosition) && canShowOverflowMenu ?',
    );
    expect(headerSource).toContain('isPresent(copyMenuAnchorPosition) ?');
    expect(headerSource).toContain(
      'isPresent(navigationMenuAnchorPosition) && canShowNavigationMenu ?',
    );
    expect(headerSource).toContain('isPresent(excludeMenuAnchorPosition) && canShowExcludeMenu ?');

    expect(typeof MessageCardHeader).toBe('object');
    expect((MessageCardHeader as { type?: unknown }).type).toBeTypeOf('function');
    expect(typeof MessageCardContent).toBe('object');
    expect((MessageCardContent as { type?: unknown }).type).toBeTypeOf('function');
  });

  it.each(['duty', 'analysis'] as const)(
    'renders operational header values as body2 in %s mode',
    async (displayMode) => {
      const view = await renderHeader({
        displayMode,
        msg: buildMessage({
          coords: '12.3456789, -98.7654321',
          deviceName: '  Радіостанція  ',
          networkIds: [],
          unit: ' 1-й танк ',
          location: '  ХАРКІВ  ',
        }),
        groupName: 'Група A',
        senderName: 'Відправник B',
      });
      rendered.push(view);

      const headerText = view.container.querySelector(
        '[data-message-header-grid="true"]',
      )?.textContent;
      if (headerText == null) throw new Error('header text not found');

      const expectedValues = [
        '02:45',
        '23.03',
        '153.6250',
        'Група A',
        'Відправник B',
        '12.34568, -98.76543',
        'Радіостанція',
        'Харків',
      ] as const;
      for (const value of expectedValues) {
        const textElement = getHeaderBody2ElementByText(view.container, value);
        expect(textElement.getAttribute('data-message-card-text')).toBe('body2');
        expect(headerText).toContain(value);
      }
      expect(view.container.querySelector('[title="Пристрій"]')).not.toBeNull();

      expect(headerText.indexOf('Група A')).toBeLessThan(headerText.indexOf('Відправник B'));
      expect(headerText.indexOf('Відправник B')).toBeLessThan(headerText.indexOf('153.6250'));
      expect(headerText.indexOf('153.6250')).toBeLessThan(headerText.indexOf('Радіостанція'));
      expect(headerText.indexOf('Радіостанція')).toBeLessThan(
        headerText.indexOf('12.34568, -98.76543'),
      );
      expect(headerText.indexOf('12.34568, -98.76543')).toBeLessThan(
        headerText.indexOf('1-й танк'),
      );
      expect(headerText.indexOf('1-й танк')).toBeLessThan(headerText.indexOf('Харків'));
    },
  );

  it('shows the WGS coordinates in the header without locality', async () => {
    const view = await renderHeader({
      displayMode: 'duty',
      msg: buildMessage({
        coords: '49.1, 37.2',
        coordsWithLocality: [
          {
            coords: { lat: 49.1, lon: 37.2 },
            locality: {
              settlementName: 'Степногірськ',
              direction: 'SW',
              region: null,
              country: null,
              distanceM: 5400,
              isRf: false,
            },
          },
        ],
      }),
    });
    rendered.push(view);

    const text = view.container.querySelector('[data-message-header-grid="true"]')?.textContent;
    expect(text).toContain('49.1, 37.2');
    expect(text).not.toContain('Степногірськ');
  });

  it.each(['duty', 'analysis'] as const)(
    'hides an empty device name in %s mode',
    async (displayMode) => {
      const view = await renderHeader({
        displayMode,
        msg: buildMessage({ deviceName: '   ' }),
      });
      rendered.push(view);

      expect(view.container.querySelector('[title="Пристрій"]')).toBeNull();
    },
  );

  it('renders the extended form as bold body2 text', async () => {
    const view = await renderCard({
      msg: buildMessage({ extendedForm: 'Коментар' }),
    });
    rendered.push(view);

    const extendedForm = getMuiTypographyElementByText(view.container, 'Коментар');
    expect(extendedForm.getAttribute('data-mui-variant')).toBe('body2');
    expect(window.getComputedStyle(extendedForm).fontWeight).toBe('700');
  });

  it('renders report summaries below the comment and opens report editing', async () => {
    const onEditReport = vi.fn();
    const msg = {
      ...buildMessage({ extendedForm: 'Коментар' }),
      intelligenceReports: [
        {
          id: 91,
          isAccessible: true,
          isDeleted: false,
          text: 'Короткий текст розвіддонесення',
          attachmentsCount: 2,
          timestamp: 1_710_000_000_000,
          date: null,
          time: null,
          groupName: null,
          groupMasterKey: 'report-group',
        },
      ],
    } as InboxMessage;
    const view = await renderCard({
      msg,
      reportGroupInfos: {
        'report-group': { masterKey: 'report-group', name: 'Група донесення' } as any,
      },
      onEditReport,
    });
    rendered.push(view);

    expect(view.container.textContent).toContain('Короткий текст розвіддонесення');
    expect(view.container.textContent).not.toContain('Група донесення');
    const comment = getMuiTypographyElementByText(view.container, 'Коментар');
    const editReport = view.container.querySelector(
      'button[aria-label="Редагувати розвіддонесення"]',
    );
    if (!(editReport instanceof HTMLButtonElement)) throw new Error('report edit button not found');
    expect(comment.compareDocumentPosition(editReport) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(
      0,
    );
    await click(editReport);
    expect(onEditReport).toHaveBeenCalledWith(91);
  });

  it('offers report creation from a standalone report card', async () => {
    const onCreateReport = vi.fn();
    const msg = buildMessage({
      groupMasterKey: 'report-group',
      parentMessages: [
        {
          id: 42,
          isAccessible: true,
          isDeleted: false,
          text: 'Короткий текст оригінального повідомлення',
          attachmentsCount: 1,
          timestamp: null,
          date: null,
          time: null,
          groupName: null,
          groupMasterKey: 'original-group',
        },
      ],
    });
    const view = await renderCard({ msg, onCreateReport });
    rendered.push(view);

    await click(view.container.querySelector('button[aria-label="Створити розвіддонесення"]'));
    expect(onCreateReport).toHaveBeenCalledTimes(1);
    expect(view.container.textContent).toContain('Короткий текст оригінального повідомлення');
    expect(view.container.textContent).not.toContain('Оригінальне повідомлення');
  });

  it('linkifies plain message text URLs in the body', async () => {
    const url = 'https://docs.google.com/document/d/hash/edit?usp=sharing';
    const view = await renderCard({
      msg: buildMessage({
        text: `Дивись документ: ${url}`,
        textMarked: [],
      }),
    });
    rendered.push(view);

    const link = view.container.querySelector(`a[href="${url}"]`);
    expect(link).not.toBeNull();
    expect(link?.textContent).toBe(url);
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('folds marked message text after twenty source rows', async () => {
    const rows = Array.from({ length: 21 }, (_, index) => `Рядок ${index + 1}`);
    const textMarked: ContentNode[] = rows.flatMap((row, index) => [
      index === 0
        ? { CNHighlightC: { text: row, begin: 0, end: row.length } }
        : { CNTextC: { text: row } },
      ...(index < rows.length - 1 ? (['CNNewlineC'] as ContentNode[]) : []),
    ]);
    const view = await renderCard({
      msg: buildMessage({ text: rows.join('\n'), textMarked }),
    });
    rendered.push(view);

    const messageText = view.container.querySelector('.text-marked');
    expect(messageText?.textContent).toContain('Рядок 1');
    expect(messageText?.textContent).toContain('Рядок 20');
    expect(messageText?.textContent).not.toContain('Рядок 21');

    const showMoreButton = view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Показати текст повідомлення"]',
    );
    if (showMoreButton == null) throw new Error('Show more button not found');
    expect(showMoreButton.getAttribute('aria-expanded')).toBe('false');

    await click(showMoreButton);

    expect(messageText?.textContent).toContain('Рядок 21');
    const collapseButton = view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Згорнути текст повідомлення"]',
    );
    if (collapseButton == null) throw new Error('Collapse button not found');
    expect(collapseButton.getAttribute('aria-expanded')).toBe('true');

    await click(collapseButton);

    expect(messageText?.textContent).not.toContain('Рядок 21');
  });

  it('does not fold message text with twenty source rows', async () => {
    const rows = Array.from({ length: 20 }, (_, index) => `Рядок ${index + 1}`);
    const view = await renderCard({
      msg: buildMessage({ text: rows.join('\n'), textMarked: [] }),
    });
    rendered.push(view);

    expect(view.container.textContent).toContain('Рядок 20');
    expect(
      view.container.querySelector('button[aria-label="Показати текст повідомлення"]'),
    ).toBeNull();
  });

  it.each([
    [40, false],
    [41, true],
  ] as const)(
    'uses the configured forty-line boundary for %s source rows',
    async (count, overflow) => {
      const rows = Array.from({ length: count }, (_, index) => `Рядок ${index + 1}`);
      const view = await renderCard({
        msg: buildMessage({ text: rows.join('\n'), textMarked: [] }),
        messageTextPreviewLines: 40,
      });
      rendered.push(view);

      expect(view.container.textContent).toContain(`Рядок ${overflow ? 40 : count}`);
      if (overflow) {
        expect(
          view.container.querySelector('button[aria-label="Показати текст повідомлення"]'),
        ).not.toBeNull();
        expect(view.container.textContent).not.toContain('Рядок 41');
      } else {
        expect(
          view.container.querySelector('button[aria-label="Показати текст повідомлення"]'),
        ).toBeNull();
      }
    },
  );

  it('does not truncate message text when preview is off', async () => {
    const rows = Array.from({ length: 41 }, (_, index) => `Рядок ${index + 1}`);
    const view = await renderCard({
      msg: buildMessage({ text: rows.join('\n'), textMarked: [] }),
      messageTextPreviewLines: null,
    });
    rendered.push(view);

    expect(view.container.textContent).toContain('Рядок 41');
    expect(
      view.container.querySelector('button[aria-label="Показати текст повідомлення"]'),
    ).toBeNull();
  });

  it('resets expanded message text when the preview limit changes', async () => {
    const rows = Array.from({ length: 41 }, (_, index) => `Рядок ${index + 1}`);
    const view = await renderCard({
      msg: buildMessage({ text: rows.join('\n'), textMarked: [] }),
      messageTextPreviewLines: 20,
    });
    rendered.push(view);

    const showMoreButton = view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Показати текст повідомлення"]',
    );
    if (showMoreButton == null) throw new Error('Show more button not found');
    await click(showMoreButton);
    expect(view.container.textContent).toContain('Рядок 41');

    await act(async () => {
      view.root.render(
        <AudioTranscriptionPreferencesProvider collapsedByDefault={false}>
          <MessageCard {...view.props} messageTextPreviewLines={40} />
        </AudioTranscriptionPreferencesProvider>,
      );
    });

    expect(view.container.textContent).not.toContain('Рядок 41');
    expect(
      view.container.querySelector('button[aria-label="Показати текст повідомлення"]'),
    ).not.toBeNull();
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
    const tooltipTime = formatMessageCardTooltipTime({
      time: '02:45',
      timestamp: 1_710_000_000_000,
    } as InboxMessage);
    expect(tooltipTime).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(tooltipTime).not.toBe('02:45');
  });

  it('opens the duty navigation menu and routes the old destinations through it', async () => {
    const view = await renderCard({
      msg: { ...buildMessage(), messageUid: 'uid-1' },
    });
    rendered.push(view);

    const navigateButton = view.container.querySelector(`button[aria-label="${NAVIGATE_TITLE}"]`);
    if (!(navigateButton instanceof HTMLButtonElement))
      throw new Error('navigate button not found');
    expect(navigateButton.getAttribute('aria-haspopup')).toBe('menu');
    await click(navigateButton);
    expect(navigateButton.getAttribute('aria-expanded')).toBe('true');
    expect(latestMenuProps).toHaveLength(1);
    const navigationMenuId = latestMenuProps.at(-1)?.id;
    if (navigationMenuId == null) throw new Error('navigation menu id not found');
    expect(view.container.querySelector(`[id="${navigationMenuId}"]`)).not.toBeNull();

    const networkLinks = Array.from(view.container.querySelectorAll('a[href^="/rer-networks/"]'));
    expect(networkLinks).toHaveLength(1);
    expect(networkLinks[0]?.textContent).toContain('В мережу');
    expect(networkLinks[0]?.textContent).toContain('р/м Alpha');
    expect(networkLinks[0]?.getAttribute('target')).toBe('_blank');
    expect(networkLinks[0]?.getAttribute('rel')).toBe('noopener noreferrer');

    const networkUrl = new URL(
      String(networkLinks[0]?.getAttribute('href') ?? ''),
      'https://example.test',
    );
    expect(networkUrl.pathname).toBe('/rer-networks/7');

    const mapLink = Array.from(view.container.querySelectorAll('a')).find((link) =>
      link.textContent?.includes('На мапу'),
    );
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
    const analysisUrl = new URL(
      String(analysisLink.getAttribute('href') ?? ''),
      'https://example.test',
    );
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
    if (!(navigateButton instanceof HTMLButtonElement))
      throw new Error('navigate button not found');
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
    if (!(navigateButton instanceof HTMLButtonElement))
      throw new Error('navigate button not found');
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
    if (!(navigateButton instanceof HTMLButtonElement))
      throw new Error('navigate button not found');
    await click(navigateButton);

    const networkLinks = Array.from(view.container.querySelectorAll('a[href^="/rer-networks/"]'));
    expect(networkLinks).toHaveLength(2);
    expect(networkLinks.map((link) => link.getAttribute('href'))).toEqual([
      '/rer-networks/7',
      '/rer-networks/8',
    ]);
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

  it('renders the location in the top grid for duty cards with resolved networks', async () => {
    const view = await renderCard({
      msg: buildMessage({ location: 'ХАРКІВ', networkIds: [7] }),
    });
    rendered.push(view);

    expect(
      view.container.querySelector('[data-message-header-grid="true"]')?.textContent,
    ).toContain('Харків');
    expect(view.container.textContent).toContain('р/м Alpha');
    expect(
      view.container.querySelector('svg[data-testid="PeopleOutlineOutlinedIcon"]'),
    ).not.toBeNull();
    expect(view.container.querySelector('[aria-label^="Локація:"]')).toBeNull();
    const copyButton = view.container.querySelector(`button[aria-label="${COPY_TITLE}"]`);
    if (!(copyButton instanceof HTMLButtonElement)) throw new Error('copy button not found');
    await click(copyButton);
    expect(view.container.textContent).not.toContain('Копіювати локацію');
  });

  it('renders the location in the top grid for analysis cards with resolved networks', async () => {
    const view = await renderCard({
      displayMode: 'analysis',
      msg: buildMessage({ location: 'ХАРКІВ', networkIds: [7] }),
    });
    rendered.push(view);

    expect(
      view.container.querySelector('[data-message-header-grid="true"]')?.textContent,
    ).toContain('Харків');
    expect(view.container.textContent).toContain('р/м Alpha');
    expect(
      view.container.querySelector('svg[data-testid="PeopleOutlineOutlinedIcon"]'),
    ).not.toBeNull();
    expect(view.container.querySelector('[aria-label^="Локація:"]')).toBeNull();
  });

  it('renders the unit fallback when no networks resolve and no real location exists', async () => {
    const view = await renderCard({
      msg: buildMessage({ networkIds: [], location: null, unit: ' 1-й танк ' }),
    });
    rendered.push(view);

    expect(view.container.textContent).toContain('1-й танк');
    expect(view.container.textContent).not.toContain('—');
    expect(
      view.container.querySelector('svg[data-testid="PeopleOutlineOutlinedIcon"]'),
    ).not.toBeNull();
    const copyButton = view.container.querySelector(`button[aria-label="${COPY_TITLE}"]`);
    if (!(copyButton instanceof HTMLButtonElement)) throw new Error('copy button not found');
    await click(copyButton);
    expect(view.container.textContent).toContain("Копіювати прив'язку");
    expect(view.container.textContent).not.toContain('Копіювати локацію');
  });

  it('renders a dash when no networks resolve and location is missing or unset', async () => {
    const view = await renderCard({
      msg: buildMessage({ networkIds: [], location: 'Не встановлена' }),
    });
    rendered.push(view);

    expect(
      view.container.querySelector('[data-message-header-grid="true"]')?.textContent,
    ).not.toContain('Не встановлена');
    expect(view.container.textContent).toContain('—');
    expect(
      view.container.querySelector('svg[data-testid="PeopleOutlineOutlinedIcon"]'),
    ).not.toBeNull();
    expect(view.container.querySelector('svg[data-testid="PlaceOutlinedIcon"]')).toBeNull();
    expect(view.container.querySelector('[aria-label^="Локація:"]')).toBeNull();
  });

  it('renders analysis actions without timer and with analysis-only callsign controls', async () => {
    const onAddCallsign = vi.fn().mockResolvedValue(true);
    const onRemoveCallsign = vi.fn().mockResolvedValue(true);
    const view = await renderCard({
      displayMode: 'analysis',
      showCallsignAddForm: true,
      analysisCallsignActions: {
        onAddCallsign,
        onRemoveCallsign,
      },
    });
    rendered.push(view);

    expect(view.container.textContent).not.toContain('1 хв');
    expect(view.container.textContent).not.toContain('Відкрити аналіз');
    expect(view.container.textContent).not.toContain('Відкрити мапу тут');
    expect(view.container.textContent).not.toContain('Відкрити мапу в новому вікні');
    expect(view.container.querySelector('button[aria-label="Відкрити мапу тут"]')).toBeNull();
    expect(
      view.container.querySelector('button[aria-label="Відкрити мапу в новому вікні"]'),
    ).toBeNull();
    expect(view.container.querySelector('button[aria-label="Виключити"]')).toBeNull();
    expect(view.container.querySelector('button[aria-label="Мінус"]')).toBeNull();
    expect(view.container.querySelector(`button[aria-label="${NAVIGATE_TITLE}"]`)).not.toBeNull();
    expect(view.container.textContent).not.toContain('Запропоновані позивні');
    expect(view.container.querySelector('input[placeholder="Позивний"]')).not.toBeNull();
    expect(view.container.textContent).toContain('ALPHA');
    expect(view.container.textContent).not.toContain('BRAVO');
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
  });

  it('hides the inline callsign form by default', async () => {
    const view = await renderCard({
      displayMode: 'analysis',
      analysisCallsignActions: {
        onAddCallsign: vi.fn().mockResolvedValue(true),
        onRemoveCallsign: vi.fn().mockResolvedValue(true),
      },
    });
    rendered.push(view);

    expect(view.container.querySelector('input[placeholder="Позивний"]')).toBeNull();
    expect(view.container.querySelector('button[aria-label="Додати позивний"]')).toBeNull();
    expect(view.container.textContent).toContain('ALPHA');
  });

  it('orders duty toolbar actions as report, important, bookmark, copy, edit, navigate, minus', async () => {
    const view = await renderCard({ onEditDetails: vi.fn() });
    rendered.push(view);

    const toolbar = view.container.querySelector('[aria-label="Дії повідомлення"]');
    if (!(toolbar instanceof HTMLElement)) throw new Error('toolbar not found');

    const labels = Array.from(toolbar.querySelectorAll('button')).map((button) =>
      button.getAttribute('aria-label'),
    );
    expect(labels).toEqual([
      'Створити розвіддонесення',
      'Позначити як важливе',
      'Додати в закладки',
      COPY_TITLE,
      'Редагувати',
      NAVIGATE_TITLE,
      EXCLUDE_TITLE,
    ]);
  });

  it('orders analysis toolbar actions as report, important, bookmark, copy, navigate, overflow', async () => {
    const view = await renderCard({
      displayMode: 'analysis',
      onEditDetails: vi.fn(),
      onDelete: vi.fn(),
    });
    rendered.push(view);

    const toolbar = view.container.querySelector('[aria-label="Дії повідомлення"]');
    if (!(toolbar instanceof HTMLElement)) throw new Error('toolbar not found');

    const labels = Array.from(toolbar.querySelectorAll('button')).map((button) =>
      button.getAttribute('aria-label'),
    );
    expect(labels).toEqual([
      'Створити розвіддонесення',
      'Позначити як важливе',
      'Додати в закладки',
      COPY_TITLE,
      'Редагувати',
      NAVIGATE_TITLE,
      'Більше дій',
    ]);
  });

  it('keeps the compact duty toolbar inline when the action column still has room', async () => {
    vi.stubGlobal('ResizeObserver', ResizeObserverMock as unknown as typeof ResizeObserver);
    Object.defineProperty(window, 'ResizeObserver', {
      configurable: true,
      value: ResizeObserverMock,
    });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    expect(window.ResizeObserver).toBe(ResizeObserverMock);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    const view = await renderHeader();
    rendered.push(view);

    const toolbar = view.container.querySelector('[aria-label="Дії повідомлення"]');
    if (!(toolbar instanceof HTMLElement)) throw new Error('toolbar not found');
    const headerRow = view.container.querySelector<HTMLElement>(
      '[data-message-card-header-row="true"]',
    );
    if (!(headerRow instanceof HTMLElement)) throw new Error('header row not found');

    setClientWidth(headerRow, 260);
    await act(async () => {
      resizeObserverCallbacks.forEach((callback) => callback());
    });

    const updatedToolbar = view.container.querySelector('[aria-label="Дії повідомлення"]');
    if (!(updatedToolbar instanceof HTMLElement)) throw new Error('toolbar not found after resize');
    expect(updatedToolbar.getAttribute('role')).toBeNull();
  });

  it('uses stable header capacity to restore the analysis toolbar from stacked to inline', async () => {
    vi.stubGlobal('ResizeObserver', ResizeObserverMock as unknown as typeof ResizeObserver);
    Object.defineProperty(window, 'ResizeObserver', {
      configurable: true,
      value: ResizeObserverMock,
    });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    const view = await renderHeader({ displayMode: 'analysis' });
    rendered.push(view);

    const headerRow = view.container.querySelector<HTMLElement>(
      '[data-message-card-header-row="true"]',
    );
    const toolbar = view.container.querySelector<HTMLElement>('[aria-label="Дії повідомлення"]');
    if (!(headerRow instanceof HTMLElement) || !(toolbar instanceof HTMLElement)) {
      throw new Error('message toolbar header not found');
    }

    setClientWidth(headerRow, 300);
    setClientWidth(toolbar.parentElement as HTMLElement, 80);
    await act(async () => {
      resizeObserverCallbacks.forEach((callback) => callback());
    });
    expect(toolbar.getAttribute('role')).toBeNull();

    setClientWidth(headerRow, 100);
    await act(async () => {
      resizeObserverCallbacks.forEach((callback) => callback());
    });
    expect(toolbar.getAttribute('role')).toBe('group');
    expect(toolbar.getAttribute('data-action-grid-columns')).toBe('3');

    setClientWidth(headerRow, 300);
    await act(async () => {
      resizeObserverCallbacks.forEach((callback) => callback());
    });
    expect(toolbar.getAttribute('role')).toBeNull();
  });

  it('recalculates toolbar fit when the available action count changes', async () => {
    vi.stubGlobal('ResizeObserver', ResizeObserverMock as unknown as typeof ResizeObserver);
    Object.defineProperty(window, 'ResizeObserver', {
      configurable: true,
      value: ResizeObserverMock,
    });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    const view = await renderHeader({ onEditDetails: undefined });
    rendered.push(view);
    const headerRow = view.container.querySelector<HTMLElement>(
      '[data-message-card-header-row="true"]',
    );
    if (!(headerRow instanceof HTMLElement) || !view.headerProps) {
      throw new Error('header row not found');
    }
    const left = view.container.querySelector<HTMLElement>(
      '[data-message-card-header-left="true"]',
    );
    const right = view.container.querySelector<HTMLElement>(
      '[data-message-card-header-right="true"]',
    );
    if (!(left instanceof HTMLElement) || !(right instanceof HTMLElement)) {
      throw new Error('header content not found');
    }

    setClientWidth(headerRow, 220);
    setScrollWidth(left, 0);
    setScrollWidth(right, 0);
    await act(async () => {
      resizeObserverCallbacks.forEach((callback) => callback());
    });
    expect(
      view.container.querySelector('[aria-label="Дії повідомлення"]')?.getAttribute('role'),
    ).toBeNull();

    await act(async () => {
      view.root.render(<MessageCardHeader {...view.headerProps!} onEditDetails={vi.fn()} />);
    });
    expect(
      view.container.querySelector('[aria-label="Дії повідомлення"]')?.getAttribute('role'),
    ).toBe('group');
  });

  it.each([
    ['left', '[data-message-card-header-left="true"]'],
    ['right', '[data-message-card-header-right="true"]'],
  ])('recalculates the toolbar when %s sibling width changes', async (_side, selector) => {
    vi.stubGlobal('ResizeObserver', ResizeObserverMock as unknown as typeof ResizeObserver);
    Object.defineProperty(window, 'ResizeObserver', {
      configurable: true,
      value: ResizeObserverMock,
    });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    const view = await renderHeader({ onEditDetails: undefined });
    rendered.push(view);

    const headerRow = view.container.querySelector<HTMLElement>(
      '[data-message-card-header-row="true"]',
    );
    const sibling = view.container.querySelector<HTMLElement>(selector);
    const left = view.container.querySelector<HTMLElement>(
      '[data-message-card-header-left="true"]',
    );
    const right = view.container.querySelector<HTMLElement>(
      '[data-message-card-header-right="true"]',
    );
    if (
      !(headerRow instanceof HTMLElement) ||
      !(sibling instanceof HTMLElement) ||
      !(left instanceof HTMLElement) ||
      !(right instanceof HTMLElement)
    ) {
      throw new Error('message toolbar measurements not found');
    }

    setClientWidth(headerRow, 220);
    setScrollWidth(left, 0);
    setScrollWidth(right, 0);
    await act(async () => {
      triggerResizeFor(headerRow);
    });
    expect(
      view.container.querySelector('[aria-label="Дії повідомлення"]')?.getAttribute('role'),
    ).toBeNull();

    setScrollWidth(sibling, 80);
    const unobservedElement = document.createElement('div');
    await act(async () => {
      triggerResizeFor(unobservedElement);
    });
    expect(
      view.container.querySelector('[aria-label="Дії повідомлення"]')?.getAttribute('role'),
    ).toBeNull();

    await act(async () => {
      triggerResizeFor(sibling);
    });
    expect(
      view.container.querySelector('[aria-label="Дії повідомлення"]')?.getAttribute('role'),
    ).toBe('group');

    setScrollWidth(sibling, 0);
    await act(async () => {
      triggerResizeFor(sibling);
    });
    expect(
      view.container.querySelector('[aria-label="Дії повідомлення"]')?.getAttribute('role'),
    ).toBeNull();
  });

  it('ignores hidden width measurements before wrapping the compact duty toolbar', async () => {
    vi.stubGlobal('ResizeObserver', ResizeObserverMock as unknown as typeof ResizeObserver);
    Object.defineProperty(window, 'ResizeObserver', {
      configurable: true,
      value: ResizeObserverMock,
    });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    const view = await renderHeader();
    rendered.push(view);

    const toolbar = view.container.querySelector('[aria-label="Дії повідомлення"]');
    if (!(toolbar instanceof HTMLElement)) throw new Error('toolbar not found');
    const headerRow = view.container.querySelector<HTMLElement>(
      '[data-message-card-header-row="true"]',
    );
    if (!(headerRow instanceof HTMLElement)) throw new Error('header row not found');

    setClientWidth(headerRow, 260);
    await act(async () => {
      resizeObserverCallbacks.forEach((callback) => callback());
    });

    const inlineToolbar = view.container.querySelector('[aria-label="Дії повідомлення"]');
    if (!(inlineToolbar instanceof HTMLElement))
      throw new Error('toolbar not found after inline resize');
    expect(inlineToolbar.getAttribute('role')).toBeNull();

    setClientWidth(headerRow, 0);
    await act(async () => {
      resizeObserverCallbacks.forEach((callback) => callback());
    });

    const hiddenToolbar = view.container.querySelector('[aria-label="Дії повідомлення"]');
    if (!(hiddenToolbar instanceof HTMLElement))
      throw new Error('toolbar not found after hidden resize');
    expect(hiddenToolbar.getAttribute('role')).toBeNull();

    setClientWidth(headerRow, 100);
    expect(headerRow.clientWidth).toBe(100);
    expect(resizeObserverCallbacks).toHaveLength(1);
    await act(async () => {
      resizeObserverCallbacks.forEach((callback) => callback());
    });

    const wrappedToolbar = view.container.querySelector('[aria-label="Дії повідомлення"]');
    if (!(wrappedToolbar instanceof HTMLElement))
      throw new Error('toolbar not found after narrow resize');
    expect(wrappedToolbar.getAttribute('role')).toBe('group');
  });

  it('wraps the compact duty toolbar into a 4-column grid when the action column is narrow', async () => {
    vi.stubGlobal('ResizeObserver', ResizeObserverMock as unknown as typeof ResizeObserver);
    Object.defineProperty(window, 'ResizeObserver', {
      configurable: true,
      value: ResizeObserverMock,
    });
    expect(window.ResizeObserver).toBe(ResizeObserverMock);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    const view = await renderHeader();
    rendered.push(view);

    const toolbar = view.container.querySelector('[aria-label="Дії повідомлення"]');
    if (!(toolbar instanceof HTMLElement)) throw new Error('toolbar not found');
    const headerRow = view.container.querySelector<HTMLElement>(
      '[data-message-card-header-row="true"]',
    );
    if (!(headerRow instanceof HTMLElement)) throw new Error('header row not found');

    setClientWidth(headerRow, 100);
    expect(resizeObserverCallbacks).toHaveLength(1);
    await act(async () => {
      resizeObserverCallbacks.forEach((callback) => callback());
    });

    const updatedToolbar = view.container.querySelector('[aria-label="Дії повідомлення"]');
    if (!(updatedToolbar instanceof HTMLElement)) throw new Error('toolbar not found after resize');
    expect(updatedToolbar.getAttribute('role')).toBe('group');
    expect(updatedToolbar.getAttribute('data-action-grid-columns')).toBe('4');
  });

  it('hides overflow in duty mode when no edit or delete actions are available', async () => {
    const view = await renderCard();
    rendered.push(view);

    expect(view.container.querySelector('button[aria-label="Більше дій"]')).toBeNull();
  });

  it('blurs the focused toolbar button before opening the report action', async () => {
    const onCreateReport = vi.fn();
    const view = await renderCard({ onCreateReport });
    rendered.push(view);

    const reportButton = view.container.querySelector(
      'button[aria-label="Створити розвіддонесення"]',
    );
    if (!(reportButton instanceof HTMLButtonElement)) throw new Error('report button not found');
    reportButton.focus();
    expect(document.activeElement).toBe(reportButton);

    await click(reportButton);

    expect(onCreateReport).toHaveBeenCalledTimes(1);
    expect(document.activeElement).not.toBe(reportButton);
  });

  it('shows the edit action in the toolbar and only delete in the overflow menu', async () => {
    const view = await renderCard({
      displayMode: 'analysis',
      onEditDetails: vi.fn(),
      onDelete: vi.fn(),
    });
    rendered.push(view);

    expect(view.container.querySelector('button[aria-label="Редагувати"]')).not.toBeNull();

    const overflowButton = view.container.querySelector('button[aria-label="Більше дій"]');
    if (!(overflowButton instanceof HTMLButtonElement))
      throw new Error('overflow button not found');
    await click(overflowButton);
    expect(latestMenuProps).toHaveLength(1);
    const overflowMenuId = latestMenuProps.at(-1)?.id;
    if (overflowMenuId == null) throw new Error('overflow menu id not found');
    expect(view.container.querySelector(`[id="${overflowMenuId}"]`)).not.toBeNull();

    expect(view.container.textContent).not.toContain('Редагувати додаткові поля та позивні');
    expect(view.container.textContent).toContain('Видалити');
  });

  it('anchors the overflow menu by position instead of a button element', async () => {
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 24,
      height: 24,
      x: 16,
      y: 48,
      top: 48,
      left: 16,
      right: 40,
      bottom: 72,
      toJSON: () => ({}),
    } as DOMRect);

    try {
      const view = await renderCard({
        onEditDetails: vi.fn(),
        onDelete: vi.fn(),
      });
      rendered.push(view);

      const overflowButton = view.container.querySelector('button[aria-label="Більше дій"]');
      if (!(overflowButton instanceof HTMLButtonElement))
        throw new Error('overflow button not found');

      await click(overflowButton);

      expect(latestMenuProps.at(-1)).toMatchObject({
        anchorReference: 'anchorPosition',
        anchorPosition: { top: 72, left: 16 },
        open: true,
      });
    } finally {
      rectSpy.mockRestore();
    }
  });

  it('renders inactive and active important and bookmark icons in the toolbar', async () => {
    const view = await renderCard();
    rendered.push(view);

    expect(view.container.querySelector('svg[data-testid="FlagOutlinedIcon"]')).not.toBeNull();
    expect(
      view.container.querySelector('svg[data-testid="BookmarkBorderOutlinedIcon"]'),
    ).not.toBeNull();

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
    if (!(filterButton instanceof HTMLButtonElement))
      throw new Error('frequency filter button not found');
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

    expect(
      view.container.querySelector('button[aria-label="Позначити як не важливе"]'),
    ).not.toBeNull();
    expect(view.container.querySelector('button[aria-label="Прибрати з закладок"]')).not.toBeNull();
  });

  it('calls the toolbar important/bookmark actions and the overflow edit/delete actions', async () => {
    const onImportant = vi.fn();
    const onBookmark = vi.fn();
    const onEditDetails = vi.fn();
    const onDelete = vi.fn();
    const view = await renderCard({
      displayMode: 'analysis',
      onImportant,
      onBookmark,
      onEditDetails,
      onDelete,
    });
    rendered.push(view);

    const overflowButton = view.container.querySelector('button[aria-label="Більше дій"]');
    if (!(overflowButton instanceof HTMLButtonElement))
      throw new Error('overflow button not found');

    const importantButton = view.container.querySelector(
      'button[aria-label="Позначити як важливе"]',
    );
    if (!(importantButton instanceof HTMLButtonElement))
      throw new Error('important button not found');
    await click(importantButton);
    expect(onImportant).toHaveBeenCalledTimes(1);

    const bookmarkButton = view.container.querySelector('button[aria-label="Додати в закладки"]');
    if (!(bookmarkButton instanceof HTMLButtonElement))
      throw new Error('bookmark button not found');
    await click(bookmarkButton);
    expect(onBookmark).toHaveBeenCalledTimes(1);

    const editButton = view.container.querySelector('button[aria-label="Редагувати"]');
    if (!(editButton instanceof HTMLButtonElement)) throw new Error('edit button not found');
    await click(editButton);
    expect(onEditDetails).toHaveBeenCalledTimes(1);

    await click(overflowButton);
    await click(getButton(view.container, 'Видалити'));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('omits edit and delete from the overflow menu when handlers are absent', async () => {
    const view = await renderCard();
    rendered.push(view);

    expect(view.container.querySelector('button[aria-label="Більше дій"]')).toBeNull();
    expect(view.container.querySelector('button[aria-label="Редагувати"]')).toBeNull();
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
    expect(latestMenuProps).toHaveLength(0);

    const copyButton = view.container.querySelector(`button[aria-label="${COPY_TITLE}"]`);
    if (!(copyButton instanceof HTMLButtonElement)) throw new Error('copy button not found');
    await click(copyButton);

    expect(latestMenuProps).toHaveLength(1);
    const copyMenuId = latestMenuProps.at(-1)?.id;
    if (copyMenuId == null) throw new Error('copy menu id not found');
    expect(view.container.querySelector(`[id="${copyMenuId}"]`)).not.toBeNull();
    expect(view.container.textContent).toContain('Копіювати повідомлення');
    expect(view.container.textContent).toContain('Копіювати частоту');
    expect(view.container.textContent).toContain("Копіювати прив'язку");

    await click(getButton(view.container, 'Копіювати повідомлення'));
    expect(onCopyText).toHaveBeenCalledTimes(1);
    expect(view.container.querySelector(`[id="${copyMenuId}"]`)).toBeNull();

    await click(copyButton);
    expect(view.container.querySelector(`[id="${copyMenuId}"]`)).not.toBeNull();
    await click(getButton(view.container, 'Копіювати частоту'));
    expect(onCopyFreq).toHaveBeenCalledTimes(1);

    await click(copyButton);
    expect(view.container.querySelector(`[id="${copyMenuId}"]`)).not.toBeNull();
    await click(getButton(view.container, "Копіювати прив'язку"));
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
    expect(view.container.textContent).not.toContain("Копіювати прив'язку");
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
    expect(latestMenuProps).toHaveLength(1);
    const excludeMenuId = latestMenuProps.at(-1)?.id;
    if (excludeMenuId == null) throw new Error('exclude menu id not found');
    expect(view.container.querySelector(`[id="${excludeMenuId}"]`)).not.toBeNull();

    const excludeGroupButton = Array.from(view.container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('Виключити групу'),
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
        {
          id: 11,
          messageId: 42,
          comment: 'peer comment',
          login: 'peer-login',
          sigintPostName: null,
        },
        {
          id: 12,
          messageId: 42,
          comment: 'hidden comment',
          login: 'tester',
          sigintPostName: null,
        },
      ],
    });
    rendered.push(view);

    const author = getMuiTypographyElementByText(view.container, 'peer-login');
    const body = getMuiTypographyElementByText(view.container, 'peer comment');
    expect(author.getAttribute('data-mui-variant')).toBe('body2');
    expect(body.getAttribute('data-mui-variant')).toBe('body2');
    expect(author).not.toBe(body);
    expect(view.container.textContent).toContain('peer-login');
    expect(view.container.textContent).toContain('peer comment');
    expect(view.container.textContent).toContain('hidden comment');
  });

  it('renders post name as the author for post-authored comments', async () => {
    const view = await renderCard({
      displayMode: 'analysis',
      messageComments: [
        {
          id: 11,
          messageId: 42,
          comment: 'auto comment',
          login: 'system',
          sigintPostName: 'Пост Альфа',
        },
      ],
    });
    rendered.push(view);

    expect(view.container.textContent).toContain('Пост Альфа');
    expect(view.container.textContent).toContain('auto comment');
    expect(view.container.textContent).not.toContain('system');
  });

  it('renders signal message sender as the author for system comments without post', async () => {
    const view = await renderCard({
      displayMode: 'analysis',
      messageComments: [
        {
          id: 11,
          messageId: 42,
          comment: 'auto comment without post',
          login: 'system',
          sigintPostName: null,
        },
      ],
    });
    rendered.push(view);

    expect(view.container.textContent).toContain('Dow_Jones_2');
    expect(view.container.textContent).toContain('auto comment without post');
    expect(view.container.textContent).not.toContain('system');
  });

  it('collapses other comments after the first three and expands on demand', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const view = await renderCard({
        displayMode: 'analysis',
        messageComments: [
          {
            id: 11,
            messageId: 42,
            comment: 'first comment',
            login: 'other-login-1',
            sigintPostName: null,
          },
          {
            id: 11,
            messageId: 42,
            comment: 'second comment',
            login: 'other-login-2',
            sigintPostName: null,
          },
          {
            id: 11,
            messageId: 42,
            comment: 'third comment',
            login: 'other-login-3',
            sigintPostName: null,
          },
          {
            id: 11,
            messageId: 42,
            comment: 'fourth comment',
            login: 'other-login-4',
            sigintPostName: null,
          },
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
        consoleErrorSpy.mock.calls.some((call) =>
          String(call[0] ?? '').includes('Encountered two children with the same key'),
        ),
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
        alpha: {
          callsign: 'alpha',
          res: [
            {
              id: 1,
              callsign: 'alpha',
              position: '',
              comment: '',
              unit1: '',
              unit2: '',
              unitId: 1,
              networkIdsReportedIn: [],
            },
          ],
        },
        bravo: {
          callsign: 'bravo',
          res: [
            {
              id: 2,
              callsign: 'bravo',
              position: '',
              comment: '',
              unit1: '',
              unit2: '',
              unitId: 1,
              networkIdsReportedIn: [],
            },
          ],
        },
        charlie: {
          callsign: 'charlie',
          res: [
            {
              id: 3,
              callsign: 'charlie',
              position: '',
              comment: '',
              unit1: '',
              unit2: '',
              unitId: 1,
              networkIdsReportedIn: [],
            },
          ],
        },
      },
      analysisCallsignActions: {
        onAddCallsign: vi.fn().mockResolvedValue(true),
        onRemoveCallsign: vi.fn().mockResolvedValue(true),
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
    const tagButton = getButton(view.container, 'переміщення');
    const tipId = tagButton.getAttribute('aria-describedby');
    expect(tipId).toMatch(/^message-card-tag-3-tip-/);
    expect(tipId != null ? document.getElementById(tipId)?.textContent : null).toContain(
      'Користувачі: tester',
    );
    expect(tipId != null ? document.getElementById(tipId)?.textContent : null).toContain(
      'Боти: bot (92%)',
    );
    expect(view.container.textContent).toContain('бот помилився');
    expect(view.container.textContent).toContain('закрити');

    await click(getButton(view.container, 'бот помилився'));
    await click(getButton(view.container, 'закрити'));

    expect(onMarkBotTagWrong).toHaveBeenCalledWith(42, 3);
    expect(onCancelBotTagAction).toHaveBeenCalledTimes(1);
    expect(onToggleTag).not.toHaveBeenCalled();
  });

  it('keeps contribution description ids unique across mounted cards with the same tag', async () => {
    const sharedMsg = buildMessage({
      inboxTags: [
        { id: 1, tagId: 3, confidence: 1, login: 'alpha', model: null, organismId: 1 },
        { id: 2, tagId: 3, confidence: 0.5, login: null, model: 'bot-a', organismId: null },
      ],
    });
    const otherMsg = buildMessage({
      text: 'Друга картка',
      inboxTags: [
        { id: 3, tagId: 3, confidence: 1, login: 'beta', model: null, organismId: 1 },
        { id: 4, tagId: 3, confidence: 0.8, login: null, model: 'bot-b', organismId: null },
      ],
    });
    const first = await renderCard({ msg: sharedMsg, onToggleTag: vi.fn() });
    const second = await renderCard({ id: 43, msg: otherMsg, onToggleTag: vi.fn() });
    rendered.push(first, second);

    const firstTipId = getButton(first.container, 'переміщення').getAttribute('aria-describedby');
    const secondTipId = getButton(second.container, 'переміщення').getAttribute('aria-describedby');
    expect(firstTipId).toMatch(/^message-card-tag-3-tip-/);
    expect(secondTipId).toMatch(/^message-card-tag-3-tip-/);
    expect(firstTipId).not.toBe(secondTipId);
    expect(firstTipId != null ? document.getElementById(firstTipId)?.textContent : null).toContain(
      'alpha',
    );
    expect(
      secondTipId != null ? document.getElementById(secondTipId)?.textContent : null,
    ).toContain('beta');
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
    const audioHost = view.container.querySelector('[data-audio-player-host]');
    expect(audioHost?.tagName).toBe('DIV');
    expect(audioHost?.className).toBe(
      'relative z-0 flex w-full min-h-12 min-w-0 max-w-[460px] items-stretch overflow-hidden pb-1',
    );
    expect(audioHost?.getAttribute('data-audio-player-min-height-px')).toBe('48');
    expect(audioHost?.getAttribute('data-audio-player-top-padding-px')).toBe('0');
    expect(audioHost?.getAttribute('data-audio-player-z-index')).toBe('0');
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

  it('treats application/mp4 attachments as video', () => {
    expect(
      isVideoMediaAttachment({
        id: 'application-mp4',
        href: '/api/messenger/media/application-mp4',
        contentType: ' application/mp4; codecs=avc1 ',
        fileName: 'clip.bin',
        sizeBytes: 1024,
      } as MessageMediaInfo),
    ).toBe(true);
  });

  it('treats common video MIME types and extensions as video', () => {
    expect(
      isVideoMediaAttachment({
        id: 'quicktime',
        href: '/api/messenger/media/quicktime',
        contentType: 'video/quicktime',
        fileName: null,
        sizeBytes: 1024,
      } as MessageMediaInfo),
    ).toBe(true);
    expect(
      isVideoMediaAttachment({
        id: 'matroska',
        href: '/api/messenger/media/matroska',
        contentType: 'application/x-matroska',
        fileName: 'clip.bin',
        sizeBytes: 1024,
      } as MessageMediaInfo),
    ).toBe(true);
    expect(
      isVideoMediaAttachment({
        id: 'avi',
        href: '/api/messenger/media/avi',
        contentType: 'application/octet-stream',
        fileName: 'clip.avi',
        sizeBytes: 1024,
      } as MessageMediaInfo),
    ).toBe(true);
  });

  it('does not classify TypeScript source extensions as video without video MIME', () => {
    for (const extension of ['ts', 'mts']) {
      expect(
        isVideoMediaAttachment({
          id: `typescript-${extension}`,
          href: `/api/messenger/media/typescript-${extension}`,
          contentType: 'application/typescript',
          fileName: `source.${extension}`,
          sizeBytes: 1024,
        } as MessageMediaInfo),
      ).toBe(false);
    }
  });

  it('classifies MPEG transport streams by MIME despite an ambiguous extension', () => {
    expect(
      isVideoMediaAttachment({
        id: 'mpeg-ts',
        href: '/api/messenger/media/mpeg-ts',
        contentType: 'video/mp2t',
        fileName: 'clip.ts',
        sizeBytes: 1024,
      } as MessageMediaInfo),
    ).toBe(true);
  });

  it('uses video classification before ambiguous audio extension fallbacks', () => {
    for (const [id, fileName] of [
      ['mpeg', 'clip.mpeg'],
      ['webm', 'clip.webm'],
    ]) {
      const attachment = {
        id,
        href: `/api/messenger/media/${id}`,
        contentType: 'application/octet-stream',
        fileName,
        sizeBytes: 1024,
      } as MessageMediaInfo;

      expect(isVideoMediaAttachment(attachment)).toBe(true);
      expect(isAudioMediaAttachment(attachment)).toBe(false);
    }

    const applicationMp4 = {
      id: 'application-mp4-audio-name',
      href: '/api/messenger/media/application-mp4-audio-name',
      contentType: 'application/mp4',
      fileName: 'voice.m4a',
      sizeBytes: 1024,
    } as MessageMediaInfo;
    expect(isVideoMediaAttachment(applicationMp4)).toBe(true);
    expect(isAudioMediaAttachment(applicationMp4)).toBe(false);
  });

  it('renders audio attachments with the custom audio player and download link', async () => {
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
    expect(player?.getAttribute('file-name')).toBe('recording.mp3');
    expect(view.container.querySelector('audio')).toBeNull();
    const downloadLink = view.container.querySelector(
      'a[aria-label="Завантажити аудіо: recording.mp3"]',
    );
    expect(downloadLink?.getAttribute('href')).toBe('https://example.test/files/recording.mp3');
    expect(downloadLink?.getAttribute('download')).toBe('recording.mp3');
    expect(downloadLink?.querySelector('[data-testid="DownloadIcon"]')).not.toBeNull();
    expect(downloadLink?.getAttribute('data-mui-size')).toBe('small');
    expect(downloadLink?.getAttribute('data-mui-variant')).toBe('outlined');
    expect(downloadLink?.getAttribute('data-mui-sx')).toContain('minHeight');
    expect(downloadLink?.getAttribute('data-mui-sx')).toContain('text.primary');
    expect(downloadLink?.getAttribute('data-mui-sx')).toContain('divider');
    expect(downloadLink?.getAttribute('data-mui-sx')).toContain('action.hover');
    expect(downloadLink?.getAttribute('data-mui-sx')).toContain('"fontSize":14');
    expect(downloadLink?.textContent).toBe('');
    const audioRow = downloadLink?.closest('.audio-player-row');
    expect(audioRow?.classList).toContain('items-stretch');
    expect(downloadLink?.parentElement?.classList).toContain('self-stretch');
    expect(downloadLink?.parentElement?.classList).toContain('items-center');
  });

  it('gives each audio attachment an independent download cooldown', async () => {
    vi.useFakeTimers();
    try {
      const view = await renderCard({
        msg: {
          ...buildMessage(),
          media: [
            {
              id: 'audio-first',
              href: 'javascript:void(1)',
              contentType: 'audio/mpeg',
              fileName: 'first.mp3',
            },
            {
              id: 'audio-second',
              href: 'javascript:void(0)',
              contentType: 'audio/mpeg',
              fileName: 'second.mp3',
            },
          ] as InboxMessage['media'],
        },
      });
      rendered.push(view);
      const first = view.container.querySelector(
        'a[aria-label="Завантажити аудіо: first.mp3"]',
      ) as HTMLElement;
      const second = view.container.querySelector(
        'a[aria-label="Завантажити аудіо: second.mp3"]',
      ) as HTMLElement;
      const firstClick = await dispatchCancelableClick(first);
      const duplicateClick = await dispatchCancelableClick(first);
      const secondClick = await dispatchCancelableClick(second);

      expect(firstClick.defaultPrevented).toBe(false);
      expect(duplicateClick.defaultPrevented).toBe(true);
      expect(secondClick.defaultPrevented).toBe(false);
      expect(first.getAttribute('aria-busy')).toBe('true');
      expect(second.getAttribute('aria-busy')).toBe('true');
      expect(first.getAttribute('aria-label')).toBe('Завантаження…');
      expect(second.getAttribute('aria-label')).toBe('Завантаження…');

      await act(async () => {
        vi.advanceTimersByTime(MESSAGE_CARD_DOWNLOAD_START_COOLDOWN_MS);
      });
      expect(first.getAttribute('aria-label')).toBe('Завантажити аудіо: first.mp3');
      expect(second.getAttribute('aria-label')).toBe('Завантажити аудіо: second.mp3');
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders a non-empty transcription with its audio player', async () => {
    const view = await renderCard({
      msg: {
        ...buildMessage(),
        media: [
          {
            id: 'audio-transcribed',
            href: '/api/messenger/media/audio-transcribed',
            contentType: 'audio/mpeg',
            fileName: 'transcribed.mp3',
            sizeBytes: 1024,
            transcription: '  Перший рядок.\nДругий рядок.  ',
          },
          {
            id: 'audio-blank-transcription',
            href: '/api/messenger/media/audio-blank-transcription',
            contentType: 'audio/mpeg',
            fileName: 'blank.mp3',
            sizeBytes: 1024,
            transcription: '   ',
          },
        ],
      },
    });
    rendered.push(view);

    const layout = view.container.querySelector('.audio-transcription-layout');
    expect(layout).not.toBeNull();
    expect(view.container.querySelector('.audio-transcription-beside-player')).toBeNull();
    expect(layout?.children).toHaveLength(2);
    const audioRow = layout?.children[0];
    expect(audioRow?.classList).toContain('audio-player-row');
    expect(audioRow?.querySelector('[data-audio-player-host]')).not.toBeNull();
    expect(
      audioRow?.querySelector('a[aria-label="Завантажити аудіо: transcribed.mp3"]'),
    ).not.toBeNull();
    expect(layout?.children[1]?.hasAttribute('data-audio-transcription-control')).toBe(true);

    const transcriptions = view.container.querySelectorAll('[data-audio-transcription]');
    expect(transcriptions).toHaveLength(1);
    expect(transcriptions[0]?.tagName).toBe('BLOCKQUOTE');
    expect(transcriptions[0]?.classList).toContain('audio-transcription');
    expect(transcriptions[0]?.textContent).toBe('Перший рядок.\nДругий рядок.');
    expect(view.container.querySelector('button[aria-label="Транскрибувати аудіо"]')).toBeNull();
  });

  it('keeps transcription collapsed by default and toggles it from the audio control', async () => {
    const view = await renderCard(
      {
        msg: {
          ...buildMessage(),
          media: [
            {
              id: 'audio-collapsed',
              href: '/api/messenger/media/audio-collapsed',
              contentType: 'audio/mpeg',
              fileName: 'collapsed.mp3',
              sizeBytes: 1024,
              transcription: 'Прихований текст',
            },
          ],
        },
      },
      { audioTranscriptionCollapsed: true },
    );
    rendered.push(view);

    const toggle = view.container.querySelector(
      'button[aria-label="Транскрибувати аудіо"]',
    ) as HTMLButtonElement;
    expect(toggle.querySelector('[data-testid="SubtitlesIcon"]')).not.toBeNull();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(view.container.querySelector('[data-audio-transcription]')).toBeNull();

    await click(toggle);

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const transcription = view.container.querySelector('[data-audio-transcription]');
    expect(transcription?.textContent).toBe('Прихований текст');
    expect(transcription?.classList).toContain('audio-transcription--with-toggle');

    await click(toggle);

    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(view.container.querySelector('[data-audio-transcription]')).toBeNull();
  });

  it('does not render transcription controls when audio transcription is disabled', async () => {
    const view = await renderCard(
      {
        msg: {
          ...buildMessage(),
          media: [
            {
              id: 'audio-disabled-transcription',
              href: '/api/messenger/media/audio-disabled-transcription',
              contentType: 'audio/mpeg',
              fileName: 'disabled.mp3',
              sizeBytes: 1024,
              transcription: 'Текст не має відображатися',
            },
          ],
        },
      },
      { audioTranscriptionEnabled: false },
    );
    rendered.push(view);

    expect(view.container.querySelector('custom-audio-player')).not.toBeNull();
    expect(view.container.querySelector('[data-audio-transcription]')).toBeNull();
    expect(view.container.querySelector('button[aria-label="Транскрибувати аудіо"]')).toBeNull();
    expect(view.container.querySelector('.audio-transcription-layout')).toBeNull();
  });

  it('toggles transcriptions longer than three rows between clamped and full text', async () => {
    const view = await renderCard({
      msg: {
        ...buildMessage(),
        media: [
          {
            id: 'audio-long-transcription',
            href: '/api/messenger/media/audio-long-transcription',
            contentType: 'audio/mpeg',
            fileName: 'long.mp3',
            sizeBytes: 1024,
            transcription: 'Перший\nДругий\nТретій\nЧетвертий',
          },
        ],
      },
    });
    rendered.push(view);

    const transcription = view.container.querySelector('[data-audio-transcription]') as HTMLElement;
    expect(transcription.classList).toContain('audio-transcription--clamped');
    expect(transcription.textContent).toContain('ПОКАЗАТИ БІЛЬШЕ');
    expect(transcription.getAttribute('aria-expanded')).toBe('false');

    await click(transcription);

    expect(transcription.classList).not.toContain('audio-transcription--clamped');
    expect(transcription.textContent).not.toContain('ПОКАЗАТИ БІЛЬШЕ');
    expect(transcription.getAttribute('aria-expanded')).toBe('true');

    await click(transcription);

    expect(transcription.classList).toContain('audio-transcription--clamped');
    expect(transcription.textContent).toContain('ПОКАЗАТИ БІЛЬШЕ');
    expect(transcription.getAttribute('aria-expanded')).toBe('false');
  });

  it('does not request derived images for audio attachments larger than 100 MiB', async () => {
    const view = await renderCard({
      msg: {
        ...buildMessage(),
        media: [
          {
            id: 'large-audio',
            href: '/api/messenger/media/large-audio',
            contentType: 'audio/mpeg',
            fileName: 'large.mp3',
            sizeBytes: 100 * 1024 * 1024 + 1,
          },
        ] as InboxMessage['media'],
      },
    });
    rendered.push(view);

    const player = view.container.querySelector('custom-audio-player');
    expect(player?.getAttribute('src')).toBe('/api/messenger/media/large-audio');
    expect(player?.hasAttribute('wave-src')).toBe(false);
    expect(player?.hasAttribute('spectrum-src')).toBe(false);
  });

  it('does not request derived images for large snake_case audio attachments', async () => {
    const view = await renderCard({
      msg: {
        ...buildMessage(),
        media: [
          {
            id: 'large-snake-audio',
            href: '/api/messenger/media/large-snake-audio',
            content_type: 'audio/mpeg',
            file_name: 'large.mp3',
            size_bytes: 100 * 1024 * 1024 + 1,
          },
        ] as InboxMessage['media'],
      },
    });
    rendered.push(view);

    const player = view.container.querySelector('custom-audio-player');
    expect(player?.getAttribute('src')).toBe('/api/messenger/media/large-snake-audio');
    expect(player?.hasAttribute('wave-src')).toBe(false);
    expect(player?.hasAttribute('spectrum-src')).toBe(false);
  });

  it('requests derived images for explicitly typed WebM audio', async () => {
    const view = await renderCard({
      msg: {
        ...buildMessage(),
        media: [
          {
            id: 'webm-audio',
            href: '/api/messenger/media/webm-audio',
            contentType: ' Audio/WebM; codecs=opus ',
            fileName: 'voice.webm',
            sizeBytes: 1024,
          },
        ] as InboxMessage['media'],
      },
    });
    rendered.push(view);

    const player = view.container.querySelector('custom-audio-player');
    expect(player?.getAttribute('src')).toBe('/api/messenger/media/webm-audio');
    expect(player?.getAttribute('wave-src')).toBe('/api/messenger/media/webm-audio/wave');
    expect(player?.getAttribute('spectrum-src')).toBe(
      '/api/messenger/media/webm-audio/spectrogram',
    );
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
      Array.from(view.container.querySelectorAll('button')).some((button) =>
        button.textContent?.includes('intercept.mp3'),
      ),
    ).toBe(false);
  });

  it('renders attachments with a download icon and consistent minimum width', async () => {
    const view = await renderCard({
      msg: {
        ...buildMessage(),
        media: [
          {
            id: 1,
            href: 'https://example.test/files/HByMR1VD5nrYaiQRyaFV.bin',
            contentType: 'application/octet-stream',
            fileName: 'HByMR1VD5nrYaiQRyaFV.bin',
          },
          {
            id: 2,
            href: 'https://example.test/files/8a7d0703-4f44-4ce8-b95a-8a2e.bin',
            contentType: 'application/octet-stream',
            fileName: '8a7d0703-4f44-4ce8-b95a-8a2e.bin',
          },
        ] as InboxMessage['media'],
      },
    });
    rendered.push(view);

    const downloadButtons = Array.from(
      view.container.querySelectorAll('[data-mui-variant="outlined"]'),
    ).filter((button) => button.textContent?.includes('.bin'));
    expect(downloadButtons).toHaveLength(2);
    expect(downloadButtons[0]?.querySelector('svg')).not.toBeNull();
    expect(downloadButtons[1]?.querySelector('svg')).not.toBeNull();
    expect(downloadButtons[0]?.getAttribute('data-mui-variant')).toBe('outlined');
    expect(downloadButtons[1]?.getAttribute('data-mui-variant')).toBe('outlined');
    expect(downloadButtons[0]?.getAttribute('data-mui-sx')).toContain('text.primary');
    expect(downloadButtons[0]?.getAttribute('data-mui-sx')).toContain('divider');
    expect(downloadButtons[0]?.getAttribute('data-mui-sx')).toContain('action.hover');
    expect(downloadButtons[0]?.textContent).toContain('HByMR1VD5nrYaiQRyaFV.bin');
    expect(downloadButtons[1]?.textContent).toContain('8a7d0703-4f44-4ce8-b95a-8a2e.bin');
  });

  it('shows the message attachment archive link only for multiple attachments', async () => {
    const singleAttachment = await renderCard({
      msg: {
        ...buildMessage(),
        media: [
          {
            id: 'single',
            href: '/api/messenger/media/single',
            contentType: 'text/plain',
            fileName: 'single.txt',
          },
        ] as InboxMessage['media'],
      },
    });
    rendered.push(singleAttachment);
    expect(singleAttachment.container.textContent).not.toContain('Завантажити все');

    const multipleAttachments = await renderCard({
      msg: {
        ...buildMessage(),
        media: [
          {
            id: 'first',
            href: '/api/messenger/media/first',
            contentType: 'text/plain',
            fileName: 'first.txt',
            sizeBytes: 1,
          },
          {
            id: 'second',
            href: '/api/messenger/media/second',
            contentType: 'text/plain',
            fileName: 'second.txt',
            sizeBytes: 1,
          },
        ] as InboxMessage['media'],
      },
    });
    rendered.push(multipleAttachments);

    const archiveLink = multipleAttachments.container.querySelector(
      'a[aria-label="Завантажити все"]',
    );
    expect(archiveLink).not.toBeNull();
    expect(archiveLink?.tagName).toBe('A');
    expect(archiveLink?.getAttribute('href')).toBe('/api/rer-importer/messages/42/attachments.zip');
    expect(archiveLink?.getAttribute('download')).toBe('attachments.zip');
    expect(archiveLink?.querySelector('[data-testid="DownloadIcon"]')).not.toBeNull();
    expect(archiveLink?.querySelector('[data-testid="DownloadOutlinedIcon"]')).toBeNull();
    expect(archiveLink?.getAttribute('data-mui-size')).toBe('small');
    expect(archiveLink?.getAttribute('data-mui-variant')).toBe('outlined');
    expect(archiveLink?.getAttribute('data-mui-sx')).toContain('text.primary');
    expect(archiveLink?.getAttribute('data-mui-sx')).toContain('divider');
    expect(archiveLink?.getAttribute('data-mui-sx')).toContain('action.hover');
    expect(archiveLink?.parentElement?.parentElement?.className).toContain('mt-1');
    expect(archiveLink?.parentElement?.parentElement?.className).toContain('items-start');
  });

  it('guards each download key independently for its own cooldown', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.spyOn(window, 'fetch').mockResolvedValue(new Response());
    try {
      const firstCard = await renderCard({
        msg: {
          ...buildMessage(),
          media: [
            {
              id: 'first',
              href: 'javascript:void(1)',
              contentType: 'text/plain',
              fileName: 'first.txt',
              sizeBytes: 1,
            },
            {
              id: 'second',
              href: 'javascript:void(0)',
              contentType: 'text/plain',
              fileName: 'second.txt',
              sizeBytes: 1,
            },
          ] as InboxMessage['media'],
        },
      });
      rendered.push(firstCard);

      const archive = firstCard.container.querySelector('a[aria-label="Завантажити все"]');
      const downloadLinks = Array.from(firstCard.container.querySelectorAll('a[download]'));
      const individualLinks = downloadLinks.filter((link) => link !== archive);
      const firstIndividual = individualLinks[0];
      const secondIndividual = individualLinks[1];
      expect(archive).not.toBeNull();
      expect(firstIndividual).not.toBeNull();
      expect(secondIndividual).not.toBeNull();
      (archive as HTMLAnchorElement).href = 'javascript:void(0)';

      const firstClick = await dispatchCancelableClick(firstIndividual as HTMLElement);
      expect(firstIndividual?.getAttribute('aria-label')).toBe('Завантаження…');
      const duplicateClick = await dispatchCancelableClick(firstIndividual as HTMLElement);
      expect(firstClick.defaultPrevented).toBe(false);
      expect(duplicateClick.defaultPrevented).toBe(true);
      expect(firstIndividual?.getAttribute('aria-label')).toBe('Завантаження…');
      expect(firstIndividual?.querySelector('[aria-label="Завантаження…"]')).not.toBeNull();
      expect(
        firstIndividual?.parentElement?.hasAttribute('data-disabled-control-cursor-wrapper'),
      ).toBe(true);
      expect(secondIndividual?.getAttribute('disabled')).toBeNull();
      expect(archive?.getAttribute('disabled')).toBeNull();

      await act(async () => {
        vi.advanceTimersByTime(1_000);
      });
      const secondClick = await dispatchCancelableClick(secondIndividual as HTMLElement);
      expect(secondClick.defaultPrevented).toBe(false);
      expect(secondIndividual?.getAttribute('aria-label')).toBe('Завантаження…');
      expect(firstIndividual?.getAttribute('disabled')).not.toBeNull();
      expect(archive?.getAttribute('disabled')).toBeNull();

      await act(async () => {
        vi.advanceTimersByTime(1_000);
      });
      const archiveClick = await dispatchCancelableClick(archive as HTMLElement);
      expect(archiveClick.defaultPrevented).toBe(false);
      expect(archive?.getAttribute('aria-label')).toBe('Завантаження…');
      expect(firstIndividual?.getAttribute('disabled')).not.toBeNull();
      expect(secondIndividual?.getAttribute('disabled')).not.toBeNull();

      await act(async () => {
        vi.advanceTimersByTime(1_000);
      });
      expect(firstIndividual?.getAttribute('disabled')).toBeNull();
      expect(secondIndividual?.getAttribute('disabled')).not.toBeNull();
      expect(archive?.getAttribute('disabled')).not.toBeNull();

      await act(async () => {
        vi.advanceTimersByTime(1_000);
      });
      expect(secondIndividual?.getAttribute('disabled')).toBeNull();
      expect(archive?.getAttribute('disabled')).not.toBeNull();

      await act(async () => {
        vi.advanceTimersByTime(1_000);
      });
      expect(archive?.getAttribute('aria-label')).toBe('Завантажити все');
      expect(archive?.getAttribute('disabled')).toBeNull();
    } finally {
      fetchMock.mockRestore();
      vi.useRealTimers();
    }
  });

  it.each([
    ['exactly at the limit', [RER_MESSAGE_ATTACHMENTS_ZIP_MAX_TOTAL_BYTES, 0], true],
    ['over the limit', [RER_MESSAGE_ATTACHMENTS_ZIP_MAX_TOTAL_BYTES, 1], false],
    ['missing metadata', [undefined, 1], false],
    ['negative metadata', [-1, 1], false],
    ['non-finite metadata', [Number.NaN, 1], false],
  ])('validates archive visibility for %s metadata', async (_, sizes, expected) => {
    const attachments = sizes.map((sizeBytes, index) => ({
      id: `size-${index}`,
      href: `/api/messenger/media/size-${index}`,
      contentType: 'text/plain',
      fileName: `size-${index}.txt`,
      ...(sizeBytes === undefined ? {} : { sizeBytes }),
    })) as InboxMessage['media'];

    expect(canDownloadAllMessageAttachments(attachments)).toBe(expected);
    const view = await renderCard({
      msg: { ...buildMessage(), media: attachments },
    });
    rendered.push(view);
    expect(view.container.querySelector('a[aria-label="Завантажити все"]') !== null).toBe(expected);
  });

  it('keeps individual downloads visible when archive metadata is unavailable', async () => {
    const view = await renderCard({
      msg: {
        ...buildMessage(),
        media: [
          {
            id: 'unknown-first',
            href: '/api/messenger/media/unknown-first',
            contentType: 'text/plain',
            fileName: 'first.txt',
          },
          {
            id: 'unknown-second',
            href: '/api/messenger/media/unknown-second',
            contentType: 'text/plain',
            fileName: 'second.txt',
          },
        ] as InboxMessage['media'],
      },
    });
    rendered.push(view);

    expect(view.container.querySelector('a[aria-label="Завантажити все"]')).toBeNull();
    expect(view.container.querySelectorAll('a[download]')).toHaveLength(2);
  });

  it.each([
    [RER_MESSAGE_ATTACHMENTS_ZIP_MAX_FILES, true],
    [RER_MESSAGE_ATTACHMENTS_ZIP_MAX_FILES + 1, false],
  ])('applies the archive file-count limit at %s attachments', async (count, expected) => {
    const media = Array.from({ length: count }, (_, index) => ({
      id: `count-${index}`,
      href: `/api/messenger/media/count-${index}`,
      contentType: 'text/plain',
      fileName: `count-${index}.txt`,
      sizeBytes: 1,
    })) as InboxMessage['media'];
    const view = await renderCard({ msg: { ...buildMessage(), media } });
    rendered.push(view);

    expect(view.container.querySelector('a[aria-label="Завантажити все"]') !== null).toBe(expected);
    expect(view.container.querySelectorAll('a[download]')).toHaveLength(count + (expected ? 1 : 0));
  });

  it.each([
    ['image', 'image/jpeg', 'image.jpg'],
    ['audio', 'audio/mpeg', 'audio.mp3'],
    ['video', 'video/mp4', 'video.mp4'],
    ['document', 'text/plain', 'document.txt'],
  ])('places the archive action below the %s attachment area', async (_, contentType, fileName) => {
    const view = await renderCard({
      msg: {
        ...buildMessage(),
        media: [
          {
            id: `${fileName}-1`,
            href: `/media/${fileName}-1`,
            contentType,
            fileName,
            sizeBytes: 1,
          },
          {
            id: `${fileName}-2`,
            href: `/media/${fileName}-2`,
            contentType,
            fileName,
            sizeBytes: 1,
          },
        ] as InboxMessage['media'],
      },
    });
    rendered.push(view);

    const archiveLink = view.container.querySelector('a[aria-label="Завантажити все"]');
    expect(archiveLink).not.toBeNull();
    const attachmentArea = archiveLink?.parentElement?.parentElement;
    expect(attachmentArea?.tagName).toBe('DIV');
    expect(attachmentArea?.className).toContain('mt-1');
    expect(attachmentArea?.className).toContain('items-start');
    expect(attachmentArea?.children).toHaveLength(1);
    expect(archiveLink?.querySelector('[data-testid="DownloadIcon"]')).not.toBeNull();
  });

  it('renders document attachments with preview and download affordances', async () => {
    const view = await renderCard({
      msg: {
        ...buildMessage(),
        media: [
          {
            id: 'doc-1',
            href: 'https://example.test/files/report.pdf',
            contentType: 'application/pdf',
            fileName: 'report.pdf',
            sizeBytes: 2048,
          },
        ] as InboxMessage['media'],
      },
    });
    rendered.push(view);

    const documentButton = Array.from(view.container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('report.pdf'),
    );
    expect(documentButton).not.toBeNull();
    expect(view.container.textContent).toContain('report.pdf');
    (documentButton as HTMLButtonElement).focus();
    expect(document.activeElement).toBe(documentButton);

    await click(documentButton as HTMLElement);

    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain(
      'document-dialog',
    );
    expect(document.activeElement).not.toBe(documentButton);

    const downloadLink = view.container.querySelector('a[aria-label="Завантажити"]');
    expect(downloadLink).not.toBeNull();
    expect(downloadLink?.getAttribute('href')).toBe('https://example.test/files/report.pdf');
    expect(downloadLink?.getAttribute('download')).toBe('report.pdf');
    expect(view.container.querySelector('button[aria-label="Попередній перегляд"]')).toBeNull();
  });

  it('guards a document preview download when the same file starts in the card', async () => {
    const view = await renderCard({
      msg: {
        ...buildMessage(),
        media: [
          {
            id: 'document-preview-1',
            href: 'javascript:void(0)',
            contentType: 'application/pdf',
            fileName: 'report.pdf',
            sizeBytes: 2048,
          },
        ] as InboxMessage['media'],
      },
    });
    rendered.push(view);

    const documentButton = Array.from(view.container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('report.pdf'),
    );
    expect(documentButton).not.toBeNull();
    await click(documentButton as HTMLElement);

    const cardDownload = view.container.querySelector('a[download="report.pdf"]');
    const previewDownload = document.body.querySelector('a[data-preview-download]');
    expect(cardDownload).not.toBeNull();
    expect(previewDownload).not.toBeNull();

    cardDownload?.addEventListener('click', (event) => event.preventDefault(), {
      capture: true,
      once: true,
    });
    await dispatchCancelableClick(cardDownload as HTMLElement);

    expect(previewDownload?.getAttribute('disabled')).not.toBeNull();
    expect(previewDownload?.getAttribute('aria-busy')).toBe('true');
    expect(previewDownload?.getAttribute('aria-label')).toBe('Завантаження…');
    expect(previewDownload?.textContent).toContain('spinner');

    const duplicateEvent = await dispatchCancelableClick(previewDownload as HTMLElement);
    expect(duplicateEvent.defaultPrevented).toBe(true);
  });

  it('opens mixed previewable documents in the clicked position and preserves order', async () => {
    const view = await renderCard({
      msg: {
        ...buildMessage(),
        media: [
          {
            id: 'pdf-1',
            href: 'https://example.test/files/report.pdf',
            contentType: 'application/pdf',
            fileName: 'report.pdf',
            sizeBytes: 2048,
          },
          {
            id: 'txt-1',
            href: 'https://example.test/files/notes.txt',
            contentType: 'text/plain',
            fileName: 'notes.txt',
            sizeBytes: 1024,
          },
          {
            id: 'md-1',
            href: 'https://example.test/files/readme.md',
            contentType: 'text/markdown',
            fileName: 'readme.md',
            sizeBytes: 512,
          },
        ] as InboxMessage['media'],
      },
    });
    rendered.push(view);

    const documentButtons = Array.from(view.container.querySelectorAll('button')).filter((button) =>
      button.textContent?.includes('.'),
    );
    expect(documentButtons).toHaveLength(3);
    expect(documentButtons.map((button) => button.textContent?.trim())).toEqual([
      'report.pdf',
      'notes.txt',
      'readme.md',
    ]);

    await click(documentButtons[2] as HTMLButtonElement);

    expect(latestDocumentDialogProps.at(-1)?.open).toBe(true);
    expect(latestDocumentDialogProps.at(-1)?.currentIndex).toBe(2);
    expect(latestDocumentDialogProps.at(-1)?.document?.kind).toBe('md');
  });

  it('shows selected tags first and can reveal the rest on demand', async () => {
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        const isTag = this.hasAttribute('data-message-card-tag-id');
        const width = isTag ? 60 : TAG_ROW_MEASURE_WIDTH_PX;
        const top = isTag && this.getAttribute('data-message-card-tag-id') !== '3' ? 40 : 0;
        return {
          width,
          height: 32,
          x: 0,
          y: top,
          top,
          left: 0,
          right: width,
          bottom: top + 32,
          toJSON: () => ({}),
        } as DOMRect;
      });

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

  it('keeps compact expand when long tag chips exceed the estimate former 240px cap', async () => {
    const cardWidthPx = 500;
    const chipWidthPx = 300;
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function mockRect(this: HTMLElement) {
        const isChip = this.hasAttribute('data-message-card-tag-id');
        const width = isChip ? chipWidthPx : cardWidthPx;
        return {
          width,
          height: 32,
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          right: width,
          bottom: 32,
          toJSON: () => ({}),
        } as DOMRect;
      });

    try {
      const longA = 'Дуже-довга-адмін-мітка-альфа-для-компактного-режиму';
      const longB = 'Дуже-довга-адмін-мітка-бета-для-компактного-режиму';
      const view = await renderCard({
        tagsLayout: 'compact',
        tagsMap: {
          3: { id: 3, label: longA, isPalitra: false },
          4: { id: 4, label: longB, isPalitra: false },
        } as Record<number, Tag>,
        msg: buildMessage({
          tags: [3, 4],
          inboxTags: [
            { id: 1, tagId: 3, confidence: 1, login: 'tester', model: null, organismId: null },
          ],
        }),
      });
      rendered.push(view);

      // Two ~300px chips in a ~500px card must not be treated as a single unwrapped row.
      expect(view.container.textContent).toContain(longA);
      expect(view.container.textContent).toContain('розгорнути');
      expect(view.container.textContent).not.toContain(longB);
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
          inboxTags: [
            { id: 1, tagId: 3, confidence: 1, login: 'tester', model: null, organismId: 1 },
          ],
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
        view.root.render(
          <AudioTranscriptionPreferencesProvider collapsedByDefault={false}>
            <MessageCard {...nextProps} />
          </AudioTranscriptionPreferencesProvider>,
        );
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
        inboxTags: [
          { id: 1, tagId: 7, confidence: 1, login: 'tester', model: null, organismId: 1 },
        ],
      }),
    });
    rendered.push(view);

    expect(getTagButtonLabels(view.container)).toEqual([
      'переміщення',
      'зв’язок',
      'РЕБ',
      'арта',
      'палітра',
      'іфо',
      'розвідка',
    ]);
  });

  it('shows a tags spinner before analysis tags load', async () => {
    const view = await renderCard({ displayMode: 'analysis', tagsLoading: true, tagsMap: {} });
    rendered.push(view);

    expect(view.container.textContent).toContain('tags-loading');
    expect(view.container.textContent).not.toContain('переміщення');
  });

  it('renders tags in read-only mode without mutation controls', async () => {
    const onToggleTag = vi.fn();
    const view = await renderCard({ readOnly: true, onToggleTag });
    rendered.push(view);

    expect(view.container.querySelector('[data-message-card-tag-id="3"]')).not.toBeNull();
    expect(view.container.textContent).toContain('переміщення');
    expect(view.container.textContent).toContain('зв’язок');
    expect(view.container.textContent).toContain('РЕБ');
    expect(view.container.querySelector('button[aria-label="Редагувати"]')).toBeNull();
    expect(view.container.querySelector('button[aria-label="Позначити як важливе"]')).toBeNull();
    expect(view.container.querySelector('button[aria-label="Додати в закладки"]')).toBeNull();
    expect(
      view.container.querySelector('button[aria-label="Створити розвіддонесення"]'),
    ).toBeNull();
    expect(view.container.querySelector('button[aria-label^="Виключити"]')).toBeNull();

    await click(view.container.querySelector('[data-message-card-tag-id="3"]') as HTMLElement);

    expect(onToggleTag).not.toHaveBeenCalled();
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

  it('renders mock image thumbnails as preview buttons', async () => {
    const view = await renderCard({
      msg: { ...buildMessage(), ...inboxMessageWithMockImages() },
    });
    rendered.push(view);

    const imgs = view.container.querySelectorAll('img');
    expect(imgs.length).toBe(2);
    imgs.forEach((img) => {
      const thumb = img.closest('button');
      expect(thumb).not.toBeNull();
      expect(thumb?.getAttribute('aria-label')).toBe('Відкрити зображення');
      expect(thumb?.getAttribute('data-picture-thumb-state')).toBe('loaded');
      expect(thumb?.getAttribute('data-picture-thumb-layout')).toBe('multi');
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
    expect(img?.closest('button')?.getAttribute('data-picture-thumb-state')).toBe('loading');
    expect(img?.closest('button')?.getAttribute('data-picture-thumb-layout')).toBe('single');
    expect(view.container.textContent).toContain('Зображення');

    await act(async () => {
      img?.dispatchEvent(new Event('error', { bubbles: true }));
    });

    expect(view.container.querySelector('img')).not.toBeNull();
    const thumb = img?.closest('button');
    expect(thumb?.getAttribute('data-picture-thumb-state')).toBe('failed');
    expect(view.container.textContent).toContain('Зображення недоступне');
  });

  it('reuses cached thumbnail state and size after remount', async () => {
    const href = 'https://example.test/files/cache-loaded.png';
    const firstView = await renderCard({
      msg: {
        ...buildMessage(),
        images: [href],
      },
    });
    rendered.push(firstView);

    const firstThumb = firstView.container.querySelector(
      'button[aria-label="Відкрити зображення"]',
    );
    const firstImage = firstThumb?.querySelector('img');
    if (!(firstImage instanceof HTMLImageElement)) throw new Error('thumbnail image not found');
    Object.defineProperty(firstImage, 'naturalWidth', { configurable: true, value: 1200 });
    Object.defineProperty(firstImage, 'naturalHeight', { configurable: true, value: 800 });

    await act(async () => {
      firstImage.dispatchEvent(new Event('load', { bubbles: true }));
    });

    expect(firstThumb?.getAttribute('data-picture-thumb-state')).toBe('loaded');

    await act(async () => {
      firstView.root.unmount();
    });
    firstView.container.remove();

    const secondView = await renderCard({
      msg: {
        ...buildMessage(),
        images: [href],
      },
    });
    rendered.push(secondView);

    const secondThumb = secondView.container.querySelector(
      'button[aria-label="Відкрити зображення"]',
    );
    expect(secondThumb?.getAttribute('data-picture-thumb-state')).toBe('loading');
    expect(secondThumb?.querySelector('img')).not.toBeNull();

    const secondImage = secondThumb?.querySelector('img');
    if (!(secondImage instanceof HTMLImageElement))
      throw new Error('thumbnail image not found after remount');
    Object.defineProperty(secondImage, 'naturalWidth', { configurable: true, value: 1200 });
    Object.defineProperty(secondImage, 'naturalHeight', { configurable: true, value: 800 });

    await act(async () => {
      secondImage.dispatchEvent(new Event('load', { bubbles: true }));
    });

    expect(secondThumb?.getAttribute('data-picture-thumb-state')).toBe('loaded');
  });

  it('reuses cached failed thumbnail state after remount', async () => {
    const href = 'https://example.test/files/cache-failed.png';
    const firstView = await renderCard({
      msg: {
        ...buildMessage(),
        images: [href],
      },
    });
    rendered.push(firstView);

    const firstThumb = firstView.container.querySelector(
      'button[aria-label="Відкрити зображення"]',
    );
    const firstImage = firstThumb?.querySelector('img');
    if (firstImage == null) throw new Error('thumbnail image not found');

    await act(async () => {
      firstImage.dispatchEvent(new Event('error', { bubbles: true }));
    });

    expect(firstThumb?.getAttribute('data-picture-thumb-state')).toBe('failed');

    await act(async () => {
      firstView.root.unmount();
    });
    firstView.container.remove();

    const secondView = await renderCard({
      msg: {
        ...buildMessage(),
        images: [href],
      },
    });
    rendered.push(secondView);

    const secondThumb = secondView.container.querySelector(
      'button[aria-label="Відкрити зображення"]',
    );
    expect(secondThumb?.getAttribute('data-picture-thumb-state')).toBe('loading');
    expect(secondThumb?.querySelector('img')).not.toBeNull();

    const secondImage = secondThumb?.querySelector('img');
    if (secondImage == null) throw new Error('thumbnail image not found after remount');

    await act(async () => {
      secondImage.dispatchEvent(new Event('error', { bubbles: true }));
    });

    expect(secondThumb?.getAttribute('data-picture-thumb-state')).toBe('failed');
    expect(secondView.container.textContent).toContain('Зображення недоступне');
  });

  it('renders a bounded single-image preview and opens the dialog', async () => {
    const view = await renderCard({
      msg: {
        ...buildMessage(),
        images: ['https://example.test/files/single-image.png'],
      },
    });
    rendered.push(view);

    const thumb = view.container.querySelector('button[aria-label="Відкрити зображення"]');
    expect(thumb).not.toBeNull();
    expect(thumb?.getAttribute('data-picture-thumb-layout')).toBe('single');

    const image = thumb?.querySelector('img');
    if (image == null) throw new Error('thumbnail image not found');
    Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 1200 });
    Object.defineProperty(image, 'naturalHeight', { configurable: true, value: 800 });

    await act(async () => {
      image.dispatchEvent(new Event('load', { bubbles: true }));
    });

    expect(thumb?.getAttribute('data-picture-thumb-state')).toBe('loaded');
    expect(image.getAttribute('loading')).toBe('lazy');
    expect(image.getAttribute('decoding')).toBe('async');
    expect(image.getAttribute('fetchpriority')).toBe('low');

    await click(thumb as HTMLElement);

    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain('1 / 1');
    expect(dialog?.querySelector('[data-attachment-preview-nav="prev"]')).toBeNull();
    expect(dialog?.querySelector('[data-attachment-preview-nav="next"]')).toBeNull();
    expect(dialog?.querySelector('img[data-image-preview-image]')?.getAttribute('decoding')).toBe(
      'async',
    );
    expect(
      dialog?.querySelector('img[data-image-preview-image]')?.getAttribute('loading'),
    ).toBeNull();
    expect(
      dialog?.querySelector('img[data-image-preview-image]')?.getAttribute('fetchpriority'),
    ).toBeNull();
  });

  it('fits vertical single images within the height cap', async () => {
    const view = await renderCard({
      msg: {
        ...buildMessage(),
        images: ['https://example.test/files/vertical-image.png'],
      },
    });
    rendered.push(view);

    const thumb = view.container.querySelector('button[aria-label="Відкрити зображення"]');
    expect(thumb).not.toBeNull();

    const image = thumb?.querySelector('img');
    if (image == null) throw new Error('thumbnail image not found');
    Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 800 });
    Object.defineProperty(image, 'naturalHeight', { configurable: true, value: 1200 });

    await act(async () => {
      image.dispatchEvent(new Event('load', { bubbles: true }));
    });

    expect(thumb?.getAttribute('data-picture-thumb-state')).toBe('loaded');
  });

  it('opens the preview dialog and lets the carousel change the current image', async () => {
    const view = await renderCard({
      msg: {
        ...buildMessage(),
        images: [
          'https://example.test/files/preview-1.png',
          'https://example.test/files/preview-2.png',
        ],
      },
    });
    rendered.push(view);

    const thumb = view.container.querySelector('button[aria-label="Відкрити зображення"]');
    expect(thumb).not.toBeNull();

    await click(thumb as HTMLElement);

    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain('1 / 2');
    expect(dialog?.querySelector('img[data-image-preview-image]')?.getAttribute('src')).toBe(
      'https://example.test/files/preview-1.png',
    );

    const stage = dialog?.querySelector('[data-image-preview-stage]') as HTMLElement | null;
    if (stage == null) throw new Error('preview stage not found');

    await act(async () => {
      stage.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -120 }));
    });

    expect(
      Number(
        dialog
          ?.querySelector('img[data-image-preview-image]')
          ?.getAttribute('data-image-preview-zoom'),
      ),
    ).toBeCloseTo(100 * Math.exp(120 * 0.0015), 6);
    expect(dialog?.querySelector('[data-attachment-preview-nav="prev"]')).not.toBeNull();
    expect(dialog?.querySelector('[data-attachment-preview-nav="next"]')).not.toBeNull();
    expect(dialog?.querySelector('input[type="range"]')).toBeNull();
    expect(dialog?.textContent).toContain('120%');

    const nextButton = dialog?.querySelector('button[aria-label="Наступне"]');
    expect(nextButton).not.toBeNull();
    await click(nextButton as HTMLElement);

    expect(dialog?.textContent).toContain('2 / 2');
    expect(dialog?.querySelector('img[data-image-preview-image]')?.getAttribute('src')).toBe(
      'https://example.test/files/preview-2.png',
    );
    expect(
      dialog
        ?.querySelector('img[data-image-preview-image]')
        ?.getAttribute('data-image-preview-zoom'),
    ).toBe('100');

    const downloadLink = dialog?.querySelector('a[download]');
    expect(downloadLink?.getAttribute('href')).toBe('https://example.test/files/preview-2.png');
    expect(downloadLink?.getAttribute('download')).toBe('preview-2.png');

    const rawLink = dialog?.querySelector('a[aria-label="Відкрити в новій вкладці"]');
    expect(rawLink?.getAttribute('href')).toBe('https://example.test/files/preview-2.png');
    expect(rawLink?.getAttribute('target')).toBe('_blank');
    expect(rawLink?.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('continues the attachment carousel from an image into a document preview', async () => {
    const view = await renderCard({
      msg: {
        ...buildMessage(),
        images: ['https://example.test/files/preview.png'],
        media: [
          {
            id: 'document-1',
            href: 'https://example.test/files/report.pdf',
            contentType: 'application/pdf',
            fileName: 'report.pdf',
            sizeBytes: 2048,
          },
        ] as InboxMessage['media'],
      },
    });
    rendered.push(view);

    await click(
      view.container.querySelector('button[aria-label="Відкрити зображення"]') as HTMLElement,
    );

    const imageDialog = document.body.querySelector('[role="dialog"]');
    expect(imageDialog?.textContent).toContain('1 / 2');

    await click(imageDialog?.querySelector('button[aria-label="Наступне"]') as HTMLElement);

    const documentDialog = document.body.querySelector('[role="dialog"]');
    expect(documentDialog?.textContent).toContain('document-dialog');
    expect(latestDocumentDialogProps.at(-1)?.currentIndex).toBe(1);
  });

  it('does not show carousel controls for a single-image preview', async () => {
    const view = await renderCard({
      msg: {
        ...buildMessage(),
        images: ['https://example.test/files/single-image.png'],
      },
    });
    rendered.push(view);

    const thumb = view.container.querySelector('button[aria-label="Відкрити зображення"]');
    if (!(thumb instanceof HTMLButtonElement)) throw new Error('image preview button not found');
    thumb.focus();
    expect(document.activeElement).toBe(thumb);

    await click(thumb);

    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain('1 / 1');
    expect(dialog?.querySelector('button[aria-label="Попереднє"]')).toBeNull();
    expect(dialog?.querySelector('button[aria-label="Наступне"]')).toBeNull();
    expect(document.activeElement).not.toBe(thumb);
  });

  it('keeps malformed hrefs from crashing preview download name derivation', async () => {
    const view = await renderCard({
      msg: {
        ...buildMessage(),
        images: ['https://example.test/files/%E0%A4%A.png'],
      },
    });
    rendered.push(view);

    await click(
      view.container.querySelector('button[aria-label="Відкрити зображення"]') as HTMLElement,
    );

    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.querySelector('img[data-image-preview-image]')?.getAttribute('src')).toBe(
      'https://example.test/files/%E0%A4%A.png',
    );
    expect(dialog?.querySelector('a[download]')?.getAttribute('download')).toBe('%E0%A4%A.png');
  });

  it('navigates preview images from window arrow keys', async () => {
    const view = await renderCard({
      msg: {
        ...buildMessage(),
        images: [
          'https://example.test/files/preview-1.png',
          'https://example.test/files/preview-2.png',
        ],
      },
    });
    rendered.push(view);

    await click(
      view.container.querySelector('button[aria-label="Відкрити зображення"]') as HTMLElement,
    );

    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.querySelector('img[data-image-preview-image]')?.getAttribute('src')).toBe(
      'https://example.test/files/preview-1.png',
    );

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });

    expect(dialog?.querySelector('img[data-image-preview-image]')?.getAttribute('src')).toBe(
      'https://example.test/files/preview-2.png',
    );

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    });

    expect(dialog?.querySelector('img[data-image-preview-image]')?.getAttribute('src')).toBe(
      'https://example.test/files/preview-1.png',
    );
  });

  it('shows image metadata and updates zoom in the preview dialog', async () => {
    const view = await renderCard({
      msg: {
        ...buildMessage(),
        media: [
          {
            id: 'image-1',
            href: 'https://example.test/files/scan-1.png',
            contentType: 'image/png',
            fileName: 'scan-1.png',
            sizeBytes: 1536,
          },
        ] as InboxMessage['media'],
      },
    });
    rendered.push(view);

    await click(
      view.container.querySelector('button[aria-label="Відкрити зображення"]') as HTMLElement,
    );

    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();

    const image = dialog?.querySelector('img[data-image-preview-image]') as HTMLImageElement | null;
    if (image == null) throw new Error('preview image not found');

    Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 1920 });
    Object.defineProperty(image, 'naturalHeight', { configurable: true, value: 1080 });

    await act(async () => {
      image.dispatchEvent(new Event('load', { bubbles: true }));
    });

    const infoButton = dialog?.querySelector('button[aria-label="Інформація"]');
    expect(infoButton).not.toBeNull();
    await click(infoButton as HTMLElement);

    expect(dialog?.querySelector('[data-attachment-preview-counter]')?.textContent).toBe('1 / 1');
    expect(dialog?.textContent).toContain('URL');
    expect(dialog?.textContent).toContain('scan-1.png');
    expect(dialog?.textContent).toContain('Розмір файлу');
    expect(dialog?.textContent).toContain('1920 × 1080');
    expect(dialog?.textContent).toContain('1.5 KB');
    expect(dialog?.textContent).toContain('Тип');
    expect(dialog?.querySelector('button[aria-label="Повноекранний режим"]')).toBeNull();
    expect(dialog?.querySelector('button[aria-label="Закрити"]')).not.toBeNull();

    expect(dialog?.querySelector('input[type="range"]')).toBeNull();
    expect(dialog?.querySelector('button[aria-label="Зменшити"]')).toBeNull();
    expect(dialog?.querySelector('button[aria-label="Збільшити"]')).toBeNull();
    expect(dialog?.querySelector('button[aria-label="Скинути масштаб"]')).toBeNull();

    const stage = dialog?.querySelector('[data-image-preview-stage]') as HTMLElement | null;
    if (stage == null) throw new Error('preview stage not found');

    await act(async () => {
      stage.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });

    expect(image.getAttribute('data-image-preview-zoom')).toBe('200');
    expect(dialog?.textContent).toContain('200%');
    expect(dialog?.querySelector('[data-attachment-preview-nav="prev"]')).toBeNull();
    expect(dialog?.querySelector('[data-attachment-preview-nav="next"]')).toBeNull();

    Object.defineProperty(stage, 'clientWidth', { configurable: true, value: 400 });
    Object.defineProperty(stage, 'clientHeight', { configurable: true, value: 300 });

    await act(async () => {
      stage.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          pointerId: 1,
          clientX: 40,
          clientY: 40,
        }),
      );
      window.dispatchEvent(
        new PointerEvent('pointermove', {
          bubbles: true,
          pointerId: 1,
          clientX: 140,
          clientY: 120,
        }),
      );
      window.dispatchEvent(
        new PointerEvent('pointerup', { bubbles: true, pointerId: 1, clientX: 140, clientY: 120 }),
      );
    });

    expect(Number(image.getAttribute('data-image-preview-pan-x') ?? '0')).not.toBe(0);
    expect(Number(image.getAttribute('data-image-preview-pan-y') ?? '0')).not.toBe(0);

    expect(Number(image.getAttribute('data-image-preview-pan-x') ?? '0')).not.toBe(0);
    expect(Number(image.getAttribute('data-image-preview-pan-y') ?? '0')).not.toBe(0);

    const closeButton = dialog?.querySelector('button[aria-label="Закрити"]');
    if (!(closeButton instanceof HTMLButtonElement)) throw new Error('close button not found');
    await click(closeButton);

    expect(document.body.querySelector('[role="dialog"]')).toBeNull();

    await click(
      view.container.querySelector('button[aria-label="Відкрити зображення"]') as HTMLElement,
    );

    const reopenedDialog = document.body.querySelector('[role="dialog"]');
    expect(reopenedDialog).not.toBeNull();
    expect(
      reopenedDialog
        ?.querySelector('img[data-image-preview-image]')
        ?.getAttribute('data-image-preview-zoom'),
    ).toBe('100');
    expect(
      reopenedDialog
        ?.querySelector('img[data-image-preview-image]')
        ?.getAttribute('data-image-preview-pan-x'),
    ).toBe('0');
    expect(
      reopenedDialog
        ?.querySelector('img[data-image-preview-image]')
        ?.getAttribute('data-image-preview-pan-y'),
    ).toBe('0');

    const reopenedCloseButton = reopenedDialog?.querySelector('button[aria-label="Закрити"]');
    if (!(reopenedCloseButton instanceof HTMLButtonElement)) {
      throw new Error('reopened close button not found');
    }
    await click(reopenedCloseButton);
  });

  it('keeps preview active when navigating to the next image', async () => {
    const view = await renderCard({
      msg: {
        ...buildMessage(),
        images: [
          'https://example.test/files/preview-1.png',
          'https://example.test/files/preview-2.png',
        ],
      },
    });
    rendered.push(view);

    await click(
      view.container.querySelector('button[aria-label="Відкрити зображення"]') as HTMLElement,
    );

    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();

    const image = dialog?.querySelector('img[data-image-preview-image]') as HTMLImageElement | null;
    if (image == null) throw new Error('preview image not found');

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });

    expect(dialog?.querySelector('img[data-image-preview-image]')?.getAttribute('src')).toBe(
      'https://example.test/files/preview-2.png',
    );
    expect(image.getAttribute('data-image-preview-zoom')).toBe('100');
    expect(image.getAttribute('data-image-preview-pan-x')).toBe('0');
    expect(image.getAttribute('data-image-preview-pan-y')).toBe('0');
  });

  it('does not start panning when pointerdown lands on interactive header elements', async () => {
    const view = await renderCard({
      msg: {
        ...buildMessage(),
        images: ['https://example.test/files/preview-1.png'],
      },
    });
    rendered.push(view);

    await click(
      view.container.querySelector('button[aria-label="Відкрити зображення"]') as HTMLElement,
    );

    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();

    const image = dialog?.querySelector('img[data-image-preview-image]') as HTMLImageElement | null;
    if (image == null) throw new Error('preview image not found');

    Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 1200 });
    Object.defineProperty(image, 'naturalHeight', { configurable: true, value: 800 });

    await act(async () => {
      image.dispatchEvent(new Event('load', { bubbles: true }));
    });

    const stage = dialog?.querySelector('[data-image-preview-stage]') as HTMLElement | null;
    if (stage == null) throw new Error('preview stage not found');

    Object.defineProperty(stage, 'clientWidth', { configurable: true, value: 400 });
    Object.defineProperty(stage, 'clientHeight', { configurable: true, value: 300 });

    await act(async () => {
      stage.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });

    expect(image.getAttribute('data-image-preview-zoom')).toBe('200');

    const closeButton = dialog?.querySelector('button[aria-label="Закрити"]');
    if (!(closeButton instanceof HTMLButtonElement)) throw new Error('close button not found');

    const closeIcon = closeButton.querySelector('svg');
    if (!(closeIcon instanceof SVGElement)) throw new Error('close icon not found');

    await act(async () => {
      closeButton.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          pointerId: 2,
          clientX: 16,
          clientY: 16,
        }),
      );
      closeIcon.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          pointerId: 2,
          clientX: 16,
          clientY: 16,
        }),
      );
      window.dispatchEvent(
        new PointerEvent('pointermove', {
          bubbles: true,
          pointerId: 2,
          clientX: 56,
          clientY: 40,
        }),
      );
      window.dispatchEvent(
        new PointerEvent('pointerup', { bubbles: true, pointerId: 2, clientX: 56, clientY: 40 }),
      );
    });
  });

  it('keeps legacy image order while merging media metadata by href', async () => {
    const imageA = 'https://example.test/files/image-a.png';
    const sharedHref = 'https://example.test/files/shared-image.png';
    const imageB = 'https://example.test/files/image-b.png';
    const view = await renderCard({
      msg: {
        ...buildMessage(),
        images: [imageA, sharedHref],
        media: [
          {
            id: 'media-image-1',
            href: sharedHref,
            contentType: 'image/png',
            fileName: 'merged-from-media.png',
            sizeBytes: 4096,
          },
          {
            id: 'media-image-2',
            href: imageB,
            contentType: 'image/jpeg',
            fileName: 'image-b-from-media.jpg',
            sizeBytes: 8192,
          },
        ] as InboxMessage['media'],
      },
    });
    rendered.push(view);

    const thumbnails = Array.from(
      view.container.querySelectorAll('button[aria-label="Відкрити зображення"]'),
    );
    expect(thumbnails).toHaveLength(3);
    expect(thumbnails[0]?.querySelector('img')?.getAttribute('src')).toBe(imageA);
    expect(thumbnails[1]?.querySelector('img')?.getAttribute('src')).toBe(sharedHref);
    expect(thumbnails[2]?.querySelector('img')?.getAttribute('src')).toBe(imageB);

    await click(
      view.container.querySelector('button[aria-label="Відкрити зображення"]') as HTMLElement,
    );

    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();

    const downloadLink = dialog?.querySelector('a[download]');
    expect(downloadLink?.getAttribute('download')).toBe('image-a.png');

    await click(thumbnails[1] as HTMLElement);

    expect(dialog?.querySelector('img[data-image-preview-image]')?.getAttribute('src')).toBe(
      sharedHref,
    );
    expect(dialog?.querySelector('a[download]')?.getAttribute('download')).toBe(
      'merged-from-media.png',
    );

    const infoButton = dialog?.querySelector('button[aria-label="Інформація"]');
    expect(infoButton).not.toBeNull();
    await click(infoButton as HTMLElement);

    expect(dialog?.textContent).toContain('merged-from-media.png');
    expect(dialog?.textContent).toContain(sharedHref);
    expect(dialog?.textContent).toContain('image/png');
    expect(dialog?.textContent).toContain('4.0 KB');
    expect(dialog?.textContent).toContain('media-image-1');
    expect(dialog?.querySelector('img[data-image-preview-image]')?.getAttribute('src')).toBe(
      sharedHref,
    );
    expect(dialog?.querySelector('a[download]')?.getAttribute('download')).toBe(
      'merged-from-media.png',
    );
  });
});
