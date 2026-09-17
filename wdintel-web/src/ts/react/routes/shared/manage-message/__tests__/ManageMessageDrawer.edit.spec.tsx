/**
 * @vitest-environment happy-dom
 */
import type { ComponentProps, ReactNode, Ref } from 'react';
import { act, forwardRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InboxMessage } from '../../../../../../Bindings';

const referenceDataMocks = vi.hoisted(() => ({
  getUserSigintGroups: vi.fn().mockResolvedValue([]),
  getGroupInfosBatch: vi.fn().mockResolvedValue([]),
  getTagsForDisplay: vi.fn().mockResolvedValue({ tagsMap: {}, tagsOrder: [] }),
}));
const directSubmitMocks = vi.hoisted(() => ({
  submitDirect: vi.fn().mockResolvedValue({ signal_message_id: 1 }),
  editDirectSubmit: vi.fn(),
  copyDirectSubmit: vi.fn(),
  createDeviceName: vi.fn().mockResolvedValue({ id: 1 }),
  parseDirectSubmit: vi.fn(),
  searchNetworkNames: vi.fn().mockResolvedValue([]),
}));
const networkMocks = vi.hoisted(() => ({
  getNetworksByIds: vi.fn().mockResolvedValue([]),
}));
const unitMocks = vi.hoisted(() => ({
  getUnitsByIds: vi.fn().mockResolvedValue([]),
}));
const inboxMessageActionMocks = vi.hoisted(() => ({
  deleteMessage: vi.fn().mockResolvedValue(undefined),
}));
const aiIntelReportMocks = vi.hoisted(() => ({
  quickIntelReportSuggestion: vi.fn().mockResolvedValue(null),
}));
const uppyMocks = vi.hoisted(() => ({
  latest: null as {
    emitUploadProgress: (percentage: number) => void;
    emitUploadSuccess: () => void;
  } | null,
}));

vi.mock('../../../../services/api/inbox-reference-data', () => ({
  getUserSigintGroups: referenceDataMocks.getUserSigintGroups,
  getGroupInfosBatch: referenceDataMocks.getGroupInfosBatch,
  getTagsForDisplay: referenceDataMocks.getTagsForDisplay,
}));
vi.mock('../../../../services/api/direct-submit', () => ({
  searchDeviceName: vi.fn().mockResolvedValue(null),
  searchDeviceNames: vi.fn().mockResolvedValue([]),
  searchPostNames: vi.fn().mockResolvedValue([]),
  searchUnitNames: vi.fn().mockResolvedValue([]),
  searchNetworkNames: directSubmitMocks.searchNetworkNames,
  searchSignalNames: vi.fn().mockResolvedValue([]),
  searchCallsignNames: vi.fn().mockResolvedValue([]),
  searchFreqs: vi.fn().mockResolvedValue([]),
  createDeviceName: directSubmitMocks.createDeviceName,
  parseDirectSubmit: directSubmitMocks.parseDirectSubmit,
  submitDirect: directSubmitMocks.submitDirect,
  editDirectSubmit: directSubmitMocks.editDirectSubmit,
  copyDirectSubmit: directSubmitMocks.copyDirectSubmit,
  formatDirectSubmitError: (error: unknown) =>
    error instanceof Error ? error.message : 'save failed',
}));
vi.mock('../../../../services/api/networks', () => ({
  getNetworksByIds: networkMocks.getNetworksByIds,
}));
vi.mock('../../../../services/api/units', () => ({
  getUnitsByIds: unitMocks.getUnitsByIds,
}));
vi.mock('../../../../services/api/inbox-message-actions', () => ({
  deleteMessage: inboxMessageActionMocks.deleteMessage,
}));
vi.mock('../../../../services/api/ai-intel-report', () => ({
  quickIntelReportSuggestion: aiIntelReportMocks.quickIntelReportSuggestion,
}));
vi.mock('../../../../components/ConfirmDangerDialog', () => ({
  ConfirmDangerDialog: ({
    open,
    onClose,
    onConfirm,
    title,
    description,
    submitting,
  }: {
    open: boolean;
    onClose: () => void;
    onConfirm: () => void;
    title?: ReactNode;
    description?: ReactNode;
    submitting?: boolean;
  }) =>
    open ? (
      <div role="alertdialog">
        <div>{title}</div>
        <div>{description}</div>
        <button type="button" onClick={onClose} disabled={submitting}>
          Скасувати видалення
        </button>
        <button type="button" onClick={onConfirm} disabled={submitting}>
          Підтвердити видалення
        </button>
      </div>
    ) : null,
}));
vi.mock('@uppy/core', () => {
  class FakeUppy {
    files: Array<Record<string, unknown>> = [];
    listeners = new Map<string, Set<(...args: any[]) => void>>();

    constructor() {
      uppyMocks.latest = this;
    }

    use() {
      return this;
    }
    on(event: string, callback: (...args: any[]) => void) {
      const callbacks = this.listeners.get(event) ?? new Set();
      callbacks.add(callback);
      this.listeners.set(event, callbacks);
    }
    off(event: string, callback: (...args: any[]) => void) {
      this.listeners.get(event)?.delete(callback);
    }
    getFiles() {
      return this.files;
    }
    cancelAll() {}
    destroy() {
      this.cancelAll();
      this.listeners.clear();
    }
    removeFile(id: string) {
      const removedFile = this.files.find((file) => file.id === id);
      this.files = this.files.filter((file) => file.id !== id);
      if (removedFile) {
        this.listeners.get('file-removed')?.forEach((callback) => callback(removedFile));
      }
    }
    addFile(file: Record<string, unknown>) {
      if (this.files.length >= 20) {
        throw new Error('exceeds maximum number of files');
      }
      const addedFile = {
        id: `file-${this.files.length + 1}`,
        progress: {
          uploadStarted: null,
          uploadComplete: false,
          percentage: 0,
          bytesUploaded: false,
          bytesTotal: null,
        },
        ...file,
      };
      this.files = [...this.files, addedFile];
      this.listeners.get('file-added')?.forEach((callback) => callback(addedFile));
      return addedFile;
    }
    emitUploadProgress(percentage: number) {
      const file = this.files[0];
      if (!file) return;
      file.progress = {
        uploadStarted: Date.now(),
        uploadComplete: false,
        percentage,
        bytesUploaded: percentage,
        bytesTotal: 100,
      };
      this.listeners.get('upload-progress')?.forEach((callback) => callback(file, file.progress));
    }
    emitUploadSuccess() {
      const file = this.files[0];
      if (!file) return;
      file.progress = {
        uploadStarted: Date.now(),
        uploadComplete: true,
        percentage: 100,
        bytesUploaded: 100,
        bytesTotal: 100,
      };
      this.listeners
        .get('upload-success')
        ?.forEach((callback) => callback(file, { status: 200, uploadURL: '/upload/1' }));
    }
    upload() {
      return Promise.resolve({ successful: [], failed: [] });
    }
  }
  return { default: FakeUppy };
});
vi.mock('@uppy/tus', () => ({ default: class {} }));
vi.mock('@mui/icons-material/Add', () => ({ default: () => <span /> }));
vi.mock('@mui/icons-material/DeleteOutline', () => ({ default: () => <span /> }));
vi.mock('@mui/icons-material/SmartToyOutlined', () => ({
  default: ({
    'aria-label': ariaLabel,
    'aria-busy': ariaBusy,
    'data-testid': testId,
  }: {
    'aria-label'?: string;
    'aria-busy'?: boolean;
    'data-testid'?: string;
  }) => <span aria-label={ariaLabel} aria-busy={ariaBusy} data-testid={testId} />,
}));
vi.mock('../drawer-sections/CoordinateInputPreview', () => ({
  CoordinateInputPreview: () => null,
}));

