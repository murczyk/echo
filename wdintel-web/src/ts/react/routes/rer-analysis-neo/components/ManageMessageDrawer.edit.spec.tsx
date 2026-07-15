/**
 * @vitest-environment happy-dom
 */
import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InboxMessage } from '../../../../../Bindings';

const referenceDataMocks = vi.hoisted(() => ({
  getTagsForDisplay: vi.fn().mockResolvedValue({ tagsMap: {}, tagsOrder: [] }),
}));
const directSubmitMocks = vi.hoisted(() => ({
  editDirectSubmit: vi.fn(),
}));

vi.mock('../../../services/api/inbox-reference-data', () => ({
  getUserSigintGroups: vi.fn().mockResolvedValue([]),
  getGroupInfosBatch: vi.fn().mockResolvedValue([]),
  getTagsForDisplay: referenceDataMocks.getTagsForDisplay,
}));
vi.mock('../../../services/api/direct-submit', () => ({
  searchDeviceName: vi.fn().mockResolvedValue(null),
  searchDeviceNames: vi.fn().mockResolvedValue([]),
  searchPostNames: vi.fn().mockResolvedValue([]),
  searchUnitNames: vi.fn().mockResolvedValue([]),
  searchNetworkNames: vi.fn().mockResolvedValue([]),
  searchSignalNames: vi.fn().mockResolvedValue([]),
  searchCallsignNames: vi.fn().mockResolvedValue([]),
  searchFreqs: vi.fn().mockResolvedValue([]),
  createDeviceName: vi.fn().mockResolvedValue({ id: 1 }),
  parseDirectSubmit: vi.fn(),
  submitDirect: vi.fn().mockResolvedValue({ signal_message_id: 1 }),
  editDirectSubmit: directSubmitMocks.editDirectSubmit,
  formatDirectSubmitError: (error: unknown) =>
    error instanceof Error ? error.message : 'save failed',
}));
vi.mock('../../../services/api/networks', () => ({
  getNetworksByIds: vi.fn().mockResolvedValue([]),
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
    removeFile() {}
    addFile() {}
    upload() {
      return Promise.resolve({ successful: [], failed: [] });
    }
  }
  return { default: FakeUppy };
});
vi.mock('@uppy/tus', () => ({ default: class {} }));
vi.mock('@mui/icons-material/DeleteOutline', () => ({ default: () => <span /> }));

