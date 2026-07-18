/**
 * @vitest-environment happy-dom
 */
import { act, useState } from 'react';
import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InboxMessage } from '../../../../Bindings';

const fetchMessagesByIds = vi.hoisted(() => vi.fn());
const submitDirect = vi.hoisted(() => vi.fn());
const getUserSigintGroups = vi.hoisted(() => vi.fn());
const getGroupInfosBatch = vi.hoisted(() => vi.fn());
const getTagsForDisplay = vi.hoisted(() => vi.fn());
const createDeviceName = vi.hoisted(() => vi.fn());
const searchDeviceNames = vi.hoisted(() => vi.fn());
const searchPostNames = vi.hoisted(() => vi.fn());
const searchUnitNames = vi.hoisted(() => vi.fn());
const searchNetworkNames = vi.hoisted(() => vi.fn());
const searchSignalNames = vi.hoisted(() => vi.fn());
const searchCallsignNames = vi.hoisted(() => vi.fn());
const searchFreqs = vi.hoisted(() => vi.fn());

vi.mock('../../services/api/inbox-messages', () => ({
  fetchMessagesByIds,
}));
vi.mock('../../services/api/direct-submit', () => ({
  createDeviceName,
  submitDirect,
  editDirectSubmit: vi.fn(),
  formatDirectSubmitError: (error: unknown) =>
    error instanceof Error ? error.message : 'save failed',
  searchDeviceNames,
  searchPostNames,
  searchUnitNames,
  searchNetworkNames,
  searchSignalNames,
  searchCallsignNames,
  searchFreqs,
}));
vi.mock('../../services/api/inbox-reference-data', () => ({
  getUserSigintGroups,
  getGroupInfosBatch,
  getTagsForDisplay,
}));
vi.mock('../../services/api/units', () => ({
  getUnitsByIds: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../../maps/coordinate-search', () => ({
  parseCoordinateInput: vi.fn().mockReturnValue(null),
}));
vi.mock('@uppy/core', () => {
  class FakeUppy {
    use() {
      return this;
    }
    on() {}
    off() {}
    getFiles() {
      return [];
    }
    cancelAll() {}
    upload() {
      return Promise.resolve({ successful: [], failed: [] });
    }
  }
  return { default: FakeUppy };
});
vi.mock('@uppy/tus', () => ({ default: class {} }));