vi.mock('../../../../components/PowerDateTimePicker', () => ({
  PowerDatePicker: ({ label, value }: { label?: string; value?: unknown }) => {
    if (label) pickerValuesByLabel.set(label, value);
    return <div>{label}</div>;
  },
}));
vi.mock('../../../../components/PowerAlert', () => ({
  PowerAlert: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock('../../../../components/loadingOverlayStyles', () => ({
  pageDrawerBackdropSx: () => ({}),
}));
vi.mock('@mui/x-date-pickers/TimePicker', () => ({
  TimePicker: ({ label, value }: { label?: string; value?: unknown }) => {
    if (label) pickerValuesByLabel.set(label, value);
    return <div>{label}</div>;
  },
}));
vi.mock('@mui/x-date-pickers/AdapterDayjs', () => ({ AdapterDayjs: class {} }));
vi.mock('@mui/x-date-pickers/LocalizationProvider', () => ({
  LocalizationProvider: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

type TextFieldMockProps = {
  label?: ReactNode;
  multiline?: boolean;
  rows?: number;
  onChange?: (event: { target: { value: string } }) => void;
  onBlur?: () => void;
  onKeyDown?: (event: KeyboardEvent) => void;
  placeholder?: string;
  value?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  inputRef?: Ref<HTMLInputElement | HTMLTextAreaElement>;
  error?: boolean;
  helperText?: ReactNode;
};

const textFieldPropsByLabel = new Map<string | undefined, TextFieldMockProps>();
const autocompleteOnChangeByLabel = new Map<string, (event: unknown, value: unknown) => void>();
const autocompleteOnInputChangeByLabel = new Map<
  string,
  (event: unknown, value: string, reason: string) => void
>();
const autocompleteValuesByLabel = new Map<string, unknown>();
const autocompleteInputValuesByLabel = new Map<string, string>();
const autocompleteOptionLabelsByLabel = new Map<string, string[]>();
const pickerValuesByLabel = new Map<string, unknown>();
let drawerModalProps: { closeAfterTransition?: boolean } | undefined;
let drawerSlotProps:
  { paper?: { sx?: { width?: string | Record<string, string | number> } } } | undefined;
type DrawerCloseReason = 'escapeKeyDown' | 'backdropClick';
let drawerOnClose: ((event: unknown, reason: DrawerCloseReason) => void) | undefined;

function setRecentValues(values: Record<string, unknown>) {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: vi.fn().mockReturnValue(JSON.stringify(values)),
      setItem: vi.fn(),
    },
  });
}

vi.mock('@mui/material', () => ({
  Box: forwardRef(
    (
      {
        children,
        component = 'div',
        ...props
      }: {
        children?: ReactNode;
        component?: string;
      } & Record<string, unknown>,
      ref,
    ) => {
      const Component = component as keyof HTMLElementTagNameMap;
      const { sx: _sx, onSubmit, onKeyDown, ...rest } = props as Record<string, unknown>;
      return (
        <Component
          {...(rest as Record<string, unknown>)}
          ref={ref as never}
          onSubmit={onSubmit as never}
          onKeyDown={onKeyDown as never}
        >
          {children}
        </Component>
      );
    },
  ),
  Stack: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Divider: () => <hr />,
  Menu: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  MenuItem: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  ListItemIcon: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  ListItemText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Typography: ({
    children,
    component = 'div',
    onClick,
    title,
    type,
  }: {
    children?: ReactNode;
    component?: string;
    onClick?: () => void;
    title?: string;
    type?: 'button';
  }) => {
    const Component = component as keyof HTMLElementTagNameMap;
    return (
      <Component onClick={onClick} title={title} type={type}>
        {children}
      </Component>
    );
  },
  Drawer: ({
    children,
    open,
    onClose,
    ModalProps,
    slotProps,
  }: {
    children?: ReactNode;
    open?: boolean;
    onClose?: (event: unknown, reason: DrawerCloseReason) => void;
    ModalProps?: { closeAfterTransition?: boolean };
    slotProps?: { paper?: { sx?: { width?: string | Record<string, string | number> } } };
  }) => {
    drawerOnClose = onClose;
    drawerModalProps = ModalProps;
    drawerSlotProps = slotProps;
    return open ? <div role="dialog">{children}</div> : null;
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
  CircularProgress: ({
    'data-testid': testId = 'spinner',
    'aria-label': ariaLabel,
  }: {
    'data-testid'?: string;
    'aria-label'?: string;
  }) => <span data-testid={testId} aria-label={ariaLabel} />,
  LinearProgress: ({
    value,
    'aria-label': ariaLabel,
  }: {
    value?: number;
    'aria-label'?: string;
  }) => <progress value={value} max={100} aria-label={ariaLabel} />,
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
  InputAdornment: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
  TextField: ({
    label,
    multiline,
    rows,
    onChange,
    onBlur,
    onKeyDown,
    placeholder,
    value,
    disabled,
    autoFocus,
    inputRef,
    error,
    helperText,
  }: TextFieldMockProps) => {
    const labelKey = typeof label === 'string' ? label : undefined;
    textFieldPropsByLabel.set(labelKey, {
      label: labelKey,
      multiline,
      rows,
      onChange,
      onBlur,
      onKeyDown,
      placeholder,
      value,
      disabled,
      autoFocus,
      error,
      helperText,
    });

    return (
      <>
        {multiline ? (
          <textarea
            aria-label={labelKey}
            placeholder={placeholder}
            value={value ?? ''}
            rows={rows}
            disabled={disabled}
            autoFocus={autoFocus}
            ref={inputRef as Ref<HTMLTextAreaElement>}
            onChange={(event) => onChange?.(event as never)}
            onBlur={onBlur}
            onKeyDown={onKeyDown as never}
          />
        ) : (
          <input
            aria-label={labelKey}
            placeholder={placeholder}
            value={value ?? ''}
            disabled={disabled}
            autoFocus={autoFocus}
            ref={inputRef as Ref<HTMLInputElement>}
            onChange={(event) => onChange?.(event as never)}
            onBlur={onBlur}
            onKeyDown={onKeyDown as never}
          />
        )}
        {helperText ? <span>{helperText}</span> : null}
      </>
    );
  },
  Autocomplete: ({
    renderInput,
    value,
    inputValue,
    onChange,
    onInputChange,
    options,
    getOptionLabel,
    loading: _loading,
  }: {
    renderInput?: (params: unknown) => ReactNode;
    value?: unknown;
    inputValue?: string;
    onChange?: (event: unknown, value: unknown) => void;
    onInputChange?: (event: unknown, value: string, reason: string) => void;
    options?: unknown[];
    getOptionLabel?: (option: unknown) => string;
    loading?: boolean;
  }) => {
    const input = renderInput?.({ InputProps: {} } as never);
    const label = (input as { props?: { label?: unknown } } | undefined)?.props?.label;
    if (typeof label === 'string' && onChange) {
      autocompleteOnChangeByLabel.set(label, onChange);
    }
    if (typeof label === 'string' && onInputChange) {
      autocompleteOnInputChangeByLabel.set(label, onInputChange);
    }
    if (typeof label === 'string') autocompleteValuesByLabel.set(label, value);
    if (typeof label === 'string' && inputValue != null) {
      autocompleteInputValuesByLabel.set(label, inputValue);
    }
    if (typeof label === 'string' && getOptionLabel) {
      autocompleteOptionLabelsByLabel.set(label, (options ?? []).map(getOptionLabel));
    }
    return (
      <div data-testid="autocomplete" data-value={JSON.stringify(value)}>
        {Array.isArray(value) ? value.map((v) => <span key={String(v)}>{String(v)}</span>) : null}
        {input ?? null}
      </div>
    );
  },
}));

import { ManageMessageDrawer } from '../ManageMessageDrawer';

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
    deviceName: null,
    ...overrides,
  } as InboxMessage;
}

// @test-scope safeguard: prevents drawer lifecycle, async suggestion/upload, and edit flows from losing message content or applying stale state.
describe('ManageMessageDrawer edit mode', () => {
  afterEach(() => {
    textFieldPropsByLabel.clear();
    autocompleteOnChangeByLabel.clear();
    autocompleteOnInputChangeByLabel.clear();
    autocompleteValuesByLabel.clear();
    autocompleteInputValuesByLabel.clear();
    autocompleteOptionLabelsByLabel.clear();
    pickerValuesByLabel.clear();
    drawerModalProps = undefined;
    drawerOnClose = undefined;
    directSubmitMocks.submitDirect.mockReset();
    directSubmitMocks.submitDirect.mockResolvedValue({ signal_message_id: 1 });
    directSubmitMocks.editDirectSubmit.mockReset();
    directSubmitMocks.copyDirectSubmit.mockReset();
    directSubmitMocks.createDeviceName.mockReset();
    directSubmitMocks.createDeviceName.mockResolvedValue({ id: 1 });
    directSubmitMocks.parseDirectSubmit.mockReset();
    directSubmitMocks.searchNetworkNames.mockReset();
    directSubmitMocks.searchNetworkNames.mockResolvedValue([]);
    networkMocks.getNetworksByIds.mockReset();
    networkMocks.getNetworksByIds.mockResolvedValue([]);
    unitMocks.getUnitsByIds.mockReset();
    unitMocks.getUnitsByIds.mockResolvedValue([]);
    inboxMessageActionMocks.deleteMessage.mockReset();
    inboxMessageActionMocks.deleteMessage.mockResolvedValue(undefined);
    aiIntelReportMocks.quickIntelReportSuggestion.mockReset();
    aiIntelReportMocks.quickIntelReportSuggestion.mockResolvedValue(null);
    document.body.innerHTML = '';
    referenceDataMocks.getTagsForDisplay.mockResolvedValue({ tagsMap: {}, tagsOrder: [] });
    referenceDataMocks.getUserSigintGroups.mockReset();
    referenceDataMocks.getGroupInfosBatch.mockReset();
    referenceDataMocks.getUserSigintGroups.mockResolvedValue([]);
    referenceDataMocks.getGroupInfosBatch.mockResolvedValue([]);
    setRecentValues({});
    uppyMocks.latest = null;
  });

  it('shows an inert report-edit loading shell with an enabled dismissal path', async () => {
    setRecentValues({});
    const onClose = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <ManageMessageDrawer
          open
          cyberEchoEnabled={false}
          currentUser={null}
          onClose={onClose}
          editAsReport
          editTargetLoadState={{ status: 'loading', reportId: 91 }}
        />,
      );
    });

    expect(container.textContent).toContain('Редагувати розвіддонесення');
    expect(container.textContent).not.toContain('Завантажуємо розвіддонесення');
    expect(container.querySelector('[aria-label="Завантаження розвіддонесення"]')).not.toBeNull();
    expect(container.querySelector('form')).toBeNull();
    const submit = container.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(submit.textContent).toBe('Зберегти');
    expect(submit.disabled).toBe(true);
    expect(directSubmitMocks.copyDirectSubmit).not.toHaveBeenCalled();
    expect(aiIntelReportMocks.quickIntelReportSuggestion).not.toHaveBeenCalled();
    expect(referenceDataMocks.getUserSigintGroups).not.toHaveBeenCalled();
    expect(drawerOnClose).toBeDefined();

    const closeIcon = container.querySelector('button[aria-label="Закрити"]') as HTMLButtonElement;
    expect(closeIcon.disabled).toBe(false);
    act(() => closeIcon.click());
    expect(onClose).toHaveBeenCalledOnce();

    const cancel = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Скасувати',
    );
    expect(cancel).toBeDefined();
    act(() => cancel?.click());
    expect(onClose).toHaveBeenCalledTimes(2);

    act(() => drawerOnClose?.({}, 'escapeKeyDown'));
    expect(onClose).toHaveBeenCalledTimes(3);

    root.unmount();
  });

  it('keeps report text empty while copied fields are loading', async () => {
    directSubmitMocks.copyDirectSubmit.mockReturnValue(new Promise(() => {}));
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
          reportSource={{ id: 42, message: buildMessage({ text: 'original card body' }) }}
        />,
      );
    });

    expect(textFieldPropsByLabel.get('Текст оригінального повідомлення')?.value).toBe(
      'original card body',
    );
    expect(textFieldPropsByLabel.get('Текст розвіддонесення')?.value).toBe('');

    root.unmount();
  });

  it('offers a suggestion for explicit application without auto-filling the report', async () => {
    directSubmitMocks.copyDirectSubmit.mockResolvedValue({
      payloads: [{ full_body: 'copied source', parent_signal_message_ids: [42] }],
    });
    aiIntelReportMocks.quickIntelReportSuggestion.mockResolvedValue({
      suggestions: ['Політ БпЛА.'],
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
          reportSource={{ id: 42, message: buildMessage() }}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector('[aria-label="ШІ пропозиція"]')).not.toBeNull();
    expect(aiIntelReportMocks.quickIntelReportSuggestion).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(textFieldPropsByLabel.get('Текст розвіддонесення')?.value).toBe('');
    expect(container.textContent).toContain('Політ БпЛА.');
    const suggestionButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Політ БпЛА.',
    );
    await act(async () => suggestionButton?.click());
    expect(textFieldPropsByLabel.get('Текст розвіддонесення')?.value).toBe('Політ БпЛА.');

    root.unmount();
  });

  it('navigates multiple suggestions and applies the selected variant', async () => {
    directSubmitMocks.copyDirectSubmit.mockResolvedValue({
      payloads: [{ full_body: 'copied source', parent_signal_message_ids: [42] }],
    });
    aiIntelReportMocks.quickIntelReportSuggestion.mockResolvedValue({
      suggestions: ['Облаштування позицій', 'Зайняття позицій', 'Виставлення НП'],
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
          reportSource={{ id: 42, message: buildMessage() }}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Облаштування позицій');
    expect(container.textContent).toContain('1/3');
    await act(async () => {
      (
        container.querySelector('[aria-label="Наступна ШІ пропозиція"]') as HTMLButtonElement
      ).click();
    });
    expect(container.textContent).toContain('Зайняття позицій');
    expect(container.textContent).toContain('2/3');
    const suggestionButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Зайняття позицій',
    );
    await act(async () => suggestionButton?.click());
    expect(textFieldPropsByLabel.get('Текст розвіддонесення')?.value).toBe('Зайняття позицій');

    root.unmount();
  });

  it('preserves operator text and offers the late suggestion for explicit application', async () => {
    directSubmitMocks.copyDirectSubmit.mockResolvedValue({
      payloads: [{ full_body: 'copied source', parent_signal_message_ids: [42] }],
    });
    let resolveSuggestion: ((value: { suggestions: string[] }) => void) | undefined;
    aiIntelReportMocks.quickIntelReportSuggestion.mockReturnValue(
      new Promise((resolve) => {
        resolveSuggestion = resolve;
      }),
    );
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
          reportSource={{ id: 42, message: buildMessage() }}
        />,
      );
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="quick-suggestion-loading"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="ШІ пропозиція"]')?.getAttribute('aria-busy')).toBe(
      'true',
    );
    expect(container.textContent).toContain('Формуємо ШІ пропозицію…');

    await act(async () => {
      textFieldPropsByLabel
        .get('Текст розвіддонесення')
        ?.onChange?.({ target: { value: 'Текст оператора' } });
      resolveSuggestion?.({ suggestions: ['Політ БпЛА.'] });
      await Promise.resolve();
    });

    expect(textFieldPropsByLabel.get('Текст розвіддонесення')?.value).toBe('Текст оператора');
    expect(container.textContent).toContain('Політ БпЛА.');
    const suggestionButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Політ БпЛА.',
    );
    await act(async () => suggestionButton?.click());
    expect(textFieldPropsByLabel.get('Текст розвіддонесення')?.value).toBe('Політ БпЛА.');

    root.unmount();
  });

  it('retries a failed suggestion request', async () => {
    directSubmitMocks.copyDirectSubmit.mockResolvedValue({
      payloads: [{ full_body: 'copied source', parent_signal_message_ids: [42] }],
    });
    aiIntelReportMocks.quickIntelReportSuggestion
      .mockRejectedValueOnce(new Error('request failed'))
      .mockResolvedValueOnce({ suggestions: ['Наявність БпЛА.'] });
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
          reportSource={{ id: 42, message: buildMessage() }}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Не вдалося сформувати пропозицію розвіддонесення.');
    expect(container.textContent).not.toContain('Повторити');
    const retryButton = container.querySelector(
      '[aria-label="Повторити формування ШІ пропозиції"]',
    ) as HTMLButtonElement;
    await act(async () => {
      retryButton?.click();
      await Promise.resolve();
    });
    expect(aiIntelReportMocks.quickIntelReportSuggestion).toHaveBeenCalledTimes(2);
    expect(textFieldPropsByLabel.get('Текст розвіддонесення')?.value).toBe('');
    expect(container.textContent).toContain('Наявність БпЛА.');

    root.unmount();
  });

  it('aborts a stale suggestion request when the drawer closes', async () => {
    directSubmitMocks.copyDirectSubmit.mockResolvedValue({
      payloads: [{ full_body: 'copied source', parent_signal_message_ids: [42] }],
    });
    let requestSignal: AbortSignal | undefined;
    aiIntelReportMocks.quickIntelReportSuggestion.mockImplementation(
      (_messageId: number, options?: { signal?: AbortSignal }) => {
        requestSignal = options?.signal;
        return new Promise(() => {});
      },
    );
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
          reportSource={{ id: 42, message: buildMessage() }}
        />,
      );
      await Promise.resolve();
    });
    expect(requestSignal?.aborted).toBe(false);

    await act(async () => {
      root.render(
        <ManageMessageDrawer
          open={false}
          cyberEchoEnabled={false}
          currentUser={null}
          onClose={vi.fn()}
          reportSource={{ id: 42, message: buildMessage() }}
        />,
      );
    });
    expect(requestSignal?.aborted).toBe(true);

    root.unmount();
  });

  it('allows report submission while a suggestion request is pending', async () => {
    directSubmitMocks.copyDirectSubmit.mockResolvedValue({
      payloads: [{ full_body: 'copied source', parent_signal_message_ids: [42] }],
    });
    aiIntelReportMocks.quickIntelReportSuggestion.mockReturnValue(new Promise(() => {}));
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
          reportSource={{ id: 42, message: buildMessage() }}
        />,
      );
      await Promise.resolve();
    });
    await act(async () => {
      textFieldPropsByLabel
        .get('Текст розвіддонесення')
        ?.onChange?.({ target: { value: 'Готовий текст оператора' } });
      await Promise.resolve();
    });
    await act(async () => {
      (container.querySelector('form') as HTMLFormElement).dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    });

    expect(directSubmitMocks.submitDirect).toHaveBeenCalledWith(
      expect.objectContaining({ full_body: 'Готовий текст оператора' }),
    );

    root.unmount();
  });

  it('creates a nested report from copied fields with optional group and retained media', async () => {
    referenceDataMocks.getUserSigintGroups.mockResolvedValue(['g-1']);
    referenceDataMocks.getGroupInfosBatch.mockResolvedValue([
      { masterKey: 'g-1', name: 'Group 1' },
    ]);
    directSubmitMocks.copyDirectSubmit.mockResolvedValue({
      payloads: [
        {
          full_body: 'original copied body',
          text: 'original copied body',
          comment: 'existing comment',
          to: ['alfa', 'сокіл'],
          signal_group_master_key: 'g-1',
          retained_media_ids: ['media-1'],
          parent_signal_message_ids: [42],
        },
      ],
    });
    directSubmitMocks.submitDirect.mockResolvedValue({ signal_message_id: 91 });
    const source = buildMessage({
      text: 'original card body',
      parentMessages: [
        {
          id: 7,
          isAccessible: true,
          isDeleted: false,
          text: 'earlier original body',
          attachmentsCount: 0,
          timestamp: null,
          date: null,
          time: null,
          groupName: null,
          groupMasterKey: 'g-1',
        },
      ],
      media: [
        {
          id: 'media-1',
          contentType: 'image/jpeg',
          fileName: 'photo.jpg',
          sizeBytes: 10,
          href: '/media/photo.jpg',
          transcription: null,
        },
      ],
      deviceName: 'source-device',
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <ManageMessageDrawer
          open
          cyberEchoEnabled
          currentUser={null}
          onClose={vi.fn()}
          reportSource={{ id: 42, message: source }}
        />,
      );
    });

    expect(directSubmitMocks.copyDirectSubmit).toHaveBeenCalledWith(
      [42],
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(container.textContent).toContain('Створити розвіддонесення');
    expect(textFieldPropsByLabel.get('Текст оригінального повідомлення')?.value).toBe(
      'original copied body',
    );
    expect(textFieldPropsByLabel.get('Текст розвіддонесення')?.value).toBe('');
    expect(textFieldPropsByLabel.get('Текст оригінального повідомлення')?.rows).toBe(6);
    expect(textFieldPropsByLabel.get('Текст розвіддонесення')?.rows).toBe(6);
    expect(autocompleteValuesByLabel.get('Назва пристрою')).toBe('');
    expect(autocompleteValuesByLabel.get('Позивні')).toEqual(['ALFA', 'СОКІЛ']);
    await act(async () => {
      autocompleteOnInputChangeByLabel.get('Позивні')?.(null, 'charlie', 'input');
    });
    expect(autocompleteInputValuesByLabel.get('Позивні')).toBe('CHARLIE');
    expect(autocompleteValuesByLabel.get('Група')).toBeNull();
    expect(textFieldPropsByLabel.get('Текст розвіддонесення')?.autoFocus).toBe(true);
    await act(async () => {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    });
    expect(document.activeElement).toBe(
      container.querySelector('textarea[aria-label="Текст розвіддонесення"]'),
    );
    const reportTextRow = container.querySelector('[data-testid="report-text-row"]');
    expect(reportTextRow?.textContent).not.toContain('Оригінальний текст');
    expect(reportTextRow?.textContent).not.toContain('Розвіддонесення');
    expect(reportTextRow?.parentElement?.firstElementChild).toBe(reportTextRow);
    expect(drawerSlotProps?.paper?.sx?.width).toBe('100vw');
    expect(container.querySelector('textarea[aria-label="Коментар"]')).toBeNull();
    expect(container.textContent).not.toContain('Розширені поля');
    expect(container.textContent).not.toContain('DMR метадані');

    const form = container.querySelector('form') as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(directSubmitMocks.submitDirect).not.toHaveBeenCalled();

    await act(async () => {
      textFieldPropsByLabel
        .get('Текст розвіддонесення')
        ?.onChange?.({ target: { value: 'new report body' } });
    });
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(directSubmitMocks.submitDirect).toHaveBeenCalledWith(
      expect.objectContaining({
        full_body: 'new report body',
        signal_group_master_key: null,
        retained_media_ids: ['media-1'],
        parent_signal_message_ids: [42],
        comment: undefined,
      }),
    );

    root.unmount();
  });

  it('shows the source card header above the original message when creating a report', async () => {
    setRecentValues({});
    referenceDataMocks.getUserSigintGroups.mockResolvedValue(['g-1']);
    referenceDataMocks.getGroupInfosBatch.mockResolvedValue([
      { masterKey: 'g-1', name: 'Група джерела' },
    ]);
    directSubmitMocks.copyDirectSubmit.mockResolvedValue({
      payloads: [{ full_body: 'original copied body' }],
    });
    const source = buildMessage({
      sender: 'sender-id',
      deviceName: 'device-1',
      unit: 'Підрозділ 1',
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <ManageMessageDrawer
          open
          cyberEchoEnabled
          currentUser={null}
          onClose={vi.fn()}
          reportSource={{ id: 42, message: source, senderName: 'Імʼя Відправника' }}
        />,
      );
    });

    const sourceHeader = container.querySelector('[data-testid="report-source-header"]');
    const originalMessage = container.querySelector(
      'textarea[aria-label="Текст оригінального повідомлення"]',
    );
    expect(sourceHeader).not.toBeNull();
    expect(sourceHeader?.textContent).toContain('13:45');
    expect(sourceHeader?.textContent).toContain('1.07');
    expect(sourceHeader?.textContent).toContain('Група джерела');
    expect(sourceHeader?.textContent).toContain('Імʼя Відправника');
    expect(sourceHeader?.textContent).not.toContain('sender-id');
    expect(sourceHeader?.textContent).toContain('149.500');
    expect(sourceHeader?.textContent).toContain('device-1');
    expect(sourceHeader?.textContent).toContain('Підрозділ 1');
    expect(sourceHeader?.textContent).toContain('Київ');
    expect(sourceHeader?.compareDocumentPosition(originalMessage!)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(sourceHeader?.parentElement).toBe(
      container.querySelector('[data-testid="report-text-row"]'),
    );
    expect(sourceHeader?.querySelector('[title="Час"]')).not.toBeNull();
    expect(sourceHeader?.querySelector('[title="Дата"]')).not.toBeNull();
    expect(sourceHeader?.querySelector('[title="Відправник"]')).not.toBeNull();

    root.unmount();
  });

  it('keeps the card network label when the source message has a stale legacy name', async () => {
    setRecentValues({});
    directSubmitMocks.copyDirectSubmit.mockResolvedValue({
      payloads: [{ full_body: 'original copied body' }],
    });
    const source = buildMessage({
      networkIds: [7],
      networkName: 'Застаріла мережа',
    });
    const reportSource = {
      id: 42,
      message: source,
      etalonDisplayModel: {
        primaryKind: 'network',
        displayValue: 'р/м Актуальна мережа',
        copyEtalonValue: 'р/м Актуальна мережа',
        copyLocationValue: 'Київ',
        renderedNetworks: [{ networkId: 7, label: 'р/м Актуальна мережа', badge: false }],
        showInlineLocationTooltip: false,
        locationDisplayValue: 'Київ',
      },
    } as unknown as NonNullable<ComponentProps<typeof ManageMessageDrawer>['reportSource']>;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <ManageMessageDrawer
          open
          cyberEchoEnabled
          currentUser={null}
          onClose={vi.fn()}
          reportSource={reportSource}
        />,
      );
    });

    const sourceHeader = container.querySelector('[data-testid="report-source-header"]');
    expect(sourceHeader?.textContent).toContain('р/м Актуальна мережа');
    expect(sourceHeader?.textContent).not.toContain('Застаріла мережа');

    root.unmount();
  });

  it('edits a standalone report using its backend parent summaries', async () => {
    directSubmitMocks.copyDirectSubmit.mockResolvedValue({
      payloads: [
        {
          full_body: 'original copied body',
          signal_group_master_key: 'g-1',
          parent_signal_message_ids: [42],
        },
      ],
    });
    directSubmitMocks.editDirectSubmit.mockResolvedValue({ signal_message_id: 91 });
    const report = buildMessage({
      text: 'existing report body',
      groupMasterKey: null,
      parentMessages: [
        {
          id: 42,
          isAccessible: true,
          isDeleted: false,
          text: 'original summary body',
          attachmentsCount: 0,
          timestamp: null,
          date: null,
          time: null,
          groupName: null,
          groupMasterKey: 'g-1',
        },
      ],
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
          editTarget={{ id: 91, message: report }}
          editAsReport
        />,
      );
    });

    expect(directSubmitMocks.copyDirectSubmit).toHaveBeenCalledWith(
      [42],
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(container.textContent).toContain('Редагувати розвіддонесення');
    expect(textFieldPropsByLabel.get('Текст оригінального повідомлення')?.value).toBe(
      'original copied body',
    );
    expect(textFieldPropsByLabel.get('Текст розвіддонесення')?.value).toBe('existing report body');

    const form = container.querySelector('form') as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(directSubmitMocks.editDirectSubmit).toHaveBeenCalledWith(
      91,
      expect.objectContaining({
        full_body: 'existing report body',
        signal_group_master_key: null,
      }),
    );
    expect(
      directSubmitMocks.editDirectSubmit.mock.calls[0][1].parent_signal_message_ids,
    ).toBeUndefined();

    root.unmount();
  });

  // @test-scope safeguard: prevents a linked message edit from copying or mutating its accessible parent report.
  it('edits a message with an accessible parent as an independent message by default', async () => {
    const onSubmitEdit = vi.fn();
    const message = buildMessage({
      text: 'forwarded accessible report body',
      groupMasterKey: 'g-2',
      parentMessages: [
        {
          id: 42,
          isAccessible: true,
          isDeleted: false,
          text: 'original summary body',
          attachmentsCount: 0,
          timestamp: null,
          date: '2026-08-17',
          time: '09:30',
          groupName: 'Original group',
          groupMasterKey: null,
        },
      ],
    });
    directSubmitMocks.editDirectSubmit.mockResolvedValue({
      signal_message_id: 91,
      message,
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
          editTarget={{ id: 91, message }}
          onSubmitEdit={onSubmitEdit}
        />,
      );
    });

    expect(directSubmitMocks.copyDirectSubmit).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Редагувати повідомлення');
    expect(container.textContent).not.toContain('Редагувати розвіддонесення');
    expect(textFieldPropsByLabel.get('Текст повідомлення')?.value).toBe(
      'forwarded accessible report body',
    );
    expect(textFieldPropsByLabel.has('Текст оригінального повідомлення')).toBe(false);

    await act(async () => {
      (container.querySelector('form') as HTMLFormElement).dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    });

    expect(directSubmitMocks.editDirectSubmit).toHaveBeenCalledWith(
      91,
      expect.objectContaining({
        full_body: 'forwarded accessible report body',
        signal_group_master_key: 'g-2',
      }),
    );
    expect(onSubmitEdit).toHaveBeenCalledWith(91, message);

    root.unmount();
  });

  // @test-scope safeguard: prevents report editing from attempting to copy an inaccessible parent and losing the edit session.
  it('keeps explicit report edit mode without copying when no parents are accessible', async () => {
    const report = buildMessage({
      text: 'existing report body',
      groupMasterKey: null,
      parentMessages: [
        {
          id: 42,
          isAccessible: false,
          isDeleted: false,
          text: '',
          attachmentsCount: 0,
          timestamp: null,
          date: null,
          time: null,
          groupName: null,
          groupMasterKey: null,
        },
      ],
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
          editTarget={{ id: 91, message: report }}
          editAsReport
        />,
      );
    });

    expect(directSubmitMocks.copyDirectSubmit).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Редагувати розвіддонесення');
    expect(textFieldPropsByLabel.get('Текст розвіддонесення')?.value).toBe('existing report body');
    expect(container.textContent).not.toContain('copy failed');

    root.unmount();
  });

  it('edits a forwarded report with an inaccessible parent as an independent message', async () => {
    const onSubmitEdit = vi.fn();
    const report = buildMessage({
      text: 'forwarded report body',
      groupMasterKey: 'g-2',
      parentMessages: [
        {
          id: 42,
          isAccessible: false,
          isDeleted: false,
          text: '',
          attachmentsCount: 0,
          timestamp: null,
          date: '2026-08-17',
          time: '09:30',
          groupName: 'Original group',
          groupMasterKey: null,
        },
      ],
    });
    directSubmitMocks.editDirectSubmit.mockResolvedValue({
      signal_message_id: 91,
      message: report,
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
          editTarget={{ id: 91, message: report }}
          onSubmitEdit={onSubmitEdit}
        />,
      );
    });

    expect(directSubmitMocks.copyDirectSubmit).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Редагувати повідомлення');
    expect(container.textContent).not.toContain('Редагувати розвіддонесення');
    expect(textFieldPropsByLabel.get('Текст повідомлення')?.value).toBe('forwarded report body');
    expect(textFieldPropsByLabel.has('Текст оригінального повідомлення')).toBe(false);
    expect(container.textContent).not.toContain('Видалити');

    await act(async () => {
      (container.querySelector('form') as HTMLFormElement).dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    });

    expect(directSubmitMocks.editDirectSubmit).toHaveBeenCalledWith(
      91,
      expect.objectContaining({
        full_body: 'forwarded report body',
        signal_group_master_key: 'g-2',
      }),
    );
    expect(onSubmitEdit).toHaveBeenCalledWith(91, report);

    root.unmount();
  });

  it('deletes a standalone report after confirmation', async () => {
    directSubmitMocks.copyDirectSubmit.mockResolvedValue({
      payloads: [{ full_body: 'original copied body' }],
    });
    const onClose = vi.fn();
    const onDeleteSuccess = vi.fn();
    const report = buildMessage({
      text: 'existing report body',
      parentMessages: [
        {
          id: 42,
          isAccessible: true,
          isDeleted: false,
          text: 'original summary body',
          attachmentsCount: 0,
          timestamp: null,
          date: null,
          time: null,
          groupName: null,
          groupMasterKey: 'g-1',
        },
      ],
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
          onClose={onClose}
          onDeleteSuccess={onDeleteSuccess}
          editTarget={{ id: 91, message: report }}
          editAsReport
        />,
      );
    });

    const deleteButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Видалити',
    );
    expect(deleteButton).toBeDefined();
    await act(async () => deleteButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(container.querySelector('[role="alertdialog"]')?.textContent).toContain(
      'Видалити розвіддонесення?',
    );

    const confirmButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Підтвердити видалення',
    );
    await act(async () => {
      confirmButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(inboxMessageActionMocks.deleteMessage).toHaveBeenCalledWith({ id: 91 });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onDeleteSuccess).toHaveBeenCalledWith(91);

    root.unmount();
  });

  it('keeps the report editor open when deletion fails', async () => {
    directSubmitMocks.copyDirectSubmit.mockResolvedValue({
      payloads: [{ full_body: 'original copied body' }],
    });
    inboxMessageActionMocks.deleteMessage.mockRejectedValue(new Error('delete failed'));
    const onClose = vi.fn();
    const report = buildMessage({
      parentMessages: [
        {
          id: 42,
          isAccessible: true,
          isDeleted: false,
          text: 'original summary body',
          attachmentsCount: 0,
          timestamp: null,
          date: null,
          time: null,
          groupName: null,
          groupMasterKey: 'g-1',
        },
      ],
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
          onClose={onClose}
          editTarget={{ id: 91, message: report }}
          editAsReport
        />,
      );
    });

    const clickButton = async (label: string) => {
      const button = Array.from(container.querySelectorAll('button')).find(
        (candidate) => candidate.textContent?.trim() === label,
      );
      await act(async () => button?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    };
    await clickButton('Видалити');
    await act(async () => {
      const confirmButton = Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent?.trim() === 'Підтвердити видалення',
      );
      confirmButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(container.textContent).toContain('delete failed');
    expect(onClose).not.toHaveBeenCalled();

    root.unmount();
  });

  it('restores focus before hiding the drawer from assistive technology', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <ManageMessageDrawer open cyberEchoEnabled={false} currentUser={null} onClose={vi.fn()} />,
      );
    });

    expect(drawerModalProps?.closeAfterTransition).toBe(true);

    root.unmount();
  });

  it('initializes shared create fields from recent values without applying suggestions as defaults', async () => {
    setRecentValues({
      group: ['g-1'],
      unit: ['u-1'],
      deviceName: ['device-1'],
      freq: ['149.500'],
      post: ['post-1'],
      callsigns: ['ALFA'],
      locations: ['Київ'],
    });
    referenceDataMocks.getUserSigintGroups.mockResolvedValue(['g-1']);
    referenceDataMocks.getGroupInfosBatch.mockResolvedValue([
      { masterKey: 'g-1', name: 'Group 1' },
    ]);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <ManageMessageDrawer open cyberEchoEnabled currentUser={null} onClose={vi.fn()} />,
      );
      await Promise.resolve();
    });

    expect(pickerValuesByLabel.get('Дата перехоплення')).toBeTruthy();
    expect(pickerValuesByLabel.get('Час перехоплення')).toBeTruthy();
    expect(autocompleteValuesByLabel.get('Група')).toMatchObject({ masterKey: 'g-1' });
    expect(autocompleteValuesByLabel.get('Підрозділ')).toBe('u-1');
    expect(autocompleteValuesByLabel.get('Назва пристрою')).toBe('device-1');
    expect(textFieldPropsByLabel.get('Частота')?.value ?? '').toBe('');
    expect(textFieldPropsByLabel.get('Пост')?.value ?? '').toBe('');

    root.unmount();
  });

  it('keeps create submission disabled until group and meaningful content are valid', async () => {
    referenceDataMocks.getUserSigintGroups.mockResolvedValue(['g-1']);
    referenceDataMocks.getGroupInfosBatch.mockResolvedValue([{ masterKey: 'g-1' }]);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <ManageMessageDrawer open cyberEchoEnabled={false} currentUser={null} onClose={vi.fn()} />,
      );
      await Promise.resolve();
    });

    const submitButton = () =>
      container.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(container.querySelector('legend')?.textContent).toContain('Вміст повідомлення');
    expect(container.textContent).toContain(
      'Додайте текст повідомлення або принаймні одне вкладення.',
    );
    const messageTextarea = container.querySelector(
      'textarea[aria-label="Текст повідомлення"]',
    ) as HTMLTextAreaElement;
    expect(messageTextarea.required).toBe(false);
    expect(messageTextarea.getAttribute('aria-required')).toBeNull();
    expect(submitButton().disabled).toBe(true);

    await act(async () => {
      autocompleteOnChangeByLabel.get('Група')?.(null, { masterKey: 'g-1' });
      await Promise.resolve();
    });
    expect(submitButton().disabled).toBe(true);

    await act(async () => {
      textFieldPropsByLabel.get('Текст повідомлення')?.onChange?.({ target: { value: '   ' } });
      await Promise.resolve();
    });
    expect(submitButton().disabled).toBe(true);

    await act(async () => {
      textFieldPropsByLabel.get('Текст повідомлення')?.onChange?.({ target: { value: 'message' } });
      await Promise.resolve();
    });
    expect(submitButton().disabled).toBe(false);

    root.unmount();
  });

  it('clears a stale remembered group and disables submission after groups resolve', async () => {
    setRecentValues({ group: ['stale-group'] });
    referenceDataMocks.getUserSigintGroups.mockResolvedValue(['g-1']);
    referenceDataMocks.getGroupInfosBatch.mockResolvedValue([{ masterKey: 'g-1' }]);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <ManageMessageDrawer open cyberEchoEnabled={false} currentUser={null} onClose={vi.fn()} />,
      );
      await Promise.resolve();
    });

    expect(autocompleteValuesByLabel.get('Група')).toBeNull();
    expect((container.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(
      true,
    );
    root.unmount();
  });

  it('disables submission for invalid frequency and re-enables it when restored', async () => {
    referenceDataMocks.getUserSigintGroups.mockResolvedValue(['g-1']);
    referenceDataMocks.getGroupInfosBatch.mockResolvedValue([{ masterKey: 'g-1' }]);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <ManageMessageDrawer open cyberEchoEnabled={false} currentUser={null} onClose={vi.fn()} />,
      );
      await Promise.resolve();
    });

    const form = container.querySelector('form') as HTMLFormElement;
    const submitButton = container.querySelector('button[type="submit"]') as HTMLButtonElement;
    const expectEligibility = (expected: boolean) => {
      expect(submitButton.disabled).toBe(!expected);
    };

    expectEligibility(false);
    await act(async () => {
      autocompleteOnChangeByLabel.get('Група')?.(null, { masterKey: 'g-1' });
      textFieldPropsByLabel.get('Текст повідомлення')?.onChange?.({ target: { value: 'body' } });
      await Promise.resolve();
    });
    expectEligibility(true);

    await act(async () => {
      autocompleteOnChangeByLabel.get('Частота (МГц)')?.(null, 'not-a-frequency');
      await Promise.resolve();
    });
    expectEligibility(false);

    await act(async () => {
      autocompleteOnChangeByLabel.get('Частота (МГц)')?.(null, '149.500');
      await Promise.resolve();
    });
    expectEligibility(true);

    root.unmount();
  });

  it('disables submission for invalid coordinates while frequency remains valid', async () => {
    referenceDataMocks.getUserSigintGroups.mockResolvedValue(['g-1']);
    referenceDataMocks.getGroupInfosBatch.mockResolvedValue([{ masterKey: 'g-1' }]);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <ManageMessageDrawer open cyberEchoEnabled={false} currentUser={null} onClose={vi.fn()} />,
      );
      await Promise.resolve();
    });
    const submitButton = container.querySelector('button[type="submit"]') as HTMLButtonElement;

    await act(async () => {
      autocompleteOnChangeByLabel.get('Група')?.(null, { masterKey: 'g-1' });
      autocompleteOnChangeByLabel.get('Частота (МГц)')?.(null, '149.500');
      textFieldPropsByLabel.get('Текст повідомлення')?.onChange?.({ target: { value: 'body' } });
      await Promise.resolve();
    });
    expect(submitButton.disabled).toBe(false);

    await act(async () => {
      textFieldPropsByLabel
        .get('Додати координату')
        ?.onChange?.({ target: { value: 'not-a-coordinate' } });
      await Promise.resolve();
    });
    await act(async () => {
      textFieldPropsByLabel.get('Додати координату')?.onBlur?.();
      await Promise.resolve();
    });
    expect(submitButton.disabled).toBe(true);

    await act(async () => {
      textFieldPropsByLabel
        .get('Додати координату')
        ?.onChange?.({ target: { value: '49.1, 37.2' } });
      await Promise.resolve();
    });
    await act(async () => {
      textFieldPropsByLabel.get('Додати координату')?.onBlur?.();
      await Promise.resolve();
    });
    expect(submitButton.disabled).toBe(false);
    root.unmount();
  });

  it('shows an existing coordinate as a neutral hint without blocking submission', async () => {
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
            id: 42,
            message: buildMessage({ coords: '49.123457, 37.234568' }),
          }}
        />,
      );
    });

    await act(async () => {
      textFieldPropsByLabel
        .get('Додати координату')
        ?.onChange?.({ target: { value: '49.12346, 37.23457' } });
    });
    await act(async () => {
      textFieldPropsByLabel.get('Додати координату')?.onBlur?.();
    });

    const coordinateField = textFieldPropsByLabel.get('Додати координату');
    const submitButton = container.querySelector<HTMLButtonElement>('button[type="submit"]');
    expect(coordinateField?.value).toBe('49.12346, 37.23457');
    expect(coordinateField?.error).toBe(false);
    expect(container.textContent).toContain('Координата вже є у списку');
    expect(submitButton?.disabled).toBe(false);

    root.unmount();
  });

  it('disables submission for invalid DMR color code and restores it when corrected', async () => {
    referenceDataMocks.getUserSigintGroups.mockResolvedValue(['g-1']);
    referenceDataMocks.getGroupInfosBatch.mockResolvedValue([{ masterKey: 'g-1' }]);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <ManageMessageDrawer open cyberEchoEnabled={false} currentUser={null} onClose={vi.fn()} />,
      );
      await Promise.resolve();
    });
    await act(async () => {
      autocompleteOnChangeByLabel.get('Група')?.(null, { masterKey: 'g-1' });
      textFieldPropsByLabel.get('Текст повідомлення')?.onChange?.({ target: { value: 'body' } });
      await Promise.resolve();
    });

    await act(async () => {
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'Розширені поля')
        ?.click();
      await Promise.resolve();
    });
    await act(async () => {
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'Додати запис')
        ?.click();
      await Promise.resolve();
    });
    const submitButton = container.querySelector('button[type="submit"]') as HTMLButtonElement;
    await act(async () => {
      autocompleteOnChangeByLabel.get('Колірний код (CC)')?.(null, '16');
      await Promise.resolve();
    });
    expect(submitButton.disabled).toBe(true);
    container
      .querySelector('form')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    expect(directSubmitMocks.submitDirect).not.toHaveBeenCalled();

    await act(async () => {
      autocompleteOnChangeByLabel.get('Колірний код (CC)')?.(null, '15');
      await Promise.resolve();
    });
    expect(submitButton.disabled).toBe(false);
    root.unmount();
  });

  it('enables submission for a new attachment and disables it after removal', async () => {
    referenceDataMocks.getUserSigintGroups.mockResolvedValue(['g-1']);
    referenceDataMocks.getGroupInfosBatch.mockResolvedValue([{ masterKey: 'g-1' }]);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <ManageMessageDrawer open cyberEchoEnabled={false} currentUser={null} onClose={vi.fn()} />,
      );
      await Promise.resolve();
    });

    await act(async () => {
      autocompleteOnChangeByLabel.get('Група')?.(null, { masterKey: 'g-1' });
      await Promise.resolve();
    });
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(fileInput, 'files', {
      configurable: true,
      value: [new File(['attachment'], 'attachment.txt', { type: 'text/plain' })],
    });
    await act(async () => {
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });

    const submitButton = container.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(submitButton.disabled).toBe(false);

    const removeButton = container.querySelector('button[aria-label="Видалити attachment.txt"]');
    await act(async () => {
      (removeButton as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(submitButton.disabled).toBe(true);

    root.unmount();
  });

  it('shows progress for each uploading attachment', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <ManageMessageDrawer open cyberEchoEnabled={false} currentUser={null} onClose={vi.fn()} />,
      );
      await Promise.resolve();
    });

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(fileInput, 'files', {
      configurable: true,
      value: [new File(['video'], 'video.mp4', { type: 'video/mp4' })],
    });
    await act(async () => {
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });

    await act(async () => {
      uppyMocks.latest?.emitUploadProgress(37);
      await Promise.resolve();
    });
    const progress = container.querySelector(
      'progress[aria-label="Прогрес завантаження video.mp4"]',
    ) as HTMLProgressElement;
    expect(progress.value).toBe(37);
    expect(container.textContent).toContain('Завантаження: 37%');

    await act(async () => {
      uppyMocks.latest?.emitUploadSuccess();
      await Promise.resolve();
    });
    expect(progress.value).toBe(100);
    expect(container.textContent).toContain('Завантажено');

    root.unmount();
  });

  it('enforces the 20-attachment limit through the real drawer integration', async () => {
    referenceDataMocks.getUserSigintGroups.mockResolvedValue(['g-1']);
    referenceDataMocks.getGroupInfosBatch.mockResolvedValue([{ masterKey: 'g-1' }]);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <ManageMessageDrawer open cyberEchoEnabled={false} currentUser={null} onClose={vi.fn()} />,
      );
      await Promise.resolve();
    });
    await act(async () => {
      autocompleteOnChangeByLabel.get('Група')?.(null, { masterKey: 'g-1' });
      await Promise.resolve();
    });

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(fileInput, 'files', {
      configurable: true,
      value: Array.from(
        { length: 21 },
        (_, index) =>
          new File([`attachment-${index}`], `attachment-${index}.txt`, { type: 'text/plain' }),
      ),
    });
    await act(async () => {
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Вкладення (20)');
    expect(container.textContent).toContain('Перевищено максимальну кількість файлів (20)');
    expect((container.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(
      false,
    );
    root.unmount();
  });

  it('counts retained edit media together with new attachments', async () => {
    const media = Array.from({ length: 20 }, (_, index) => ({
      id: `media-${index}`,
      contentType: 'text/plain',
      fileName: `media-${index}.txt`,
      sizeBytes: 1,
      href: `/media/${index}`,
    }));
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
          editTarget={{ id: 1, message: buildMessage({ media }) }}
          onSubmitEdit={vi.fn()}
        />,
      );
      await Promise.resolve();
    });

    expect((container.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(
      false,
    );
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(fileInput, 'files', {
      configurable: true,
      value: [new File(['new'], 'new.txt', { type: 'text/plain' })],
    });
    await act(async () => {
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });
    expect(container.textContent).toContain('Вкладення (20)');
    expect(container.textContent).not.toContain('Вкладення (21)');
    expect(container.textContent).not.toContain('new.txt');
    expect(container.textContent).toContain('Перевищено максимальну кількість файлів (20)');
    expect((container.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(
      false,
    );

    await act(async () => {
      (
        container.querySelector('button[aria-label="Видалити media-0.txt"]') as HTMLButtonElement
      ).click();
      await Promise.resolve();
    });
    Object.defineProperty(fileInput, 'files', {
      configurable: true,
      value: [new File(['new'], 'new.txt', { type: 'text/plain' })],
    });
    await act(async () => {
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });
    expect(container.textContent).toContain('Вкладення (20)');
    expect(container.textContent).not.toContain('Вкладення (21)');
    expect(container.textContent).toContain('new.txt');
    expect(container.textContent).not.toContain('Перевищено максимальну кількість файлів (20)');
    expect((container.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(
      false,
    );
    root.unmount();
  });

  it('allows an edit with only one retained attachment, then requires content after removal', async () => {
    const media = [
      {
        id: 'media-1',
        contentType: 'text/plain',
        fileName: 'media-1.txt',
        sizeBytes: 1,
        href: '/media/1',
      },
    ];
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
          editTarget={{ id: 1, message: buildMessage({ text: '', media }) }}
          onSubmitEdit={vi.fn()}
        />,
      );
      await Promise.resolve();
    });

    const submitButton = container.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(submitButton.disabled).toBe(false);

    await act(async () => {
      (
        container.querySelector('button[aria-label="Видалити media-1.txt"]') as HTMLButtonElement
      ).click();
      await Promise.resolve();
    });
    expect(submitButton.disabled).toBe(true);

    await act(async () => {
      textFieldPropsByLabel.get('Текст повідомлення')?.onChange?.({ target: { value: 'body' } });
      await Promise.resolve();
    });
    expect(submitButton.disabled).toBe(false);
    root.unmount();
  });

  it('blocks duplicate keyboard and direct submissions while a valid create is pending', async () => {
    let resolveSubmit!: (value: { signal_message_id: number }) => void;
    const response = { signal_message_id: 1 };
    const onClose = vi.fn();
    const onCreated = vi.fn();
    directSubmitMocks.submitDirect.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSubmit = resolve;
      }),
    );
    referenceDataMocks.getUserSigintGroups.mockResolvedValue(['g-1']);
    referenceDataMocks.getGroupInfosBatch.mockResolvedValue([{ masterKey: 'g-1' }]);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    function ControlledHarness() {
      const [open, setOpen] = useState(true);

      return (
        <ManageMessageDrawer
          open={open}
          cyberEchoEnabled={false}
          currentUser={null}
          onClose={() => {
            onClose();
            setOpen(false);
          }}
          onCreated={onCreated}
        />
      );
    }

    await act(async () => {
      root.render(<ControlledHarness />);
      await Promise.resolve();
    });

    const form = container.querySelector('form') as HTMLFormElement;
    const submitButton = container.querySelector('button[type="submit"]') as HTMLButtonElement;
    const dispatchShortcut = () =>
      form.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );

    await act(async () => {
      autocompleteOnChangeByLabel.get('Група')?.(null, { masterKey: 'g-1' });
      textFieldPropsByLabel.get('Текст повідомлення')?.onChange?.({ target: { value: 'body' } });
      await Promise.resolve();
    });
    expect(submitButton.disabled).toBe(false);

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      await Promise.resolve();
    });
    expect(directSubmitMocks.submitDirect).toHaveBeenCalledTimes(1);
    expect(submitButton.disabled).toBe(true);
    expect(submitButton.textContent).toBe('Збереження...');

    await act(async () => {
      dispatchShortcut();
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      submitButton.click();
      await Promise.resolve();
    });
    expect(directSubmitMocks.submitDirect).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveSubmit(response);
      for (let index = 0; index < 5; index += 1) await Promise.resolve();
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(onCreated).toHaveBeenCalledWith(response);
    expect(container.querySelector('form')).toBeNull();
    expect(container.textContent).not.toContain('Сталася помилка');
    root.unmount();
  });

  it('blocks submission while parsing and restores eligibility after parsing completes', async () => {
    let resolveParse!: (value: Record<string, unknown>) => void;
    directSubmitMocks.parseDirectSubmit.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveParse = resolve;
      }),
    );
    referenceDataMocks.getUserSigintGroups.mockResolvedValue(['g-1']);
    referenceDataMocks.getGroupInfosBatch.mockResolvedValue([{ masterKey: 'g-1' }]);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <ManageMessageDrawer open cyberEchoEnabled={false} currentUser={null} onClose={vi.fn()} />,
      );
      await Promise.resolve();
    });
    await act(async () => {
      autocompleteOnChangeByLabel.get('Група')?.(null, { masterKey: 'g-1' });
      textFieldPropsByLabel.get('Текст повідомлення')?.onChange?.({ target: { value: 'body' } });
      await Promise.resolve();
    });

    const parseButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Розпарсити',
    ) as HTMLButtonElement;
    const form = container.querySelector('form') as HTMLFormElement;
    const submitButton = container.querySelector('button[type="submit"]') as HTMLButtonElement;
    await act(async () => {
      parseButton.click();
      await Promise.resolve();
    });
    expect(submitButton.disabled).toBe(true);
    form.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }),
    );
    expect(directSubmitMocks.submitDirect).not.toHaveBeenCalled();

    await act(async () => {
      resolveParse({ text: 'parsed body' });
      await Promise.resolve();
    });
    expect(submitButton.disabled).toBe(false);
    root.unmount();
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
          cyberEchoEnabled
          currentUser={null}
          onClose={vi.fn()}
          editTarget={{
            id: 42,
            message: buildMessage({
              networkName: 'Network Alpha',
              deviceName: 'Incorrect device',
            }),
          }}
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

    expect(container.textContent).not.toContain('Запропоновані позивні');

    // Add a callsign via Enter in the ported callsign editor.
    act(() => {
      autocompleteOnChangeByLabel.get('Позивні')?.(null, ['ALFA', 'charlie']);
    });
    expect(container.textContent).toContain('CHARLIE');

    act(() => {
      autocompleteOnChangeByLabel.get('Назва пристрою')?.(null, null);
    });

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
        device_name_id: null,
        network: {
          signal_name: 'DMR',
          cc: undefined,
          name: 'Network Alpha',
        },
      }),
    );

    root.unmount();
  });

  // ECHO-3073: both the edit response and a later reopen may contain repeated tag IDs.
  it('keeps tag selections unique across edit save response and reopen', async () => {
    referenceDataMocks.getTagsForDisplay.mockResolvedValue({
      tagsMap: { 7: { label: 'арта' }, 9: { label: 'зв’язок' } },
      tagsOrder: [7, 9],
    });
    const initialMessage = buildMessage({ tags: [7] });
    const savedResponse = buildMessage({ text: 'edited body', tags: [7, 7, 9, 9] });
    const onSubmitEdit = vi.fn();
    directSubmitMocks.editDirectSubmit.mockResolvedValue({
      signal_message_id: 42,
      message: savedResponse,
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const render = (open: boolean, message: InboxMessage) =>
      root.render(
        <ManageMessageDrawer
          open={open}
          cyberEchoEnabled={false}
          currentUser={null}
          onClose={vi.fn()}
          editTarget={{ id: 42, message }}
          onSubmitEdit={onSubmitEdit}
        />,
      );

    await act(async () => {
      render(true, initialMessage);
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
    expect(autocompleteValuesByLabel.get('Теги')).toEqual(['арта']);

    act(() => {
      textFieldPropsByLabel
        .get('Текст повідомлення')
        ?.onChange?.({ target: { value: 'edited body' } });
    });
    await act(async () => {
      (container.querySelector('form') as HTMLFormElement).dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    });
    expect(directSubmitMocks.editDirectSubmit).toHaveBeenCalledTimes(1);
    expect(directSubmitMocks.editDirectSubmit).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ full_body: 'edited body', tags: ['арта'] }),
    );
    expect(onSubmitEdit).toHaveBeenCalledWith(42, savedResponse);

    await act(async () => {
      render(false, initialMessage);
    });
    await act(async () => {
      render(true, onSubmitEdit.mock.calls[0][1] as InboxMessage);
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
    expect(autocompleteValuesByLabel.get('Теги')).toEqual(['арта', 'зв’язок']);
    expect(textFieldPropsByLabel.get('Текст повідомлення')?.value).toBe('edited body');

    await act(async () => {
      (container.querySelector('form') as HTMLFormElement).dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    });
    expect(directSubmitMocks.editDirectSubmit).toHaveBeenCalledTimes(2);
    expect(directSubmitMocks.editDirectSubmit).toHaveBeenLastCalledWith(
      42,
      expect.objectContaining({ full_body: 'edited body', tags: ['арта', 'зв’язок'] }),
    );

    root.unmount();
  });

  it('hydrates a calculated network and its units when stored fields are empty', async () => {
    networkMocks.getNetworksByIds.mockResolvedValue([
      {
        id: 5,
        name: '💻',
        unitIds: [51],
      },
    ]);
    unitMocks.getUnitsByIds.mockResolvedValue([
      {
        id: 51,
        name: '4 зБпС 50 обрБпС',
      },
    ]);
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
            id: 3008768,
            message: buildMessage({
              networkIds: [5],
              networkName: 'stale freeform network',
              unit: null,
            }),
          }}
          onSubmitEdit={vi.fn()}
        />,
      );
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });

    expect(networkMocks.getNetworksByIds).toHaveBeenCalledWith([5]);
    expect(unitMocks.getUnitsByIds).toHaveBeenCalledWith([51]);
    expect(autocompleteValuesByLabel.get('Мережа')).toMatchObject({ id: 5, name: '💻' });
    expect(autocompleteInputValuesByLabel.get('Мережа')).toBe('💻 — 4 зБпС 50 обрБпС');
    expect(autocompleteOptionLabelsByLabel.get('Мережа')).toContain('💻 — 4 зБпС 50 обрБпС');
    expect(autocompleteValuesByLabel.get('Підрозділ')).toBe('4 зБпС 50 обрБпС');

    root.unmount();
  });

  // ECHO-3073: late dictionary hydration must not reintroduce duplicate chips.
  it('backfills unique tags after the async load without clobbering an in-window edit', async () => {
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
      message: buildMessage({ extendedForm: 'existing comment', tags: [7, 7, 9, 9] }),
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
            id: 55,
            message: buildMessage({ extendedForm: 'existing comment', tags: [7, 7, 9, 9] }),
          }}
          editSaveInFlight={false}
          onSubmitEdit={onSubmitEdit}
        />,
      );
    });

    // Tags not yet seeded (async load still pending).
    expect(container.textContent).not.toContain('арта');

    // User edits a non-tag field WHILE tags are still loading.
    expect(container.querySelector('textarea[aria-label="Коментар"]')).toBeNull();
    act(() => {
      textFieldPropsByLabel
        .get('Текст повідомлення')
        ?.onChange?.({ target: { value: 'edited body' } });
    });

    // Now the tags fetch resolves.
    await act(async () => {
      resolveTags({
        tagsMap: { 7: { label: 'арта' }, 9: { label: 'зв’язок' } },
        tagsOrder: [7, 9],
      });
    });

    // Tags backfilled after the async load...
    expect(container.textContent).toContain('арта');
    expect(autocompleteValuesByLabel.get('Теги')).toEqual(['арта', 'зв’язок']);

    const form = container.querySelector('form') as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(onSubmitEdit).toHaveBeenCalledTimes(1);
    // ...and the in-window text edit was NOT clobbered by a second reset().
    expect(directSubmitMocks.editDirectSubmit).toHaveBeenCalledWith(
      55,
      expect.objectContaining({ full_body: 'edited body', comment: 'existing comment' }),
    );
    expect(onSubmitEdit.mock.calls[0][1]).toMatchObject({
      extendedForm: 'existing comment',
      tags: [7, 7, 9, 9],
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
          onCreated={vi.fn()}
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
          onCreated={vi.fn()}
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

  it('closes the rendered create composer before notifying the host when the callback rejects', async () => {
    const onClose = vi.fn();
    const onCreated = vi.fn().mockRejectedValue(new Error('preview failed'));
    setRecentValues({ deviceName: ['remembered-device'] });
    referenceDataMocks.getUserSigintGroups.mockResolvedValue(['g-1']);
    referenceDataMocks.getGroupInfosBatch.mockResolvedValue([{ masterKey: 'g-1' }]);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    function ControlledHarness() {
      const [open, setOpen] = useState(true);

      return (
        <ManageMessageDrawer
          open={open}
          cyberEchoEnabled={false}
          currentUser={null}
          onClose={() => {
            onClose();
            setOpen(false);
          }}
          onCreated={onCreated}
        />
      );
    }

    await act(async () => {
      root.render(<ControlledHarness />);
    });

    await act(async () => {
      textFieldPropsByLabel.get('Текст повідомлення')?.onChange?.({
        target: { value: 'new message body' },
      });
      autocompleteOnChangeByLabel.get('Група')?.(null, {
        masterKey: 'g-1',
        name: 'Group 1',
      });
      await Promise.resolve();
    });

    const form = container.querySelector('form') as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(directSubmitMocks.submitDirect).toHaveBeenCalledTimes(1);
    expect(directSubmitMocks.createDeviceName).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain('preview failed');
    expect(container.textContent).not.toContain('Помилка');
    expect(container.querySelector('form')).toBeNull();

    root.unmount();
  });

  it('closes the rendered edit composer when the host edit callback rejects', async () => {
    const onSubmitEdit = vi.fn().mockRejectedValue(new Error('editor failed'));
    const onEditSuccess = vi.fn();
    const onClose = vi.fn();
    const onCreated = vi.fn();
    directSubmitMocks.editDirectSubmit.mockResolvedValue({
      signal_message_id: 123,
      message: buildMessage(),
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    function ControlledHarness() {
      const [open, setOpen] = useState(true);

      return (
        <ManageMessageDrawer
          open={open}
          cyberEchoEnabled
          currentUser={null}
          onClose={() => {
            onClose();
            setOpen(false);
          }}
          editTarget={{ id: 123, message: buildMessage() }}
          editSaveInFlight={false}
          onSubmitEdit={onSubmitEdit}
          onEditSuccess={onEditSuccess}
          onCreated={onCreated}
        />
      );
    }

    await act(async () => {
      root.render(<ControlledHarness />);
    });

    const form = container.querySelector('form') as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(directSubmitMocks.editDirectSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmitEdit).toHaveBeenCalledTimes(1);
    expect(onEditSuccess).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain('Редагувати повідомлення');
    expect(container.querySelector('form')).toBeNull();
    expect(container.textContent).not.toContain('editor failed');
    expect(container.textContent).not.toContain('Помилка');
    expect(onCreated).not.toHaveBeenCalled();

    root.unmount();
  });

  it('applies a coordinate deletion locally without requesting a fallback reload', async () => {
    const editedMessage = buildMessage({ coords: null, coordsWithLocality: [] });
    const onSubmitEdit = vi.fn();
    const onEditSuccess = vi.fn();
    directSubmitMocks.editDirectSubmit.mockResolvedValue({
      signal_message_id: 124,
      message: editedMessage,
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
          editTarget={{ id: 124, message: buildMessage() }}
          onSubmitEdit={onSubmitEdit}
          onEditSuccess={onEditSuccess}
        />,
      );
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Видалити координату 1"]')
        ?.click();
    });
    await act(async () => {
      (container.querySelector('form') as HTMLFormElement).dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    });

    expect(directSubmitMocks.editDirectSubmit).toHaveBeenCalledWith(
      124,
      expect.objectContaining({ coords: [] }),
    );
    expect(onSubmitEdit).toHaveBeenCalledWith(124, editedMessage);
    expect(onEditSuccess).not.toHaveBeenCalled();

    root.unmount();
  });

  it('closes and reports edit success when the response has no inline message', async () => {
    const onSubmitEdit = vi.fn();
    const onEditSuccess = vi.fn();
    const onClose = vi.fn();
    directSubmitMocks.editDirectSubmit.mockResolvedValue({ signal_message_id: 124 });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    function ControlledHarness() {
      const [open, setOpen] = useState(true);
      return (
        <ManageMessageDrawer
          open={open}
          cyberEchoEnabled={false}
          currentUser={null}
          onClose={() => {
            onClose();
            setOpen(false);
          }}
          editTarget={{ id: 124, message: buildMessage() }}
          onSubmitEdit={onSubmitEdit}
          onEditSuccess={onEditSuccess}
        />
      );
    }

    await act(async () => root.render(<ControlledHarness />));
    await act(async () => {
      (container.querySelector('form') as HTMLFormElement).dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    });

    expect(onSubmitEdit).not.toHaveBeenCalled();
    expect(onEditSuccess).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(container.querySelector('form')).toBeNull();
    expect(container.textContent).not.toContain('Помилка');
    root.unmount();
  });

  it('does not call edit success callbacks when the edit API rejects', async () => {
    const onSubmitEdit = vi.fn();
    const onEditSuccess = vi.fn();
    const onClose = vi.fn();
    directSubmitMocks.editDirectSubmit.mockRejectedValue(new Error('edit request failed'));
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <ManageMessageDrawer
          open
          cyberEchoEnabled={false}
          currentUser={null}
          onClose={onClose}
          editTarget={{ id: 125, message: buildMessage() }}
          onSubmitEdit={onSubmitEdit}
          onEditSuccess={onEditSuccess}
        />,
      );
    });
    await act(async () => {
      (container.querySelector('form') as HTMLFormElement).dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    });

    expect(onSubmitEdit).not.toHaveBeenCalled();
    expect(onEditSuccess).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(container.textContent).toContain('edit request failed');
    root.unmount();
  });

  it('keeps the drawer closed without a submission error when edit success rejects', async () => {
    const onEditSuccess = vi.fn().mockRejectedValue(new Error('reload failed'));
    const onClose = vi.fn();
    directSubmitMocks.editDirectSubmit.mockResolvedValue({ signal_message_id: 126 });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <ManageMessageDrawer
          open
          cyberEchoEnabled={false}
          currentUser={null}
          onClose={onClose}
          editTarget={{ id: 126, message: buildMessage() }}
          onEditSuccess={onEditSuccess}
        />,
      );
    });
    await act(async () => {
      (container.querySelector('form') as HTMLFormElement).dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    });

    expect(onEditSuccess).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain('Помилка');
    root.unmount();
  });
});
