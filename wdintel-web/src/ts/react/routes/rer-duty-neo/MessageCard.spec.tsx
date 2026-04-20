/**
 * @vitest-environment happy-dom
 */
import type { ComponentProps, ElementType, ReactNode } from 'react';
import React, { act, forwardRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { InboxMessage, Network, Tag } from '../../../../Bindings';
import { inboxMessageWithMockImages } from './inbox-message-mocks';
import { MessageCard } from './MessageCard';

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
  return clone;
}

vi.mock('@mui/icons-material/ExpandMore', () => ({
  default: () => <span>expand</span>,
}));

/** Narrow width for tag-row measurement in compact layout (MessageCardTagChips `useLayoutEffect`). */
const TAG_ROW_MEASURE_WIDTH_PX = 200;

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
    endIcon,
    ...props
  }: { children?: ReactNode; endIcon?: ReactNode } & Record<string, unknown>) => (
    <button {...omitMuiLayoutProps(props)}>
      <span>{children}</span>
      {endIcon}
    </button>
  ),
  ButtonGroup: ({ children, component, ...props }: PrimitiveProps) => {
    const Component = component ?? 'div';
    return <Component {...omitMuiLayoutProps(props)}>{children}</Component>;
  },
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

vi.mock('../../components/PowerChip', () => ({
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
};

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
    ...overrides,
  } as InboxMessage;
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
    onBookmark: vi.fn(),
    onImportant: vi.fn(),
    onCopyText: vi.fn(),
    onCopyFreq: vi.fn(),
    onComment: vi.fn(),
    onToggleTag: vi.fn(),
    ...overrides,
  };

  await act(async () => {
    root.render(<MessageCard {...props} />);
  });

  return { container, root };
}

function getButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.includes(label));
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Button not found: ${label}`);
  return button;
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

  afterEach(() => {
    for (const item of rendered.splice(0)) {
      act(() => {
        item.root.unmount();
      });
      item.container.remove();
    }
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
    expect(view.container.querySelector('button[aria-label="Відкрити аналіз"]')).not.toBeNull();
    expect(view.container.querySelector('button[aria-label="Відкрити мапу"]')).not.toBeNull();
  });

  it('renders duty actions with timer and new-tab links', async () => {
    const view = await renderCard();
    rendered.push(view);

    expect(view.container.textContent).toContain('1 хв');
    expect(view.container.textContent).not.toContain('Відкрити аналіз');
    expect(view.container.textContent).not.toContain('Відкрити мапу');
    expect(view.container.querySelector('button[aria-label="Відкрити аналіз"]')).not.toBeNull();
    expect(view.container.querySelector('button[aria-label="Відкрити мапу"]')).not.toBeNull();
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
    expect(view.container.querySelector('button[aria-label="Відкрити мапу тут"]')).not.toBeNull();
    expect(view.container.querySelector('button[aria-label="Відкрити мапу в новому вікні"]')).not.toBeNull();
    expect(view.container.textContent).toContain('Запропоновані позивні');
    expect(view.container.textContent).toContain('Позивні');
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

  it('does not render analysis-only callsign controls in duty mode', async () => {
    const view = await renderCard();
    rendered.push(view);

    expect(view.container.textContent).not.toContain('Позивні ще не додані');
    expect(view.container.textContent).not.toContain('Додати позивний');
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
    });
  });
});