vi.mock('@mui/material', () => ({
  Autocomplete: ({
    renderInput,
    onChange,
    value,
  }: {
    renderInput?: (params: unknown) => ReactNode;
    onChange?: (event: unknown, value: unknown) => void;
    value?: unknown;
  }) => (
    <div data-testid="autocomplete" data-value={JSON.stringify(value)}>
      {(() => {
        const input = renderInput?.({ InputProps: {} } as never);
        const label = (input as { props?: { label?: unknown } } | undefined)?.props?.label;
        if (typeof label === 'string' && onChange) {
          autocompleteOnChangeByLabel.set(label, onChange);
        }
        return input;
      })()}
      <button type="button" data-testid="autocomplete-set" onClick={() => onChange?.(null, null)}>
        set
      </button>
    </div>
  ),
  Box: ({
    children,
    component = 'div',
    ...props
  }: {
    children?: ReactNode;
    component?: string;
  } & Record<string, unknown>) => {
    const Component = component as keyof HTMLElementTagNameMap;
    const { sx: _sx, onSubmit, onKeyDown, ...rest } = props as Record<string, unknown>;
    return (
      <Component
        {...(rest as Record<string, unknown>)}
        onSubmit={onSubmit as never}
        onKeyDown={onKeyDown as never}
      >
        {children}
      </Component>
    );
  },
  Button: ({
    children,
    type = 'button',
    onClick,
    disabled,
  }: {
    children?: ReactNode;
    type?: 'button' | 'submit' | 'reset';
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button type={type} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
  Chip: ({ label }: { label?: ReactNode }) => <span>{label}</span>,
  CircularProgress: () => <span data-testid="spinner" />,
  Drawer: ({ children, open }: { children?: ReactNode; open?: boolean }) =>
    open ? <div role="dialog">{children}</div> : null,
  FormControlLabel: ({ control, label }: { control: ReactNode; label: ReactNode }) => (
    <div>
      {control}
      {label}
    </div>
  ),
  IconButton: ({
    children,
    onClick,
    'aria-label': ariaLabel,
  }: {
    children?: ReactNode;
    onClick?: () => void;
    'aria-label'?: string;
  }) => (
    <button type="button" aria-label={ariaLabel} onClick={onClick}>
      {children}
    </button>
  ),
  Paper: ({ children }: { children?: ReactNode }) => <section>{children}</section>,
  Skeleton: ({ children }: { children?: ReactNode }) => <div>{children ?? 'skeleton'}</div>,
  Stack: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Switch: ({
    checked,
    onChange,
  }: {
    checked?: boolean;
    onChange?: (_event: Event, value: boolean) => void;
  }) => (
    <button type="button" onClick={() => onChange?.(new Event('change'), !checked)}>
      {checked ? 'on' : 'off'}
    </button>
  ),
  TextField: ({
    label,
    multiline,
    onChange,
    value,
    disabled,
  }: {
    label?: ReactNode;
    multiline?: boolean;
    onChange?: (event: { target: { value: string } }) => void;
    value?: string;
    disabled?: boolean;
  }) => {
    const labelKey = typeof label === 'string' ? label : undefined;
    textFieldPropsByLabel.set(labelKey, { onChange });
    return multiline ? (
      <textarea
        aria-label={labelKey}
        value={value ?? ''}
        disabled={disabled}
        onChange={(event) => onChange?.(event as never)}
      />
    ) : (
      <input
        aria-label={labelKey}
        value={value ?? ''}
        disabled={disabled}
        onChange={(event) => onChange?.(event as never)}
      />
    );
  },
  Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Typography: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  useMediaQuery: () => false,
}));

vi.mock('@mui/material/styles', () => ({
  useTheme: () => ({ breakpoints: { down: () => '(max-width: 600px)' } }),
}));
vi.mock('../../../components/PowerAlert', () => ({
  PowerAlert: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock('../../../components/PowerDateTimePicker', () => ({
  PowerDatePicker: ({ label }: { label?: string }) => <div>{label}</div>,
}));
vi.mock('@mui/x-date-pickers/TimePicker', () => ({
  TimePicker: ({ label }: { label?: string }) => <div>{label}</div>,
}));
vi.mock('@mui/x-date-pickers/AdapterDayjs', () => ({ AdapterDayjs: class {} }));
vi.mock('@mui/x-date-pickers/LocalizationProvider', () => ({
  LocalizationProvider: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock('../../../components/loadingOverlayStyles', () => ({
  pageDrawerBackdropSx: () => ({}),
}));
vi.mock('@mui/icons-material/DeleteOutline', () => ({ default: () => <span /> }));
vi.mock('../shared/message-card/MessageCard', () => ({
  DutyMessageCard: (props: { id: number; msg: InboxMessage }) => (
    <div data-testid="message-card">
      <span data-testid="message-text">{props.msg.text}</span>
      <span data-testid="message-id">{String(props.id)}</span>
    </div>
  ),
}));

import { ManageMessageDrawer } from '../shared/manage-message/ManageMessageDrawer';
import { CreatedMessagePreviewDrawer } from './CreatedMessagePreviewDrawer';
import { useCreatedMessageResult } from './useCreatedMessageResult';

const textFieldPropsByLabel = new Map<string | undefined, { onChange?: (event: any) => void }>();
const autocompleteOnChangeByLabel = new Map<string, (event: unknown, value: unknown) => void>();

vi.mock('../shared/manage-message/drawer-sections/LocationsSection', () => ({
  LocationsSection: ({ busy, recentValues }: { busy: boolean; recentValues: unknown }) => (
    <div
      data-testid="locations-section"
      data-busy={String(busy)}
      data-recent={String(!!recentValues)}
    />
  ),
}));

vi.mock('../shared/manage-message/drawer-sections/DmrSection', () => ({
  DmrSection: ({ showAdvanced }: { showAdvanced: boolean }) => (
    <div data-testid="dmr-section" data-open={String(showAdvanced)} />
  ),
}));

vi.mock('../shared/manage-message/drawer-sections/MetadataSection', () => ({
  MetadataSection: () => <div data-testid="metadata-section" />,
}));

function buildMessage(overrides: Partial<InboxMessage> = {}): InboxMessage {
  return {
    messageUid: 'm-1',
    text: 'created preview body',
    freq: '149.500',
    bookmarked: false,
    important: false,
    extendedForm: 'note',
    sender: 'sender-a',
    groupMasterKey: 'g-1',
    networkIds: [7],
    tags: [3],
    inboxTags: null,
    metadata: [],
    textMarked: null,
    pointTokens: null,
    media: [],
    images: [],
    imageRecognized: [],
    date: '2026-07-17',
    time: '12:00',
    timestamp: null,
    post: 'post-a',
    unit: 'unit-a',
    callsigns: [],
    callsignsAlg2: [],
    checked: false,
    comment: null,
    location: null,
    coords: null,
    noHeadersBody: null,
    messageComments: [],
    ...overrides,
  } as InboxMessage;
}

function Harness() {
  const [open, setOpen] = useState(true);
  const { createdMessageResult, closeCreatedMessageResult, handleCreatedMessage } =
    useCreatedMessageResult();

  return (
    <>
      <ManageMessageDrawer
        open={open}
        cyberEchoEnabled
        currentUser={null}
        onClose={() => setOpen(false)}
        onCreated={handleCreatedMessage}
      />
      <CreatedMessagePreviewDrawer
        authUserName="tester"
        open={createdMessageResult.kind !== 'closed'}
        result={createdMessageResult}
        onClose={closeCreatedMessageResult}
        groupInfos={{ 'g-1': { name: 'Group Alpha' } as never }}
        profiles={{ 'sender-a': { givenName: 'Sender', familyName: 'Alpha' } as never }}
        networkDisplayMap={{ 7: 'Network 7' }}
        networkMap={{ 7: { id: 7, name: 'Network 7' } as never }}
        unitsMap={{ 1: { id: 1, name: 'Unit 1' } as never }}
        callsignInfoMap={{}}
        tagsMap={{ 3: { id: 3, label: 'tag-3', isPalitra: false } as never }}
        tagsOrder={[3]}
        featureStrictNetworks={false}
      />
    </>
  );
}

function renderHarness() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  return { container, root };
}

async function flushMicrotasks() {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

describe('duty create-message bridge', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    fetchMessagesByIds.mockReset();
    submitDirect.mockReset();
    getUserSigintGroups.mockReset();
    getGroupInfosBatch.mockReset();
    getTagsForDisplay.mockReset();
    createDeviceName.mockReset();
    searchDeviceNames.mockReset();
    searchPostNames.mockReset();
    searchUnitNames.mockReset();
    searchNetworkNames.mockReset();
    searchSignalNames.mockReset();
    searchCallsignNames.mockReset();
    searchFreqs.mockReset();
    getUserSigintGroups.mockResolvedValue(['g-1']);
    getGroupInfosBatch.mockResolvedValue([{ masterKey: 'g-1', name: 'Group Alpha' }]);
    getTagsForDisplay.mockResolvedValue({
      tagsMap: { 3: { id: 3, label: 'tag-3', isPalitra: false } },
      tagsOrder: [3],
    });
    createDeviceName.mockResolvedValue({ id: 1 });
    searchDeviceNames.mockResolvedValue([]);
    searchPostNames.mockResolvedValue([]);
    searchUnitNames.mockResolvedValue([]);
    searchNetworkNames.mockResolvedValue([]);
    searchSignalNames.mockResolvedValue([]);
    searchCallsignNames.mockResolvedValue([]);
    searchFreqs.mockResolvedValue([]);
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', undefined);
    textFieldPropsByLabel.clear();
    autocompleteOnChangeByLabel.clear();
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  async function mountHarness() {
    ({ container, root } = renderHarness());
    await act(async () => {
      root.render(<Harness />);
    });
    await act(async () => {
      await flushMicrotasks();
    });
  }

  async function submitComposer() {
    await act(async () => {
      textFieldPropsByLabel.get('Текст повідомлення')?.onChange?.({
        target: { value: 'new message body' },
      });
      autocompleteOnChangeByLabel.get('Група')?.(null, {
        masterKey: 'g-1',
        name: 'Group Alpha',
      });
      await flushMicrotasks();
    });
    const form = container.querySelector('form') as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await flushMicrotasks();
    });
  }

  it('uses the response message directly and does not fetch a fallback', async () => {
    submitDirect.mockResolvedValueOnce({
      signal_message_id: 101,
      message: buildMessage(),
    });
    await mountHarness();

    expect(container.textContent).toContain('Створити повідомлення');
    await submitComposer();

    expect(container.textContent).not.toContain('Створити повідомлення');
    expect(container.textContent).not.toContain('Додане повідомлення');
    expect(fetchMessagesByIds).not.toHaveBeenCalled();

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(container.textContent).toContain('Додане повідомлення');
    expect(container.querySelector('[data-testid="message-card"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="message-text"]')?.textContent).toBe(
      'created preview body',
    );
    expect(submitDirect).toHaveBeenCalledTimes(1);
  });

  it('fetches once when the response omits the message', async () => {
    submitDirect.mockResolvedValueOnce({ signal_message_id: 202 });
    fetchMessagesByIds.mockResolvedValueOnce([[202, buildMessage({ text: 'fetched body' })]]);
    await mountHarness();

    await submitComposer();
    expect(fetchMessagesByIds).toHaveBeenCalledTimes(1);
    expect(fetchMessagesByIds).toHaveBeenCalledWith([202]);

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(container.textContent).toContain('Додане повідомлення');
    expect(container.querySelector('[data-testid="message-text"]')?.textContent).toBe(
      'fetched body',
    );
  });

  it('shows the receipt when the fallback is empty', async () => {
    submitDirect.mockResolvedValueOnce({ signal_message_id: 303 });
    fetchMessagesByIds.mockResolvedValueOnce([]);
    await mountHarness();

    await submitComposer();

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(container.textContent).toContain('Повідомлення створено.');
    expect(container.textContent).toContain('ID повідомлення: 303');
    expect(container.querySelector('[data-testid="message-card"]')).toBeNull();
  });

  it('keeps the success receipt when the fallback rejects', async () => {
    submitDirect.mockResolvedValueOnce({ signal_message_id: 404 });
    fetchMessagesByIds.mockRejectedValueOnce(new Error('lookup failed'));
    await mountHarness();

    await submitComposer();

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(container.textContent).toContain('Повідомлення створено.');
    expect(container.textContent).toContain('ID повідомлення: 404');
    expect(container.querySelector('[data-testid="message-card"]')).toBeNull();
    expect(fetchMessagesByIds).toHaveBeenCalledTimes(1);
  });

  it('closes the rendered composer when host preview handling fails', async () => {
    const containerLocal = document.createElement('div');
    document.body.appendChild(containerLocal);
    const rootLocal = createRoot(containerLocal);
    const onCreated = vi.fn().mockRejectedValue(new Error('preview failed'));
    submitDirect.mockResolvedValueOnce({
      signal_message_id: 505,
      message: buildMessage(),
    });

    function ControlledHarness() {
      const [open, setOpen] = useState(true);

      return (
        <ManageMessageDrawer
          open={open}
          cyberEchoEnabled
          currentUser={null}
          onClose={() => setOpen(false)}
          onCreated={onCreated}
        />
      );
    }

    await act(async () => {
      rootLocal.render(<ControlledHarness />);
    });

    await act(async () => {
      textFieldPropsByLabel.get('Текст повідомлення')?.onChange?.({
        target: { value: 'new message body' },
      });
      autocompleteOnChangeByLabel.get('Група')?.(null, {
        masterKey: 'g-1',
        name: 'Group Alpha',
      });
      await flushMicrotasks();
    });

    const form = containerLocal.querySelector('form') as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await flushMicrotasks();
    });

    expect(submitDirect).toHaveBeenCalledTimes(1);
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(containerLocal.textContent).not.toContain('Створити повідомлення');
    expect(containerLocal.querySelector('form')).toBeNull();
    expect(containerLocal.textContent).not.toContain('preview failed');
    expect(containerLocal.textContent).not.toContain('Сталася помилка');
    expect(containerLocal.querySelector('[role="dialog"]')).toBeNull();

    await act(async () => {
      rootLocal.unmount();
    });
  });
});