vi.mock('../../../components/PowerDateTimePicker', () => ({
  PowerDatePicker: ({ label }: { label?: string }) => <div>{label}</div>,
}));
vi.mock('../../../components/PowerAlert', () => ({
  PowerAlert: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock('../../../components/loadingOverlayStyles', () => ({
  pageDrawerBackdropSx: () => ({}),
}));
vi.mock('@mui/x-date-pickers/TimePicker', () => ({
  TimePicker: ({ label }: { label?: string }) => <div>{label}</div>,
}));
vi.mock('@mui/x-date-pickers/AdapterDayjs', () => ({ AdapterDayjs: class {} }));
vi.mock('@mui/x-date-pickers/LocalizationProvider', () => ({
  LocalizationProvider: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

type TextFieldMockProps = {
  label?: ReactNode;
  multiline?: boolean;
  onChange?: (event: { target: { value: string } }) => void;
  onKeyDown?: (event: KeyboardEvent) => void;
  placeholder?: string;
  value?: string;
  disabled?: boolean;
};

const textFieldPropsByLabel = new Map<string | undefined, TextFieldMockProps>();
const autocompleteOnChangeByLabel = new Map<string, (event: unknown, value: unknown) => void>();

vi.mock('@mui/material', () => ({
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
  Stack: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Typography: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Drawer: ({ children, open }: { children?: ReactNode; open?: boolean }) =>
    open ? <div role="dialog">{children}</div> : null,
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
  } & Record<string, unknown>) => (
    <button type={type} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
  IconButton: ({
    children,
    onClick,
    disabled,
    'aria-label': ariaLabel,
  }: {
    children?: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    'aria-label'?: string;
  }) => (
    <button type="button" onClick={onClick} disabled={disabled} aria-label={ariaLabel}>
      {children}
    </button>
  ),
  CircularProgress: () => <span data-testid="spinner" />,
  Chip: ({
    label,
    onDelete,
    onClick,
  }: {
    label?: ReactNode;
    onDelete?: () => void;
    onClick?: () => void;
  }) => (
    <span onClick={onClick}>
      {label}
      {onDelete && (
        <button type="button" aria-label={`remove-${label}`} onClick={onDelete}>
          x
        </button>
      )}
    </span>
  ),
  Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
  TextField: ({
    label,
    multiline,
    onChange,
    onKeyDown,
    placeholder,
    value,
    disabled,
  }: TextFieldMockProps) => {
    const labelKey = typeof label === 'string' ? label : undefined;
    textFieldPropsByLabel.set(labelKey, {
      label: labelKey,
      multiline,
      onChange,
      onKeyDown,
      placeholder,
      value,
      disabled,
    });

    return multiline ? (
      <textarea
        aria-label={labelKey}
        placeholder={placeholder}
        value={value ?? ''}
        disabled={disabled}
        onChange={(event) => onChange?.(event as never)}
        onKeyDown={onKeyDown as never}
      />
    ) : (
      <input
        aria-label={labelKey}
        placeholder={placeholder}
        value={value ?? ''}
        disabled={disabled}
        onChange={(event) => onChange?.(event as never)}
        onKeyDown={onKeyDown as never}
      />
    );
  },
  Autocomplete: ({
    renderInput,
    value,
    onChange,
    options,
    loading: _loading,
  }: {
    renderInput?: (params: unknown) => ReactNode;
    value?: unknown;
    onChange?: (event: unknown, value: unknown) => void;
    options?: unknown[];
    loading?: boolean;
  }) => {
    const input = renderInput?.({ InputProps: {} } as never);
    const label = (input as { props?: { label?: unknown } } | undefined)?.props?.label;
    if (typeof label === 'string' && onChange) {
      autocompleteOnChangeByLabel.set(label, onChange);
    }
    return (
      <div data-testid="autocomplete" data-value={JSON.stringify(value)}>
        {Array.isArray(value) ? value.map((v) => <span key={String(v)}>{String(v)}</span>) : null}
        {input ?? null}
      </div>
    );
  },
}));

import { ManageMessageDrawer } from './ManageMessageDrawer';

function buildMessage(overrides: Partial<InboxMessage> = {}): InboxMessage {
  return {
    messageUid: 'm-1',
    text: 'existing body',
    media: [],
    images: [],
    imageRecognized: [],
    date: '2026-07-01',
    time: '13:45',
    freq: '149.500',
    coords: '49.1, 37.2',
    callsigns: ['ALFA'],
    callsignsAlg2: ['BRAVO'],
    checked: false,
    important: false,
    bookmarked: false,
    timestamp: null,
    groupMasterKey: 'g-1',
    sender: null,
    extendedForm: 'note',
    post: 'p',
    postId: null,
    unit: 'u',
    callsignTokens: null,
    signalTokens: null,
    pointTokens: null,
    noHeadersBody: null,
    keywordTokens: null,
    textMarked: null,
    datasourceId: null,
    location: 'Київ',
    tags: null,
    networkIds: null,
    inboxTags: null,
    metadata: [],
    ...overrides,
  } as InboxMessage;
}

describe('ManageMessageDrawer edit mode', () => {
  afterEach(() => {
    textFieldPropsByLabel.clear();
    autocompleteOnChangeByLabel.clear();
    directSubmitMocks.editDirectSubmit.mockReset();
    document.body.innerHTML = '';
    referenceDataMocks.getTagsForDisplay.mockResolvedValue({ tagsMap: {}, tagsOrder: [] });
  });

  it('renders the edit title and calls onSubmitEdit with a merged message on save', async () => {
    const onSubmitEdit = vi.fn();
    directSubmitMocks.editDirectSubmit.mockResolvedValue({
      signal_message_id: 42,
      message: buildMessage({ callsigns: ['ALFA', 'CHARLIE'] }),
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <ManageMessageDrawer
          open
          cyberEchoEnabled={false}
          currentUser={null}
          onClose={vi.fn()}
          editTarget={{ id: 42, message: buildMessage({ networkName: 'Network Alpha' }) }}
          editSaveInFlight={false}
          onSubmitEdit={onSubmitEdit}
        />,
      );
    });

    expect(container.textContent).toContain('Редагувати повідомлення');

    const bodyField = container.querySelector(
      'textarea[aria-label="Текст повідомлення"]',
    ) as HTMLTextAreaElement;
    expect(bodyField?.value).toBe('existing body');

    // Suggested callsign from callsignsAlg2 should be offered.
    expect(container.textContent).toContain('Запропоновані позивні');
    expect(container.textContent).toContain('BRAVO');

    // Add a callsign via Enter in the ported callsign editor.
    act(() => {
      autocompleteOnChangeByLabel.get('Позивні')?.(null, ['ALFA', 'charlie']);
    });
    expect(container.textContent).toContain('CHARLIE');

    const form = container.querySelector('form') as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(onSubmitEdit).toHaveBeenCalledTimes(1);
    expect(onSubmitEdit.mock.calls[0][0]).toBe(42);
    expect(onSubmitEdit.mock.calls[0][1]).toMatchObject({
      text: 'existing body',
      callsigns: ['ALFA', 'CHARLIE'],
    });
    expect(directSubmitMocks.editDirectSubmit).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        network: {
          signal_name: 'DMR',
          cc: undefined,
          name: 'Network Alpha',
        },
      }),
    );

    root.unmount();
  });

  it('backfills tags after the async load without clobbering an in-window edit', async () => {
    // Defer the tagsMap resolution so we can interleave a user edit between the initial
    // seed (empty tagsMap) and the tags load — the exact narrow-window the fix guards.
    let resolveTags: (value: {
      tagsMap: Record<number, unknown>;
      tagsOrder: number[];
    }) => void = () => {};
    referenceDataMocks.getTagsForDisplay.mockReturnValue(
      new Promise((resolve) => {
        resolveTags = resolve as never;
      }),
    );

    const onSubmitEdit = vi.fn();
    directSubmitMocks.editDirectSubmit.mockResolvedValue({
      signal_message_id: 55,
      message: buildMessage({ extendedForm: 'edited comment', tags: [7] }),
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <ManageMessageDrawer
          open
          cyberEchoEnabled={false}
          currentUser={null}
          onClose={vi.fn()}
          editTarget={{ id: 55, message: buildMessage({ tags: [7] }) }}
          editSaveInFlight={false}
          onSubmitEdit={onSubmitEdit}
        />,
      );
    });

    // Tags not yet seeded (async load still pending).
    expect(container.textContent).not.toContain('арта');

    // User edits a non-tag field WHILE tags are still loading.
    const commentField = container.querySelector(
      'textarea[aria-label="Коментар"]',
    ) as HTMLTextAreaElement;
    expect(commentField).toBeTruthy();
    act(() => {
      textFieldPropsByLabel.get('Коментар')?.onChange?.({ target: { value: 'edited comment' } });
    });

    // Now the tags fetch resolves.
    await act(async () => {
      resolveTags({ tagsMap: { 7: { label: 'арта' } }, tagsOrder: [7] });
    });

    // Tags backfilled after the async load...
    expect(container.textContent).toContain('арта');

    const form = container.querySelector('form') as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(onSubmitEdit).toHaveBeenCalledTimes(1);
    // ...and the in-window comment edit was NOT clobbered by a second reset().
    expect(onSubmitEdit.mock.calls[0][1]).toMatchObject({
      extendedForm: 'edited comment',
      tags: [7],
    });

    root.unmount();
  });

  it('rejects an existing message with a missing group', async () => {
    const onSubmitEdit = vi.fn();
    directSubmitMocks.editDirectSubmit.mockResolvedValue({
      signal_message_id: 77,
      message: buildMessage({ coords: 'somewhere near the ridge', freq: 'unknown freq' }),
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <ManageMessageDrawer
          open
          cyberEchoEnabled={false}
          currentUser={null}
          onClose={vi.fn()}
          editTarget={{
            id: 77,
            message: buildMessage({
              groupMasterKey: null as unknown as string,
              coords: 'somewhere near the ridge',
              freq: 'unknown freq',
            }),
          }}
          editSaveInFlight={false}
          onSubmitEdit={onSubmitEdit}
        />,
      );
    });

    const form = container.querySelector('form') as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(directSubmitMocks.editDirectSubmit).not.toHaveBeenCalled();
    expect(onSubmitEdit).not.toHaveBeenCalled();

    root.unmount();
  });

  it('preserves original tags when the user saves before the tags fetch resolves', async () => {
    // Never resolve the tags fetch — simulate saving during the loading window.
    referenceDataMocks.getTagsForDisplay.mockReturnValue(new Promise(() => {}));

    const onSubmitEdit = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const originalTags = [7, 9];
    directSubmitMocks.editDirectSubmit.mockResolvedValue({
      signal_message_id: 88,
      message: buildMessage({ tags: originalTags }),
    });
    await act(async () => {
      root.render(
        <ManageMessageDrawer
          open
          cyberEchoEnabled={false}
          currentUser={null}
          onClose={vi.fn()}
          editTarget={{ id: 88, message: buildMessage({ tags: originalTags }) }}
          editSaveInFlight={false}
          onSubmitEdit={onSubmitEdit}
        />,
      );
    });

    const form = container.querySelector('form') as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(onSubmitEdit).toHaveBeenCalledTimes(1);
    expect(onSubmitEdit.mock.calls[0][1]).toMatchObject({ tags: originalTags });
    expect(directSubmitMocks.editDirectSubmit.mock.calls[0][1].tags).toBeUndefined();

    root.unmount();
  });

  it('submits the parsed body separately from the full source', async () => {
    directSubmitMocks.editDirectSubmit.mockResolvedValue({
      signal_message_id: 90,
      message: buildMessage(),
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <ManageMessageDrawer
          open
          cyberEchoEnabled={false}
          currentUser={null}
          onClose={vi.fn()}
          editTarget={{
            id: 90,
            message: buildMessage({
              text: 'header\nbody only',
              noHeadersBody: { start: 7, end: 16, body: 'body only' },
            }),
          }}
        />,
      );
    });

    const form = container.querySelector('form') as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(directSubmitMocks.editDirectSubmit.mock.calls[0][1]).toMatchObject({
      full_body: 'header\nbody only',
      text: 'body only',
    });
    root.unmount();
  });

  it('omits the stale parsed body when the full source changes', async () => {
    directSubmitMocks.editDirectSubmit.mockResolvedValue({
      signal_message_id: 90,
      message: buildMessage(),
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <ManageMessageDrawer
          open
          cyberEchoEnabled={false}
          currentUser={null}
          onClose={vi.fn()}
          editTarget={{
            id: 90,
            message: buildMessage({
              text: 'header\nold body',
              noHeadersBody: { start: 7, end: 15, body: 'old body' },
            }),
          }}
        />,
      );
    });

    await act(async () => {
      textFieldPropsByLabel
        .get('Текст повідомлення')
        ?.onChange?.({ target: { value: 'header\nnew body' } });
    });
    const form = container.querySelector('form') as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(directSubmitMocks.editDirectSubmit.mock.calls[0][1]).toMatchObject({
      full_body: 'header\nnew body',
      text: undefined,
    });
    root.unmount();
  });

  it('preserves every DMR metadata row in the edit payload', async () => {
    directSubmitMocks.editDirectSubmit.mockResolvedValue({
      signal_message_id: 91,
      message: buildMessage(),
    });
    const metadataBase = {
      colorCodeStartIndex: null,
      colorCodeEndIndex: null,
      callGroupId: null,
      callGroupIdStartIndex: null,
      callGroupIdEndIndex: null,
      callGroupName: null,
      callGroupNameStartIndex: null,
      callGroupNameEndIndex: null,
      senderIdStartIndex: null,
      senderIdEndIndex: null,
      senderName: null,
      senderNameStartIndex: null,
      senderNameEndIndex: null,
      hashId: null,
      hashIdStartIndex: null,
      hashIdEndIndex: null,
    };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <ManageMessageDrawer
          open
          cyberEchoEnabled={false}
          currentUser={null}
          onClose={vi.fn()}
          editTarget={{
            id: 91,
            message: buildMessage({
              metadata: [
                { ...metadataBase, colorCode: '3', senderId: '101' },
                { ...metadataBase, colorCode: '3', senderId: '202' },
              ],
            }),
          }}
        />,
      );
    });

    const form = container.querySelector('form') as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(directSubmitMocks.editDirectSubmit.mock.calls[0][1].dmr).toMatchObject([
      { cc: 3, sender_id: 101, signal_name: 'DMR' },
      { cc: 3, sender_id: 202, signal_name: 'DMR' },
    ]);
    root.unmount();
  });

  it('clears the form when reopening in create mode after an edit (regression: no state leak)', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    // 1. Open in edit mode — the form is seeded from the existing message.
    await act(async () => {
      root.render(
        <ManageMessageDrawer
          open
          cyberEchoEnabled={false}
          currentUser={null}
          onClose={vi.fn()}
          editTarget={{ id: 42, message: buildMessage() }}
          editSaveInFlight={false}
          onSubmitEdit={vi.fn()}
        />,
      );
    });
    const editBody = container.querySelector(
      'textarea[aria-label="Текст повідомлення"]',
    ) as HTMLTextAreaElement;
    expect(editBody?.value).toBe('existing body');

    // 2. Close the drawer (edit-save / closeEditor flips `open`, bypassing handleDrawerClose).
    await act(async () => {
      root.render(
        <ManageMessageDrawer
          open={false}
          cyberEchoEnabled={false}
          currentUser={null}
          onClose={vi.fn()}
          editTarget={null}
          onSuccess={vi.fn()}
        />,
      );
    });

    // 3. Reopen in create mode (no editTarget). Fields must be empty, not the edited message.
    await act(async () => {
      root.render(
        <ManageMessageDrawer
          open
          cyberEchoEnabled={false}
          currentUser={null}
          onClose={vi.fn()}
          editTarget={null}
          onSuccess={vi.fn()}
        />,
      );
    });

    expect(container.textContent).toContain('Створити повідомлення');
    const createBody = container.querySelector(
      'textarea[aria-label="Текст повідомлення"]',
    ) as HTMLTextAreaElement;
    expect(createBody?.value).toBe('');
    // The edit-only pieces must be gone too.
    expect(container.textContent).not.toContain('existing body');
    expect(container.textContent).not.toContain('ALFA');

    root.unmount();
  });
});
