/**
 * @vitest-environment happy-dom
 */
import type { User } from '../../../../../Bindings';
import type { ComponentProps, ReactNode, Ref } from 'react';
import { act, createRef, forwardRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InboxMessage } from '../../../../../../Bindings';
import dayjs from 'dayjs';

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
  searchFreqs: vi.fn().mockResolvedValue([]),
  searchPostNames: vi.fn().mockResolvedValue([]),
  searchUnitNames: vi.fn().mockResolvedValue([]),
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
    files: Array<Record<string, unknown>>;
    addFile: (file: Record<string, unknown>) => Record<string, unknown>;
    emitUploadProgress: (percentage: number) => void;
    emitUploadSuccess: () => void;
  } | null,
}));
const dutySettingsMocks = vi.hoisted(() => ({
  messageAutoParseEnabled: false,
  loadInProgress: false,
  loadError: null as string | null,
  saveInProgress: false,
  saveError: null as string | null,
  setMessageAutoParseEnabled: vi.fn(),
  scheduleSave: vi.fn(),
  retryLoad: vi.fn(),
  unstableSetter: false,
}));

vi.mock('../../../../hooks/use-duty-settings', () => ({
  useDutySettings: () => ({
    messageAutoParseEnabled: dutySettingsMocks.messageAutoParseEnabled,
    loadInProgress: dutySettingsMocks.loadInProgress,
    loadError: dutySettingsMocks.loadError,
    saveInProgress: dutySettingsMocks.saveInProgress,
    saveError: dutySettingsMocks.saveError,
    setMessageAutoParseEnabled: dutySettingsMocks.unstableSetter
      ? (value: boolean) => dutySettingsMocks.setMessageAutoParseEnabled(value)
      : dutySettingsMocks.setMessageAutoParseEnabled,
    scheduleSave: dutySettingsMocks.scheduleSave,
    retryLoad: dutySettingsMocks.retryLoad,
  }),
}));

vi.mock('../../../../services/api/inbox-reference-data', () => ({
  getUserSigintGroups: referenceDataMocks.getUserSigintGroups,
  getGroupInfosBatch: referenceDataMocks.getGroupInfosBatch,
  getTagsForDisplay: referenceDataMocks.getTagsForDisplay,
}));
vi.mock('../../../../services/api/direct-submit', () => ({
  searchDeviceName: vi.fn().mockResolvedValue(null),
  searchDeviceNames: vi.fn().mockResolvedValue([]),
  searchPostNames: directSubmitMocks.searchPostNames,
  searchUnitNames: directSubmitMocks.searchUnitNames,
  resolveUnitNames: vi.fn(async (names: string[]) =>
    names.map((name, index) => ({ id: index + 1, name })),
  ),
  searchNetworkNames: directSubmitMocks.searchNetworkNames,
  searchSignalNames: vi.fn().mockResolvedValue([]),
  searchCallsignNames: vi.fn().mockResolvedValue([]),
  searchFreqs: directSubmitMocks.searchFreqs,
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
    cancelLabel = 'Скасувати видалення',
    confirmLabel = 'Підтвердити видалення',
    submitting,
  }: {
    open: boolean;
    onClose: () => void;
    onConfirm: () => void;
    title?: ReactNode;
    description?: ReactNode;
    cancelLabel?: ReactNode;
    confirmLabel?: ReactNode;
    submitting?: boolean;
  }) =>
    open ? (
      <div role="alertdialog">
        <div>{title}</div>
        <div>{description}</div>
        <button type="button" onClick={onClose} disabled={submitting}>
          {cancelLabel}
        </button>
        <button type="button" onClick={onConfirm} disabled={submitting}>
          {confirmLabel}
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
vi.mock('@mui/icons-material/CheckCircle', () => ({
  default: ({
    'data-testid': testId = 'check-icon',
    color,
  }: {
    'data-testid'?: string;
    color?: string;
  }) => <span data-testid={testId} data-color={color} />,
}));
vi.mock('@mui/icons-material/ErrorOutline', () => ({
  default: ({
    'data-testid': testId = 'error-icon',
    color,
  }: {
    'data-testid'?: string;
    color?: string;
  }) => <span data-testid={testId} data-color={color} />,
}));
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
  PowerAlert: ({
    action,
    children,
    onClose,
  }: {
    action?: ReactNode;
    children?: ReactNode;
    onClose?: () => void;
  }) => (
    <div role="alert">
      {children}
      {action}
      {onClose ? (
        <button type="button" aria-label="Закрити сповіщення" onClick={onClose}>
          Закрити
        </button>
      ) : null}
    </div>
  ),
}));
vi.mock('../../../../components/loadingOverlayStyles', () => ({
  pageDrawerBackdropSx: () => ({}),
}));
vi.mock('@mui/x-date-pickers/TimePicker', () => ({
  TimePicker: ({
    label,
    value,
    onChange,
  }: {
    label?: string;
    value?: unknown;
    onChange: (value: unknown) => void;
  }) => {
    if (label) {
      pickerValuesByLabel.set(label, value);
      timePickerOnChange.set(label, onChange);
    }
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
  required?: boolean;
  inputProps?: { value?: string };
  slotProps?: { htmlInput?: { style?: Record<string, string>; value?: string } };
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
const autocompleteOptionsByLabel = new Map<string, unknown[]>();
const pickerValuesByLabel = new Map<string, unknown>();
const timePickerOnChange = new Map<string, (value: unknown) => void>();
let drawerModalProps: { closeAfterTransition?: boolean } | undefined;
let drawerSlotProps:
  | {
      paper?: {
        style?: { width?: string; maxWidth?: string };
        sx?: { width?: string | Record<string, string | number> };
      };
    }
  | undefined;
type DrawerCloseReason = 'escapeKeyDown' | 'backdropClick';
let drawerOnClose: ((event: unknown, reason: DrawerCloseReason) => void) | undefined;

function setRecentValues(values: Record<string, unknown>) {
  const stored = new Map([['cyberEcho_recentMessageFields', JSON.stringify(values)]]);
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: vi.fn((key: string) => stored.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => stored.set(key, value)),
      removeItem: vi.fn((key: string) => stored.delete(key)),
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
  ButtonGroup: ({
    children,
    'aria-label': ariaLabel,
  }: {
    children?: ReactNode;
    'aria-label'?: string;
  }) => (
    <div role="group" aria-label={ariaLabel}>
      {children}
    </div>
  ),
  Divider: () => <hr />,
  Dialog: ({ children, open }: { children?: ReactNode; open?: boolean }) =>
    open ? <div role="dialog">{children}</div> : null,
  DialogActions: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
  Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Menu: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  MenuItem: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
    <button type="button" role="menuitem" onClick={onClick}>
      {children}
    </button>
  ),
  FormControlLabel: ({ control, label }: { control?: ReactNode; label?: ReactNode }) => (
    <label>
      {control}
      {label}
    </label>
  ),
  Switch: ({
    checked,
    onChange,
  }: {
    checked?: boolean;
    onChange?: (e: unknown, checked: boolean) => void;
  }) => (
    <input type="checkbox" checked={checked} onChange={(e) => onChange?.(e, e.target.checked)} />
  ),
  ListItemIcon: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  ListItemText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Typography: ({
    children,
    component = 'div',
    onClick,
    title,
    type,
    role,
    'aria-live': ariaLive,
  }: {
    children?: ReactNode;
    component?: string;
    onClick?: () => void;
    title?: string;
    type?: 'button';
    role?: string;
    'aria-live'?: 'off' | 'assertive' | 'polite';
  }) => {
    const Component = component as keyof HTMLElementTagNameMap;
    return (
      <Component onClick={onClick} title={title} type={type} role={role} aria-live={ariaLive}>
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
    ...props
  }: {
    children?: ReactNode;
    open?: boolean;
    onClose?: (event: unknown, reason: DrawerCloseReason) => void;
    ModalProps?: { closeAfterTransition?: boolean };
    slotProps?: {
      paper?: {
        style?: { width?: string; maxWidth?: string };
        sx?: { width?: string | Record<string, string | number> };
      };
    };
  }) => {
    drawerOnClose = onClose;
    drawerModalProps = ModalProps;
    drawerSlotProps = slotProps;
    return open ? (
      <div role="dialog" {...(props as Record<string, unknown>)}>
        {children}
      </div>
    ) : null;
  },
  Paper: forwardRef(
    (
      {
        children,
        component = 'div',
        ...props
      }: { children?: ReactNode; component?: string } & Record<string, unknown>,
      ref,
    ) => {
      const Component = component as keyof HTMLElementTagNameMap;
      const { sx: _sx, elevation: _elevation, ...rest } = props;
      return (
        <Component {...rest} ref={ref as never}>
          {children}
        </Component>
      );
    },
  ),
  useMediaQuery: () => false,
  Button: ({
    children,
    type = 'button',
    onClick,
    disabled,
    startIcon,
    'aria-label': ariaLabel,
    'aria-haspopup': ariaHasPopup,
    'aria-expanded': ariaExpanded,
  }: {
    children?: ReactNode;
    type?: 'button' | 'submit' | 'reset';
    onClick?: () => void;
    disabled?: boolean;
    startIcon?: ReactNode;
    'aria-label'?: string;
    'aria-haspopup'?: 'menu';
    'aria-expanded'?: 'true';
  } & Record<string, unknown>) => (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-haspopup={ariaHasPopup}
      aria-expanded={ariaExpanded}
    >
      {startIcon}
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
    required,
    inputProps,
    slotProps,
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
      required,
      inputProps,
      slotProps,
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
            required={required}
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
            value={value ?? slotProps?.htmlInput?.value ?? inputProps?.value ?? ''}
            disabled={disabled}
            required={required}
            style={slotProps?.htmlInput?.style}
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
    renderOption,
    loading: _loading,
  }: {
    renderInput?: (params: unknown) => ReactNode;
    value?: unknown;
    inputValue?: string;
    onChange?: (event: unknown, value: unknown) => void;
    onInputChange?: (event: unknown, value: string, reason: string) => void;
    options?: unknown[];
    getOptionLabel?: (option: unknown) => string;
    renderOption?: (props: { key: string }, option: unknown) => ReactNode;
    loading?: boolean;
  }) => {
    const input = renderInput?.({
      InputProps: {},
      inputProps: {
        value:
          value != null && !Array.isArray(value) && getOptionLabel ? getOptionLabel(value) : '',
      },
    } as never);
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
    if (typeof label === 'string') autocompleteOptionsByLabel.set(label, options ?? []);
    return (
      <div data-testid="autocomplete" data-value={JSON.stringify(value)}>
        {Array.isArray(value) ? value.map((v) => <span key={String(v)}>{String(v)}</span>) : null}
        {input ?? null}
        {renderOption
          ? (options ?? []).map((option, index) => renderOption({ key: String(index) }, option))
          : null}
      </div>
    );
  },
}));

import { ManageMessageDrawer, type ManageMessageEditorHandle } from '../ManageMessageDrawer';

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
describe('ManageMessageDrawer edit mode', () => {
  it.each(['message-create', 'message-edit', 'report-create', 'report-edit'])(
    '#3598 hides the network field and its option requests in %s while retaining frequency',
    async (mode) => {
      directSubmitMocks.copyDirectSubmit.mockResolvedValue({ payloads: [] });
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      const message = buildMessage({ networkIds: [7], networkName: 'Мережа джерела' });

      await act(async () => {
        root.render(
          <ManageMessageDrawer
            open
            hideNetworks
            cyberEchoEnabled={false}
            currentUser={{ roles: ['Rer'] } as User}
            onClose={vi.fn()}
            editTarget={mode.endsWith('edit') ? { id: 42, message } : null}
            editAsReport={mode === 'report-edit'}
            reportSource={mode === 'report-create' ? { id: 42, message } : null}
          />,
        );
      });

      expect(container.querySelector('[aria-label="Мережа"]')).toBeNull();
      expect(container.querySelector('[aria-label="Частота (МГц)"]')).not.toBeNull();
      expect(container.textContent).not.toContain('Мережа та радіо');
      expect(networkMocks.getNetworksByIds).not.toHaveBeenCalled();
      expect(directSubmitMocks.searchNetworkNames).not.toHaveBeenCalled();
      root.unmount();
    },
  );

  it('#3598 preserves an existing network when saving an unrelated hidden edit', async () => {
    const message = buildMessage({ networkIds: [7], networkName: 'Existing network' });
    networkMocks.getNetworksByIds.mockResolvedValue([
      { id: 7, name: 'Existing network', unitIds: [], freqs: [] },
    ]);
    directSubmitMocks.editDirectSubmit.mockResolvedValue({ signal_message_id: 42 });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <ManageMessageDrawer
          open
          hideNetworks
          cyberEchoEnabled={false}
          currentUser={{ roles: ['Rer'] } as User}
          onClose={vi.fn()}
          editTarget={{ id: 42, message }}
        />,
      );
    });
    await act(async () => {
      autocompleteOnChangeByLabel.get('Частота (МГц)')?.(null, '150.000');
      container
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(directSubmitMocks.editDirectSubmit).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ network: expect.objectContaining({ name: 'Existing network' }) }),
    );
    expect(networkMocks.getNetworksByIds).not.toHaveBeenCalled();
    expect(directSubmitMocks.searchNetworkNames).not.toHaveBeenCalled();
    expect(container.querySelector('[aria-label="Мережа"]')).toBeNull();
    root.unmount();
  });

  it('#3598 skips free-form network hydration for hidden report sources after copy', async () => {
    directSubmitMocks.copyDirectSubmit.mockResolvedValue({ payloads: [{}] });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <ManageMessageDrawer
          open
          hideNetworks
          cyberEchoEnabled={false}
          currentUser={{ roles: ['Rer'] } as User}
          onClose={vi.fn()}
          reportSource={{
            id: 42,
            message: buildMessage({ networkIds: null, networkName: 'Вільна мережа' }),
          }}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(directSubmitMocks.copyDirectSubmit).toHaveBeenCalled();
    expect(networkMocks.getNetworksByIds).not.toHaveBeenCalled();
    expect(directSubmitMocks.searchNetworkNames).not.toHaveBeenCalled();
    root.unmount();
  });

  it('#3598 hydrates the current source after networks become visible', async () => {
    networkMocks.getNetworksByIds.mockResolvedValue([
      { id: 7, name: 'Видима мережа', unitIds: [], freqs: [] },
    ]);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const render = (hideNetworks: boolean) =>
      root.render(
        <ManageMessageDrawer
          open
          hideNetworks={hideNetworks}
          cyberEchoEnabled={false}
          currentUser={{ roles: ['Rer'] } as User}
          onClose={vi.fn()}
          editTarget={{ id: 42, message: buildMessage({ networkIds: [7] }) }}
        />,
      );

    await act(async () => {
      render(true);
    });
    expect(networkMocks.getNetworksByIds).not.toHaveBeenCalled();

    await act(async () => {
      render(false);
      await Promise.resolve();
    });
    expect(networkMocks.getNetworksByIds).toHaveBeenCalledWith([7]);
    expect(autocompleteValuesByLabel.get('Мережа')).toMatchObject({ id: 7 });
    root.unmount();
  });

  it('#3598 ignores pending network hydration after networks become hidden', async () => {
    directSubmitMocks.editDirectSubmit.mockResolvedValue({ signal_message_id: 42 });
    let resolveNetworks!: (networks: unknown[]) => void;
    networkMocks.getNetworksByIds.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveNetworks = resolve;
        }),
    );
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const render = (hideNetworks: boolean) =>
      root.render(
        <ManageMessageDrawer
          open
          hideNetworks={hideNetworks}
          cyberEchoEnabled={false}
          currentUser={{ roles: ['Rer'] } as User}
          onClose={vi.fn()}
          editTarget={{
            id: 42,
            message: buildMessage({ networkIds: [7], networkName: 'Початкова мережа' }),
          }}
        />,
      );

    await act(async () => {
      render(false);
    });
    expect(networkMocks.getNetworksByIds).toHaveBeenCalledWith([7]);
    await act(async () => {
      render(true);
    });
    await act(async () => {
      resolveNetworks([{ id: 7, name: 'Запізніла мережа', unitIds: [], freqs: [] }]);
    });
    expect(autocompleteValuesByLabel.get('Мережа')).not.toMatchObject({ id: 7 });
    await act(async () => {
      container
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(directSubmitMocks.editDirectSubmit).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ network: expect.objectContaining({ name: 'Початкова мережа' }) }),
    );
    root.unmount();
  });

  afterEach(() => {
    textFieldPropsByLabel.clear();
    autocompleteOnChangeByLabel.clear();
    autocompleteOnInputChangeByLabel.clear();
    autocompleteValuesByLabel.clear();
    autocompleteInputValuesByLabel.clear();
    autocompleteOptionLabelsByLabel.clear();
    autocompleteOptionsByLabel.clear();
    pickerValuesByLabel.clear();
    timePickerOnChange.clear();
    drawerModalProps = undefined;
    drawerOnClose = undefined;
    directSubmitMocks.submitDirect.mockReset();
    directSubmitMocks.submitDirect.mockResolvedValue({ signal_message_id: 1 });
    directSubmitMocks.editDirectSubmit.mockReset();
    directSubmitMocks.copyDirectSubmit.mockReset();
    directSubmitMocks.createDeviceName.mockReset();
    directSubmitMocks.createDeviceName.mockResolvedValue({ id: 1 });
    directSubmitMocks.parseDirectSubmit.mockReset();
    directSubmitMocks.searchFreqs.mockClear();
    directSubmitMocks.searchPostNames.mockClear();
    directSubmitMocks.searchUnitNames.mockReset();
    directSubmitMocks.searchUnitNames.mockResolvedValue([]);
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
    dutySettingsMocks.messageAutoParseEnabled = false;
    dutySettingsMocks.loadInProgress = false;
    dutySettingsMocks.loadError = null;
    dutySettingsMocks.saveInProgress = false;
    dutySettingsMocks.saveError = null;
    dutySettingsMocks.unstableSetter = false;
    dutySettingsMocks.setMessageAutoParseEnabled.mockReset();
    dutySettingsMocks.scheduleSave.mockReset();
    dutySettingsMocks.retryLoad.mockReset();
    document.body.innerHTML = '';
    referenceDataMocks.getTagsForDisplay.mockResolvedValue({ tagsMap: {}, tagsOrder: [] });
    referenceDataMocks.getUserSigintGroups.mockReset();
    referenceDataMocks.getGroupInfosBatch.mockReset();
    referenceDataMocks.getUserSigintGroups.mockResolvedValue([]);
    referenceDataMocks.getGroupInfosBatch.mockResolvedValue([]);
    setRecentValues({});
    uppyMocks.latest = null;
  });

  it('closes the message editor when browser Back restores the pre-editor history state', async () => {
    const preEditorState = { screen: 'duty' };
    window.history.replaceState(preEditorState, '', '/rer-duty-neo');
    const onClose = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <ManageMessageDrawer
          open
          cyberEchoEnabled={false}
          currentUser={{ roles: ['Rer'] } as User}
          onClose={onClose}
        />,
      );
    });
    await act(async () => {
      window.dispatchEvent(new PopStateEvent('popstate', { state: preEditorState }));
    });

    expect(onClose).toHaveBeenCalledOnce();
    root.unmount();
  });

  it('keeps the message editor open when browser Back is requested while saving', async () => {
    const preEditorState = { screen: 'duty' };
    window.history.replaceState(preEditorState, '', '/rer-duty-neo');
    const onClose = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <ManageMessageDrawer
          open
          cyberEchoEnabled={false}
          currentUser={{ roles: ['Rer'] } as User}
          onClose={onClose}
          editTarget={{ id: 42, message: buildMessage() }}
          editSaveInFlight
          onSubmitEdit={vi.fn()}
        />,
      );
    });
    await act(async () => {
      window.dispatchEvent(new PopStateEvent('popstate', { state: preEditorState }));
    });

    expect(onClose).not.toHaveBeenCalled();
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.documentElement.classList.contains('echo-browser-back-overlay-open')).toBe(
      true,
    );
    root.unmount();
  });

  it('blocks a page unload while the editor has unsaved changes', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <ManageMessageDrawer
          open
          cyberEchoEnabled={false}
          currentUser={{ roles: ['Rer'] } as User}
          onClose={vi.fn()}
        />,
      );
    });
    await act(async () => {
      textFieldPropsByLabel
        .get('Текст повідомлення')
        ?.onChange?.({ target: { value: 'Незбережена чернетка' } });
    });

    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);

    root.unmount();
  });

  it('shows an inert report-edit loading shell without a header close action', async () => {
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
          currentUser={{ roles: ['Rer'] } as User}
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

    expect(container.querySelector('button[aria-label="Закрити"]')).toBeNull();

    const close = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Закрити',
    );
    expect(close).toBeDefined();
    act(() => close?.click());
    expect(onClose).toHaveBeenCalledOnce();

    act(() => drawerOnClose?.({}, 'escapeKeyDown'));
    expect(onClose).toHaveBeenCalledTimes(2);

    root.unmount();
  });

  it('asks before discarding changed form values and keeps editing when cancelled', async () => {
    const onClose = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <ManageMessageDrawer
          open
          cyberEchoEnabled={false}
          currentUser={{ roles: ['Rer'] } as User}
          onClose={onClose}
        />,
      );
      await Promise.resolve();
    });
    await act(async () => {
      textFieldPropsByLabel
        .get('Текст повідомлення')
        ?.onChange?.({ target: { value: 'новий текст' } });
      await Promise.resolve();
    });

    const close = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Закрити',
    );
    act(() => close?.click());

    expect(onClose).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alertdialog"]')?.textContent).toContain(
      'Відхилити незбережені зміни?',
    );

    const continueEditing = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Продовжити редагування',
    );
    act(() => continueEditing?.click());

    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(textFieldPropsByLabel.get('Текст повідомлення')?.value).toBe('новий текст');
    expect(onClose).not.toHaveBeenCalled();

    root.unmount();
  });

  it('asks before discarding an added attachment from the backdrop', async () => {
    const onClose = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <ManageMessageDrawer
          open
          cyberEchoEnabled={false}
          currentUser={{ roles: ['Rer'] } as User}
          onClose={onClose}
        />,
      );
      await Promise.resolve();
    });
    await act(async () => {
      uppyMocks.latest?.addFile({ name: 'evidence.jpg', data: new Blob(['evidence']) });
      await Promise.resolve();
    });

    act(() => drawerOnClose?.({}, 'backdropClick'));
    expect(onClose).not.toHaveBeenCalled();

    const discard = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Відхилити зміни',
    );
    act(() => discard?.click());
    expect(onClose).toHaveBeenCalledOnce();

    root.unmount();
  });

  it('asks before closing a changed form through browser Back', async () => {
    const preEditorState = { screen: 'duty' };
    window.history.replaceState(preEditorState, '', '/rer-duty-neo');
    const onClose = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <ManageMessageDrawer
          open
          cyberEchoEnabled={false}
          currentUser={{ roles: ['Rer'] } as User}
          onClose={onClose}
        />,
      );
      await Promise.resolve();
    });
    await act(async () => {
      textFieldPropsByLabel
        .get('Текст повідомлення')
        ?.onChange?.({ target: { value: 'новий текст' } });
      await Promise.resolve();
    });
    await act(async () => {
      window.dispatchEvent(new PopStateEvent('popstate', { state: preEditorState }));
      await Promise.resolve();
    });

    expect(onClose).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(document.documentElement.classList.contains('echo-browser-back-overlay-open')).toBe(
      true,
    );

    root.unmount();
  });

  it('keeps the current dirty intent until replacement is discarded', async () => {
    const editorRef = createRef<ManageMessageEditorHandle>();
    const replace = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <ManageMessageDrawer
          ref={editorRef}
          open
          intentKey="edit-message:10"
          presentation="embedded"
          cyberEchoEnabled={false}
          currentUser={{ roles: ['Rer'] } as User}
          onClose={vi.fn()}
          editTarget={{ id: 10, message: buildMessage() }}
        />,
      );
      await Promise.resolve();
    });
    await act(async () => {
      textFieldPropsByLabel
        .get('Текст повідомлення')
        ?.onChange?.({ target: { value: 'dirty replacement' } });
      await Promise.resolve();
    });

    act(() => {
      editorRef.current?.requestIntentChange({ key: 'edit-message:20', commit: replace });
    });
    expect(replace).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alertdialog"]')?.textContent).toContain(
      'Відхилити незбережені зміни?',
    );

    const discard = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Відхилити зміни',
    );
    act(() => discard?.click());
    expect(replace).toHaveBeenCalledOnce();

    root.unmount();
  });

  it('keeps the same draft while presentation crosses the responsive breakpoint', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const render = (presentation: 'embedded' | 'modal') =>
      root.render(
        <ManageMessageDrawer
          open
          intentKey="create-message"
          presentation={presentation}
          cyberEchoEnabled={false}
          currentUser={{ roles: ['Rer'] } as User}
          onClose={vi.fn()}
        />,
      );

    await act(async () => {
      render('embedded');
      await Promise.resolve();
    });
    await act(async () => {
      textFieldPropsByLabel
        .get('Текст повідомлення')
        ?.onChange?.({ target: { value: 'responsive draft' } });
      await Promise.resolve();
    });
    await act(async () => {
      render('modal');
      await Promise.resolve();
    });

    expect(textFieldPropsByLabel.get('Текст повідомлення')?.value).toBe('responsive draft');
    expect(container.querySelector('[data-manage-message-presentation="modal"]')).not.toBeNull();
    root.unmount();
  });

  it('uses the measured Analysis editor width to select the compact form layout', async () => {
    setRecentValues({});
    const boundingRectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect');
    boundingRectSpy.mockReturnValue({
      bottom: 0,
      height: 800,
      left: 0,
      right: 720,
      top: 0,
      width: 720,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          <ManageMessageDrawer
            open
            intentKey="create-message"
            presentation="embedded"
            adaptiveEmbeddedForm
            cyberEchoEnabled={false}
            currentUser={{ roles: ['Rer'] } as User}
            onClose={vi.fn()}
          />,
        );
        await Promise.resolve();
      });

      expect(
        container
          .querySelector('#create-message-form')
          ?.getAttribute('data-manage-message-form-layout'),
      ).toBe('compact');
    } finally {
      act(() => root.unmount());
      boundingRectSpy.mockRestore();
    }
  });

  it('does not capture a file paste from a feed filter', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <>
          <input aria-label="Фільтр стрічки" />
          <ManageMessageDrawer
            open
            intentKey="create-message"
            presentation="embedded"
            cyberEchoEnabled={false}
            currentUser={{ roles: ['Rer'] } as User}
            onClose={vi.fn()}
          />
        </>,
      );
      await Promise.resolve();
    });
    const filter = container.querySelector('[aria-label="Фільтр стрічки"]') as HTMLInputElement;
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', {
      value: {
        items: [
          {
            kind: 'file',
            getAsFile: () => new File(['image'], 'outside.png', { type: 'image/png' }),
          },
        ],
      },
    });
    await act(async () => {
      filter.focus();
      filter.dispatchEvent(paste);
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Вкладення (0)');
    expect(paste.defaultPrevented).toBe(false);
    root.unmount();
  });

  it('keeps an active parse but disables paste while editor interaction is inactive', async () => {
    let resolveParse!: (value: unknown) => void;
    directSubmitMocks.parseDirectSubmit.mockReturnValue(
      new Promise((resolve) => {
        resolveParse = resolve;
      }),
    );
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const render = (interactionActive: boolean) =>
      root.render(
        <ManageMessageDrawer
          open
          intentKey="create-message"
          presentation="embedded"
          interactionActive={interactionActive}
          cyberEchoEnabled={false}
          currentUser={{ roles: ['Rer'] } as User}
          onClose={vi.fn()}
        />,
      );

    await act(async () => {
      render(true);
      await Promise.resolve();
    });
    await act(async () => {
      textFieldPropsByLabel
        .get('Текст повідомлення')
        ?.onChange?.({ target: { value: 'frequency 149.500' } });
    });
    const parseButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Розпарсити'),
    );
    await act(async () => {
      parseButton?.click();
      await Promise.resolve();
      render(false);
      await Promise.resolve();
    });

    await act(async () => {
      resolveParse({ text: 'parsed', freq: '149.500', coords: [], to: [], locations: [] });
      await Promise.resolve();
    });
    expect(autocompleteValuesByLabel.get('Частота (МГц)')).toBe('149.500');

    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', {
      value: {
        items: [
          {
            kind: 'file',
            getAsFile: () => new File(['image'], 'hidden.png', { type: 'image/png' }),
          },
        ],
      },
    });
    await act(async () => {
      window.dispatchEvent(paste);
      await Promise.resolve();
    });
    expect(container.textContent).toContain('Вкладення (0)');
    expect(paste.defaultPrevented).toBe(false);
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
          currentUser={{ roles: ['Rer'] } as User}
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

  it('shows a retry action when copying a report source fails', async () => {
    directSubmitMocks.copyDirectSubmit
      .mockRejectedValueOnce(new Error('copy failed'))
      .mockResolvedValueOnce({
        payloads: [{ full_body: 'copied after retry', parent_signal_message_ids: [42] }],
      });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <ManageMessageDrawer
          open
          cyberEchoEnabled={false}
          currentUser={{ roles: ['Rer'] } as User}
          onClose={vi.fn()}
          reportSource={{ id: 42, message: buildMessage({ text: 'source card body' }) }}
        />,
      );
      await Promise.resolve();
    });

    expect(container.textContent).toContain('copy failed');
    const retry = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Повторити копіювання',
    );
    expect(retry).toBeDefined();

    await act(async () => {
      retry?.click();
      await Promise.resolve();
    });

    expect(directSubmitMocks.copyDirectSubmit).toHaveBeenCalledTimes(2);
    expect(textFieldPropsByLabel.get('Текст оригінального повідомлення')?.value).toBe(
      'copied after retry',
    );
    expect(container.textContent).not.toContain('copy failed');
    root.unmount();
  });

  it('wraps report source metadata instead of hiding it behind horizontal scrolling', async () => {
    directSubmitMocks.copyDirectSubmit.mockResolvedValue({
      payloads: [{ full_body: 'copied source', parent_signal_message_ids: [42] }],
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <ManageMessageDrawer
          open
          cyberEchoEnabled={false}
          currentUser={{ roles: ['Rer'] } as User}
          onClose={vi.fn()}
          reportSource={{ id: 42, message: buildMessage() }}
        />,
      );
      await Promise.resolve();
    });

    const header = container.querySelector<HTMLElement>('[data-testid="report-source-header"]');
    const metadata = header?.querySelector<HTMLElement>('.report-source-metadata');
    const metadataItems = metadata?.querySelector<HTMLElement>(':scope > div > div');
    expect(header).not.toBeNull();
    expect(getComputedStyle(header!).flexWrap).toBe('wrap');
    expect(getComputedStyle(header!).overflowX).not.toBe('auto');
    expect(getComputedStyle(metadata!).whiteSpace).not.toBe('nowrap');
    expect(getComputedStyle(metadata!).flexShrink).not.toBe('0');
    expect(getComputedStyle(metadataItems!).flexWrap).toBe('wrap');
    expect(metadata?.querySelector('.message-card-text--nowrap')).toBeNull();
    root.unmount();
  });

  it('shows a retry action when reference data fails to load', async () => {
    referenceDataMocks.getUserSigintGroups
      .mockRejectedValueOnce(new Error('groups failed'))
      .mockResolvedValueOnce([]);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <ManageMessageDrawer
          open
          cyberEchoEnabled={false}
          currentUser={{ roles: ['Rer'] } as User}
          onClose={vi.fn()}
        />,
      );
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Не вдалося завантажити довідкові дані.');
    const retry = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Повторити завантаження',
    );
    expect(retry).toBeDefined();

    await act(async () => {
      retry?.click();
      await Promise.resolve();
    });
    expect(referenceDataMocks.getUserSigintGroups).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain('Не вдалося завантажити довідкові дані.');
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
          currentUser={{ roles: ['Rer'] } as User}
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
          currentUser={{ roles: ['Rer'] } as User}
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
          currentUser={{ roles: ['Rer'] } as User}
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
          currentUser={{ roles: ['Rer'] } as User}
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
          currentUser={{ roles: ['Rer'] } as User}
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
          currentUser={{ roles: ['Rer'] } as User}
          onClose={vi.fn()}
          reportSource={{ id: 42, message: buildMessage() }}
        />,
      );
    });
    expect(requestSignal?.aborted).toBe(true);

    root.unmount();
  });

  it('closes an embedded report composer after submission while a suggestion is pending', async () => {
    directSubmitMocks.copyDirectSubmit.mockResolvedValue({
      payloads: [{ full_body: 'copied source', parent_signal_message_ids: [42] }],
    });
    aiIntelReportMocks.quickIntelReportSuggestion.mockReturnValue(new Promise(() => {}));
    const onClose = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <ManageMessageDrawer
          open
          presentation="embedded"
          cyberEchoEnabled={false}
          currentUser={{ roles: ['Rer'] } as User}
          onClose={onClose}
          reportSource={{ id: 42, message: buildMessage() }}
        />,
      );
      await Promise.resolve();
    });
    await act(async () => {
      textFieldPropsByLabel
        .get('Текст розвіддонесення')
        ?.onChange?.({ target: { value: 'Готовий текст оператора' } });
      const noSendOption = autocompleteOptionsByLabel
        .get('Відправити в групу')
        ?.find((option) => (option as { name?: string }).name === 'Не відправляти');
      autocompleteOnChangeByLabel.get('Відправити в групу')?.(null, noSendOption);
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
    expect(onClose).toHaveBeenCalledTimes(1);

    root.unmount();
  });

  it('requires an explicit report destination and submits the no-send option as null', async () => {
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
          currentUser={{ roles: ['Rer'] } as User}
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
    expect(autocompleteValuesByLabel.get('Назва пристрою')).toBe('source-device');
    expect(autocompleteValuesByLabel.get('Позивні')).toEqual(['ALFA', 'СОКІЛ']);
    await act(async () => {
      autocompleteOnInputChangeByLabel.get('Позивні')?.(null, 'charlie', 'input');
    });
    expect(autocompleteInputValuesByLabel.get('Позивні')).toBe('CHARLIE');
    expect(autocompleteValuesByLabel.get('Відправити в групу')).toBeNull();
    expect(autocompleteOptionLabelsByLabel.get('Відправити в групу')).toEqual([
      'Не відправляти',
      'Group 1',
    ]);
    const groupInput = container.querySelector(
      'input[aria-label="Відправити в групу"]',
    ) as HTMLInputElement;
    expect(groupInput.required).toBe(true);
    expect(
      Array.from(container.querySelectorAll('li')).find(
        (option) => option.textContent === 'Не відправляти',
      )?.style.color,
    ).toBe('rgba(0, 0, 0, 0.6)');
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
    expect(drawerSlotProps?.paper?.style?.width).toBe('100vw');
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
      await Promise.resolve();
    });
    expect((container.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(
      false,
    );
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(directSubmitMocks.submitDirect).not.toHaveBeenCalled();
    expect(textFieldPropsByLabel.get('Відправити в групу')).toMatchObject({
      error: true,
      helperText: 'Оберіть групу',
    });

    const noSendOption = autocompleteOptionsByLabel
      .get('Відправити в групу')
      ?.find((option) => (option as { name?: string }).name === 'Не відправляти');
    expect(noSendOption).toBeDefined();
    await act(async () => {
      autocompleteOnChangeByLabel.get('Відправити в групу')?.(null, noSendOption);
      await Promise.resolve();
    });
    expect(groupInput.value).toBe('Не відправляти');
    expect(groupInput.style.color).toBe('');

    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(directSubmitMocks.submitDirect).toHaveBeenCalledWith(
      expect.objectContaining({
        full_body: 'new report body',
        signal_group_master_key: null,
        retained_media_ids: ['media-1'],
        attachment_updates: undefined,
        parent_signal_message_ids: [42],
        comment: undefined,
      }),
    );

    root.unmount();
  });

  it('#3595 uploads a report-source edit as new and excludes the original attachment', async () => {
    directSubmitMocks.copyDirectSubmit.mockResolvedValue({
      payloads: [
        {
          full_body: 'original body',
          retained_media_ids: ['source-image'],
          parent_signal_message_ids: [42],
        },
      ],
    });
    const source = buildMessage({
      media: [
        {
          id: 'source-image',
          contentType: 'image/png',
          fileName: 'source.png',
          sizeBytes: 11,
          href: '/media/source-image',
          transcription: null,
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
          currentUser={{ roles: ['Rer'] } as User}
          onClose={vi.fn()}
          reportSource={{ id: 42, message: source }}
        />,
      );
    });
    await act(async () => {
      container
        .querySelector('button[aria-label="Більше дій для source.png"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      Array.from(container.querySelectorAll('button[role="menuitem"]'))
        .find((button) => button.textContent === 'Перейменувати')
        ?.click();
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    });
    await act(async () => {
      textFieldPropsByLabel.get('Назва файлу')?.onChange?.({ target: { value: 'renamed-source' } });
      Array.from(container.querySelectorAll('button'))
        .filter((button) => button.textContent === 'Перейменувати')
        .at(-1)
        ?.click();
      await Promise.resolve();
    });
    await act(async () => {
      uppyMocks.latest?.addFile({
        name: 'source-edited.png',
        type: 'image/png',
        size: 11,
        data: new File(['replacement'], 'source-edited.png', { type: 'image/png' }),
        meta: { replaces_media_id: 'source-image' },
        uploadURL: '/upload/report-image',
      });
      textFieldPropsByLabel
        .get('Текст розвіддонесення')
        ?.onChange?.({ target: { value: 'report body' } });
      const noSendOption = autocompleteOptionsByLabel
        .get('Відправити в групу')
        ?.find((option) => (option as { name?: string }).name === 'Не відправляти');
      autocompleteOnChangeByLabel.get('Відправити в групу')?.(null, noSendOption);
      await Promise.resolve();
    });
    await act(async () => {
      container
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(directSubmitMocks.submitDirect).toHaveBeenCalledWith(
      expect.objectContaining({
        upload_urls: ['/upload/report-image'],
        attachment_updates: undefined,
        retained_media_ids: [],
        parent_signal_message_ids: [42],
      }),
    );
    root.unmount();
  });

  it.each([false, true])(
    '#3891 preserved copied and manually changed metadata when report text was cleared (autoParse=%s)',
    async (autoParse) => {
      setRecentValues({ deviceName: ['remembered-device'], unit: ['remembered-unit'] });
      dutySettingsMocks.messageAutoParseEnabled = autoParse;
      directSubmitMocks.copyDirectSubmit.mockResolvedValue({
        payloads: [
          {
            full_body: '20.10.2026, 09:46 original',
            timestamp: '2026-10-20T06:46:00Z',
            unit: '51 пдп',
            unit_id: 51,
            freq: '149.500',
            post: 'source-post',
          },
        ],
      });
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      try {
        await act(async () => {
          root.render(
            <ManageMessageDrawer
              open
              cyberEchoEnabled
              currentUser={{ roles: ['Rer'] } as User}
              onClose={vi.fn()}
              reportSource={{
                id: 42,
                message: buildMessage({
                  date: '2026-10-20',
                  time: '09:46',
                  deviceName: 'source-device',
                }),
              }}
            />,
          );
        });
        const snapshot = () => ({
          date: (pickerValuesByLabel.get('Дата перехоплення') as dayjs.Dayjs)?.format('YYYY-MM-DD'),
          time:
            (pickerValuesByLabel.get('Час перехоплення') as dayjs.Dayjs)?.format('HH:mm') ?? null,
          unit: autocompleteValuesByLabel.get('Підрозділ'),
          device: autocompleteValuesByLabel.get('Назва пристрою'),
        });
        expect(
          container.querySelector('[data-testid="report-source-header"]')?.textContent,
        ).toContain('09:46');
        expect(snapshot().time).toBe('09:46');
        await act(async () => {
          timePickerOnChange.get('Час перехоплення')?.(dayjs('2026-10-20T07:12:00'));
        });
        await act(async () => {
          textFieldPropsByLabel
            .get('Текст розвіддонесення')
            ?.onChange?.({ target: { value: 'manual report' } });
        });
        expect(snapshot().time).toBe('07:12');
        await act(async () => {
          textFieldPropsByLabel.get('Текст розвіддонесення')?.onChange?.({ target: { value: '' } });
        });
        expect(snapshot().date).toBe('2026-10-20');
        expect(snapshot().time).toBe('07:12');
        expect(snapshot().device).toBe('source-device');
        expect(snapshot().unit).toMatchObject({ id: 51, name: '51 пдп' });
        expect(directSubmitMocks.parseDirectSubmit).not.toHaveBeenCalled();
      } finally {
        await act(async () => root.unmount());
      }
    },
  );

  it.each([
    [0, '51 пдп'],
    [1, '51 пдп'],
    [2, '51 пдп'],
    [0, ' 51 пдп '],
  ] as const)(
    '#3891/#3935 submitted an inherited unit without an ID (matches=%i, label=%j)',
    async (count, unit) => {
      vi.useFakeTimers();
      setRecentValues({});
      directSubmitMocks.copyDirectSubmit.mockResolvedValue({
        payloads: [{ unit, timestamp: '2026-10-20T06:46:00Z' }],
      });
      directSubmitMocks.searchUnitNames.mockResolvedValue(
        Array.from({ length: count }, (_, index) => ({ id: index + 1, name: '51 пдп' })),
      );
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      try {
        await act(async () => {
          root.render(
            <ManageMessageDrawer
              open
              cyberEchoEnabled={false}
              currentUser={{ roles: ['Rer'] } as User}
              onClose={vi.fn()}
              reportSource={{ id: 42, message: buildMessage({ unit }) }}
            />,
          );
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(350);
        });
        expect(textFieldPropsByLabel.get('Підрозділ')?.error).toBe(false);
        expect(autocompleteValuesByLabel.get('Підрозділ')).toBe(unit);
        await act(async () => {
          textFieldPropsByLabel
            .get('Текст розвіддонесення')
            ?.onChange?.({ target: { value: 'report' } });
          const destination = autocompleteOptionsByLabel
            .get('Відправити в групу')
            ?.find((option) => (option as { name?: string }).name === 'Не відправляти');
          autocompleteOnChangeByLabel.get('Відправити в групу')?.(null, destination);
        });
        await act(async () => {
          container
            .querySelector('form')!
            .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        });
        expect(directSubmitMocks.submitDirect).toHaveBeenCalledWith(
          expect.objectContaining({
            unit,
            unit_id: undefined,
            create_unit: undefined,
            copy_source_signal_message_ids: [42],
          }),
        );
      } finally {
        await act(async () => root.unmount());
        vi.useRealTimers();
      }
    },
  );

  it.each(['Перший, Другий', ''])(
    '#3891 preserved copied unit %j independently of current network assignments',
    async (unit) => {
      setRecentValues({ unit: ['Remembered unit'] });
      directSubmitMocks.copyDirectSubmit.mockResolvedValue({
        payloads: [{ unit, network: { name: 'Мережа' } }],
      });
      networkMocks.getNetworksByIds.mockResolvedValue([
        { id: 7, name: 'Renamed network', unitIds: [51, 52], freqs: [] },
      ]);
      unitMocks.getUnitsByIds.mockResolvedValue([{ id: 51, name: 'Changed unit' }]);
      const onClose = vi.fn();
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      try {
        await act(async () => {
          root.render(
            <ManageMessageDrawer
              open
              cyberEchoEnabled
              currentUser={{ roles: ['Rer'] } as User}
              onClose={onClose}
              reportSource={{
                id: 42,
                message: buildMessage({
                  unit: unit || null,
                  networkIds: [7],
                  networkName: 'Мережа',
                }),
              }}
            />,
          );
        });
        expect(autocompleteValuesByLabel.get('Підрозділ')).toBe(unit);
        expect(textFieldPropsByLabel.get('Підрозділ')?.disabled).toBe(false);
        expect(autocompleteValuesByLabel.get('Мережа')).toBe('Мережа');
        await act(async () => {
          textFieldPropsByLabel
            .get('Текст розвіддонесення')
            ?.onChange?.({ target: { value: 'Чернетка' } });
        });
        await act(async () => {
          textFieldPropsByLabel.get('Текст розвіддонесення')?.onChange?.({ target: { value: '' } });
        });
        expect(autocompleteValuesByLabel.get('Підрозділ')).toBe(unit);
        expect(networkMocks.getNetworksByIds).not.toHaveBeenCalled();
        expect(unitMocks.getUnitsByIds).not.toHaveBeenCalled();
        await act(async () => {
          Array.from(container.querySelectorAll('button'))
            .find((button) => button.textContent === 'Закрити')
            ?.click();
        });
        expect(onClose).toHaveBeenCalledOnce();
      } finally {
        await act(async () => root.unmount());
      }
    },
  );

  it('#3891 required an explicit selection after manually changing an inherited unit', async () => {
    setRecentValues({});
    directSubmitMocks.copyDirectSubmit.mockResolvedValue({
      payloads: [{ unit: 'Старий підрозділ' }],
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <ManageMessageDrawer
            open
            cyberEchoEnabled={false}
            currentUser={{ roles: ['Rer'] } as User}
            onClose={vi.fn()}
            reportSource={{ id: 42, message: buildMessage({ unit: 'Старий підрозділ' }) }}
          />,
        );
      });
      await act(async () => {
        autocompleteOnInputChangeByLabel.get('Підрозділ')?.(null, 'Ручний підрозділ', 'input');
        textFieldPropsByLabel
          .get('Текст розвіддонесення')
          ?.onChange?.({ target: { value: 'report' } });
        const destination = autocompleteOptionsByLabel
          .get('Відправити в групу')
          ?.find((option) => (option as { name?: string }).name === 'Не відправляти');
        autocompleteOnChangeByLabel.get('Відправити в групу')?.(null, destination);
      });
      expect(textFieldPropsByLabel.get('Підрозділ')?.helperText).toBe('Підрозділ не обрано');
      await act(async () => {
        container
          .querySelector('form')!
          .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
      expect(directSubmitMocks.submitDirect).not.toHaveBeenCalled();
      await act(async () => {
        autocompleteOnChangeByLabel.get('Підрозділ')?.(null, { id: 99, name: 'Ручний підрозділ' });
      });
      await act(async () => {
        container
          .querySelector('form')!
          .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
      expect(directSubmitMocks.submitDirect).toHaveBeenCalledWith(
        expect.objectContaining({ unit: 'Ручний підрозділ', unit_id: 99 }),
      );
    } finally {
      await act(async () => root.unmount());
    }
  });

  it('#3891 updated report units only after manually selecting a network', async () => {
    setRecentValues({});
    directSubmitMocks.copyDirectSubmit.mockResolvedValue({
      payloads: [{ unit: 'Старий підрозділ', network: { name: 'Мережа' } }],
    });
    let resolveUnits!: (units: unknown[]) => void;
    unitMocks.getUnitsByIds.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveUnits = resolve;
        }),
    );
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <ManageMessageDrawer
            open
            cyberEchoEnabled
            currentUser={{ roles: ['Rer'] } as User}
            onClose={vi.fn()}
            reportSource={{
              id: 42,
              message: buildMessage({ networkIds: [7], networkName: 'Мережа' }),
            }}
          />,
        );
      });
      expect(autocompleteValuesByLabel.get('Підрозділ')).toBe('Старий підрозділ');
      await act(async () => {
        autocompleteOnChangeByLabel.get('Мережа')?.(null, {
          id: 8,
          name: 'Мережа',
          unit_ids: [51, 52],
          freqs: [],
        });
      });
      await act(async () => {
        resolveUnits([
          { id: 51, name: 'Перший' },
          { id: 52, name: 'Другий' },
        ]);
      });
      expect(autocompleteValuesByLabel.get('Підрозділ')).toBe('Перший, Другий');
      expect(textFieldPropsByLabel.get('Підрозділ')?.disabled).toBe(true);
      await act(async () => {
        textFieldPropsByLabel
          .get('Текст розвіддонесення')
          ?.onChange?.({ target: { value: 'report' } });
        const destination = autocompleteOptionsByLabel
          .get('Відправити в групу')
          ?.find((option) => (option as { name?: string }).name === 'Не відправляти');
        autocompleteOnChangeByLabel.get('Відправити в групу')?.(null, destination);
      });
      await act(async () => {
        container
          .querySelector('form')!
          .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
      expect(directSubmitMocks.submitDirect).toHaveBeenCalledWith(
        expect.objectContaining({ unit: 'Перший, Другий', unit_id: undefined }),
      );
    } finally {
      await act(async () => root.unmount());
    }
  });

  it('#3891 preserved metadata when editing an existing report and clearing its text', async () => {
    setRecentValues({ unit: ['Remembered unit'] });
    const existing = buildMessage({
      text: 'Existing report',
      unit: 'Original unit',
      unitDisplay: 'Renamed catalog unit, Inferred network unit',
      networkIds: [7],
      networkName: 'Original network',
      date: '2026-10-20',
      time: '09:46',
    });
    networkMocks.getNetworksByIds.mockResolvedValue([
      { id: 7, name: 'Renamed network', unitIds: [51], freqs: [] },
    ]);
    unitMocks.getUnitsByIds.mockResolvedValue([{ id: 51, name: 'Changed unit' }]);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <ManageMessageDrawer
            open
            cyberEchoEnabled={false}
            currentUser={{ roles: ['Rer'] } as User}
            onClose={vi.fn()}
            editTarget={{ id: 91, message: existing }}
            editAsReport
          />,
        );
      });
      expect(autocompleteValuesByLabel.get('Підрозділ')).toBe('Original unit');
      expect(autocompleteValuesByLabel.get('Мережа')).toBe('Original network');
      await act(async () => {
        textFieldPropsByLabel.get('Текст розвіддонесення')?.onChange?.({ target: { value: '' } });
      });
      expect(autocompleteValuesByLabel.get('Підрозділ')).toBe('Original unit');
      expect((pickerValuesByLabel.get('Час перехоплення') as dayjs.Dayjs).format('HH:mm')).toBe(
        '09:46',
      );
    } finally {
      await act(async () => root.unmount());
    }
  });

  it('#3891 copied a replacement source without retaining previous report metadata', async () => {
    setRecentValues({});
    directSubmitMocks.copyDirectSubmit
      .mockResolvedValueOnce({ payloads: [{ unit: 'Підрозділ 7', network: { name: 'Мережа 7' } }] })
      .mockResolvedValueOnce({
        payloads: [{ unit: 'Підрозділ 8', network: { name: 'Мережа 8' } }],
      });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const renderSource = (id: number) =>
      root.render(
        <ManageMessageDrawer
          open
          cyberEchoEnabled
          currentUser={{ roles: ['Rer'] } as User}
          onClose={vi.fn()}
          reportSource={{ id, message: buildMessage({ networkIds: [id] }) }}
        />,
      );
    try {
      await act(async () => {
        renderSource(7);
      });
      expect(autocompleteValuesByLabel.get('Підрозділ')).toBe('Підрозділ 7');
      expect(autocompleteValuesByLabel.get('Мережа')).toBe('Мережа 7');
      await act(async () => {
        renderSource(8);
      });
      expect(autocompleteValuesByLabel.get('Підрозділ')).toBe('Підрозділ 8');
      expect(autocompleteValuesByLabel.get('Мережа')).toBe('Мережа 8');
    } finally {
      await act(async () => root.unmount());
    }
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
          currentUser={{ roles: ['Rer'] } as User}
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
          currentUser={{ roles: ['Rer'] } as User}
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
      extendedForm: 'existing report comment',
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
          currentUser={{ roles: ['Rer'] } as User}
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
    const groupInput = container.querySelector(
      'input[aria-label="Відправити в групу"]',
    ) as HTMLInputElement;
    expect(groupInput.value).toBe('Не відправляти');
    expect(groupInput.required).toBe(true);
    expect(groupInput.style.color).toBe('');

    const form = container.querySelector('form') as HTMLFormElement;
    await act(async () => {
      autocompleteOnChangeByLabel.get('Відправити в групу')?.(null, null);
      await Promise.resolve();
    });
    expect((container.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(
      false,
    );
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(directSubmitMocks.editDirectSubmit).not.toHaveBeenCalled();
    expect(textFieldPropsByLabel.get('Відправити в групу')).toMatchObject({
      error: true,
      helperText: 'Оберіть групу',
    });

    const noSendOption = autocompleteOptionsByLabel
      .get('Відправити в групу')
      ?.find((option) => (option as { name?: string }).name === 'Не відправляти');
    await act(async () => {
      autocompleteOnChangeByLabel.get('Відправити в групу')?.(null, noSendOption);
      await Promise.resolve();
    });

    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(directSubmitMocks.editDirectSubmit).toHaveBeenCalledWith(
      91,
      expect.objectContaining({
        full_body: 'existing report body',
        comment: 'existing report comment',
        signal_group_master_key: null,
      }),
    );
    expect(
      directSubmitMocks.editDirectSubmit.mock.calls[0][1].parent_signal_message_ids,
    ).toBeUndefined();

    root.unmount();
  });

  // Regression: https://github.com/echoua/echo/issues/3515
  it.each([false, true])(
    '#3515 submits clearing/restoring time (previously missing: %s)',
    async (isTimeNull) => {
      const message = buildMessage({ isTimeNull, timestamp: Date.parse('2026-07-01T09:00:00Z') });
      directSubmitMocks.editDirectSubmit.mockResolvedValue({ signal_message_id: 91, message });
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      await act(async () => {
        root.render(
          <ManageMessageDrawer
            open
            cyberEchoEnabled={false}
            currentUser={{ roles: ['Rer'] } as User}
            onClose={vi.fn()}
            editTarget={{ id: 91, message }}
          />,
        );
      });
      expect(pickerValuesByLabel.get('Час перехоплення') == null).toBe(isTimeNull);
      await act(async () => {
        timePickerOnChange.get('Час перехоплення')?.(
          isTimeNull ? dayjs('2026-07-01T12:00:00') : null,
        );
      });
      await act(async () => {
        container
          .querySelector('form')
          ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
      expect(directSubmitMocks.editDirectSubmit).toHaveBeenCalledWith(
        91,
        expect.objectContaining({
          is_time_null: !isTimeNull,
          timestamp: '2026-07-01T09:00:00.000Z',
        }),
      );
      root.unmount();
    },
  );
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
          currentUser={{ roles: ['Rer'] } as User}
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
          currentUser={{ roles: ['Rer'] } as User}
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
          currentUser={{ roles: ['Rer'] } as User}
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
          currentUser={{ roles: ['Rer'] } as User}
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
          currentUser={{ roles: ['Rer'] } as User}
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

  it('restores focus to the page fallback when the invoking control is unavailable', async () => {
    const container = document.createElement('div');
    const fallback = document.createElement('button');
    document.body.appendChild(container);
    document.body.appendChild(fallback);
    const focusFallbackRef = createRef<HTMLElement>();
    focusFallbackRef.current = fallback;
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <ManageMessageDrawer
          open
          cyberEchoEnabled={false}
          currentUser={{ roles: ['Rer'] } as User}
          onClose={vi.fn()}
          focusFallbackRef={focusFallbackRef}
        />,
      );
    });

    expect(drawerModalProps?.closeAfterTransition).toBe(true);
    await act(async () => {
      const closeButton = Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent?.trim() === 'Закрити',
      );
      closeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    });
    expect(document.activeElement).toBe(fallback);

    root.unmount();
    fallback.remove();
  });

  it('restores focus to an explicitly captured invoking control', async () => {
    const container = document.createElement('div');
    const invokingControl = document.createElement('button');
    document.body.appendChild(container);
    document.body.appendChild(invokingControl);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <ManageMessageDrawer
          open
          cyberEchoEnabled={false}
          currentUser={{ roles: ['Rer'] } as User}
          onClose={vi.fn()}
          initialFocusTarget={invokingControl}
        />,
      );
    });

    await act(async () => {
      const closeButton = Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent?.trim() === 'Закрити',
      );
      closeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    });
    expect(document.activeElement).toBe(invokingControl);

    root.unmount();
    invokingControl.remove();
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
        <ManageMessageDrawer
          open
          cyberEchoEnabled
          currentUser={{ roles: ['Rer'] } as User}
          onClose={vi.fn()}
        />,
      );
      await Promise.resolve();
    });

    expect(pickerValuesByLabel.get('Дата перехоплення')).toBeTruthy();
    expect(pickerValuesByLabel.get('Час перехоплення')).toBeNull();
    expect(autocompleteValuesByLabel.get('Група')).toMatchObject([{ masterKey: 'g-1' }]);
    expect(autocompleteValuesByLabel.get('Підрозділ')).toEqual({ id: 1, name: 'u-1' });
    expect(autocompleteValuesByLabel.get('Назва пристрою')).toBe('device-1');
    expect(textFieldPropsByLabel.get('Частота')?.value ?? '').toBe('');
    expect(textFieldPropsByLabel.get('Пост')?.value ?? '').toBe('');

    root.unmount();
  });

  it('prefills an accessible initial group in create mode', async () => {
    setRecentValues({ group: ['g-1'] });
    referenceDataMocks.getUserSigintGroups.mockResolvedValue(['g-1', 'g-2']);
    referenceDataMocks.getGroupInfosBatch.mockResolvedValue([
      { masterKey: 'g-1', name: 'Group 1' },
      { masterKey: 'g-2', name: 'Group 2' },
    ]);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <ManageMessageDrawer
          open
          initialGroupMasterKey="g-2"
          cyberEchoEnabled={false}
          currentUser={{ roles: ['Rer'] } as User}
          onClose={vi.fn()}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(autocompleteValuesByLabel.get('Група')).toMatchObject([{ masterKey: 'g-2' }]);
    root.unmount();
  });

  it('falls back to current recent-group behavior for all-groups scope', async () => {
    setRecentValues({ group: ['g-1'] });
    referenceDataMocks.getUserSigintGroups.mockResolvedValue(['g-1']);
    referenceDataMocks.getGroupInfosBatch.mockResolvedValue([
      { masterKey: 'g-1', name: 'Group 1' },
    ]);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <ManageMessageDrawer
          open
          initialGroupMasterKey={null}
          cyberEchoEnabled={false}
          currentUser={{ roles: ['Rer'] } as User}
          onClose={vi.fn()}
        />,
      );
      await Promise.resolve();
    });

    expect(autocompleteValuesByLabel.get('Група')).toMatchObject([{ masterKey: 'g-1' }]);
    root.unmount();
  });

  it('rejects an inaccessible initial group and reports an error', async () => {
    setRecentValues({ group: ['g-1'] });
    referenceDataMocks.getUserSigintGroups.mockResolvedValue(['g-1']);
    referenceDataMocks.getGroupInfosBatch.mockResolvedValue([
      { masterKey: 'g-1', name: 'Group 1' },
    ]);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <ManageMessageDrawer
          open
          initialGroupMasterKey="missing-group"
          cyberEchoEnabled={false}
          currentUser={{ roles: ['Rer'] } as User}
          onClose={vi.fn()}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(autocompleteValuesByLabel.get('Група')).toEqual([]);
    expect(container.textContent).toContain('Обрана група більше недоступна.');
    root.unmount();
  });

  it.each(['g-1', 'g-2'])(
    '#4103 reconciles a removed destination %s after reference-data retry',
    async (removedKey) => {
      setRecentValues({});
      const groups = [
        { masterKey: 'g-1', name: 'Group 1' },
        { masterKey: 'g-2', name: 'Group 2' },
      ];
      const survivingGroups = groups.filter((group) => group.masterKey !== removedKey);
      referenceDataMocks.getUserSigintGroups.mockResolvedValue(['g-1', 'g-2']);
      referenceDataMocks.getGroupInfosBatch
        .mockResolvedValueOnce(groups)
        .mockResolvedValue(survivingGroups);
      directSubmitMocks.searchPostNames.mockRejectedValueOnce(new Error('Reference data failed'));
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      await act(async () => {
        root.render(
          <ManageMessageDrawer
            open
            cyberEchoEnabled={false}
            currentUser={{ roles: ['Rer'] } as User}
            onClose={vi.fn()}
          />,
        );
      });
      await act(async () => {
        autocompleteOnChangeByLabel.get('Група')?.(null, groups);
        textFieldPropsByLabel
          .get('Текст повідомлення')
          ?.onChange?.({ target: { value: 'For surviving groups' } });
      });
      const retry = Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent === 'Повторити завантаження',
      );
      expect(retry).toBeDefined();
      await act(async () => retry!.click());
      expect(autocompleteValuesByLabel.get('Група')).toEqual(survivingGroups);
      expect(container.textContent).toContain('Обрана група більше недоступна.');
      expect((container.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(
        false,
      );
      await act(async () => {
        container
          .querySelector('form')!
          .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
      expect(directSubmitMocks.submitDirect).toHaveBeenCalledWith(
        expect.objectContaining({
          signal_group_master_key: survivingGroups[0]!.masterKey,
          additional_signal_group_master_keys: [],
        }),
      );
      root.unmount();
    },
  );

  it('does not overwrite edit or report group state', async () => {
    referenceDataMocks.getUserSigintGroups.mockResolvedValue(['g-1', 'g-2']);
    referenceDataMocks.getGroupInfosBatch.mockResolvedValue([
      { masterKey: 'g-1', name: 'Group 1' },
      { masterKey: 'g-2', name: 'Group 2' },
    ]);
    directSubmitMocks.copyDirectSubmit.mockResolvedValue({
      payloads: [{ full_body: 'copied source', parent_signal_message_ids: [42] }],
    });
    const editContainer = document.createElement('div');
    document.body.appendChild(editContainer);
    const editRoot = createRoot(editContainer);

    await act(async () => {
      editRoot.render(
        <ManageMessageDrawer
          open
          initialGroupMasterKey="g-2"
          cyberEchoEnabled={false}
          currentUser={{ roles: ['Rer'] } as User}
          onClose={vi.fn()}
          editTarget={{ id: 10, message: buildMessage({ groupMasterKey: 'g-1' }) }}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(autocompleteValuesByLabel.get('Група')).toMatchObject({ masterKey: 'g-1' });
    act(() => editRoot.unmount());

    const reportContainer = document.createElement('div');
    document.body.appendChild(reportContainer);
    const reportRoot = createRoot(reportContainer);
    await act(async () => {
      reportRoot.render(
        <ManageMessageDrawer
          open
          initialGroupMasterKey="g-2"
          cyberEchoEnabled={false}
          currentUser={{ roles: ['Rer'] } as User}
          onClose={vi.fn()}
          reportSource={{ id: 42, message: buildMessage() }}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(autocompleteValuesByLabel.get('Відправити в групу')).toBeNull();
    act(() => reportRoot.unmount());
  });

  it('resets the initial group between create intents without leaking a draft', async () => {
    referenceDataMocks.getUserSigintGroups.mockResolvedValue(['g-1', 'g-2']);
    referenceDataMocks.getGroupInfosBatch.mockResolvedValue([
      { masterKey: 'g-1', name: 'Group 1' },
      { masterKey: 'g-2', name: 'Group 2' },
    ]);
    const editorRef = createRef<ManageMessageEditorHandle>();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const renderIntent = (groupMasterKey: string) =>
      root.render(
        <ManageMessageDrawer
          ref={editorRef}
          open
          intentKey={`create-message:${groupMasterKey}`}
          initialGroupMasterKey={groupMasterKey}
          presentation="embedded"
          cyberEchoEnabled={false}
          currentUser={{ roles: ['Rer'] } as User}
          onClose={vi.fn()}
        />,
      );

    await act(async () => {
      renderIntent('g-1');
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      textFieldPropsByLabel
        .get('Текст повідомлення')
        ?.onChange?.({ target: { value: 'draft for group one' } });
      await Promise.resolve();
    });

    act(() => {
      editorRef.current?.requestIntentChange({
        key: 'create-message:g-2',
        commit: () => renderIntent('g-2'),
      });
    });
    expect(container.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(autocompleteValuesByLabel.get('Група')).toMatchObject([{ masterKey: 'g-1' }]);

    const discard = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Відхилити зміни',
    );
    await act(async () => {
      discard?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(autocompleteValuesByLabel.get('Група')).toMatchObject([{ masterKey: 'g-2' }]);
    expect(textFieldPropsByLabel.get('Текст повідомлення')?.value).toBe('');
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
        <ManageMessageDrawer
          open
          cyberEchoEnabled={false}
          currentUser={{ roles: ['Rer'] } as User}
          onClose={vi.fn()}
        />,
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
        <ManageMessageDrawer
          open
          cyberEchoEnabled={false}
          currentUser={{ roles: ['Rer'] } as User}
          onClose={vi.fn()}
        />,
      );
      await Promise.resolve();
    });

    expect(autocompleteValuesByLabel.get('Група')).toEqual([]);
    expect((container.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(
      true,
    );
    root.unmount();
  });

  it('#3568 creates a Cyber message without radio fields and ignores a parsed frequency', async () => {
    referenceDataMocks.getUserSigintGroups.mockResolvedValue(['g-1']);
    referenceDataMocks.getGroupInfosBatch.mockResolvedValue([{ masterKey: 'g-1' }]);
    directSubmitMocks.parseDirectSubmit.mockResolvedValue({
      text: 'parsed body',
      freq: '153.6250',
      post: 'HIDDEN-PARSED-POST',
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <ManageMessageDrawer
          open
          cyberEchoEnabled={false}
          currentUser={{ roles: ['Cyber', 'UnitsEditor'] } as User}
          onClose={vi.fn()}
        />,
      );
      await Promise.resolve();
    });
    await act(async () => {
      autocompleteOnChangeByLabel.get('Група')?.(null, { masterKey: 'g-1' });
      textFieldPropsByLabel.get('Текст повідомлення')?.onChange?.({ target: { value: 'body' } });
      await Promise.resolve();
    });
    const parse = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Розпарсити',
    )!;
    await act(async () => {
      parse.click();
    });
    const advanced = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Розширені поля',
    )!;
    await act(async () => {
      advanced.click();
    });
    expect(container.querySelector('[aria-label="Коротке повідомлення"]')).not.toBeNull();
    expect(container.textContent).not.toContain('Частота (МГц)');
    expect(container.textContent).not.toContain('DMR метадані');
    expect(container.textContent).not.toContain('Назва сигнала мережі');
    expect(directSubmitMocks.searchFreqs).not.toHaveBeenCalled();
    expect(directSubmitMocks.searchPostNames).not.toHaveBeenCalled();
    expect(autocompleteOnChangeByLabel.has('Пост')).toBe(false);
    const submit = container.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    await act(async () => {
      container
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(directSubmitMocks.submitDirect).toHaveBeenCalledWith(
      expect.objectContaining({ freq: undefined, post: undefined, dmr: [] }),
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
        <ManageMessageDrawer
          open
          cyberEchoEnabled={false}
          currentUser={{ roles: ['Rer'] } as User}
          onClose={vi.fn()}
        />,
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
        <ManageMessageDrawer
          open
          cyberEchoEnabled={false}
          currentUser={{ roles: ['Rer'] } as User}
          onClose={vi.fn()}
        />,
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
          currentUser={{ roles: ['Rer'] } as User}
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
        <ManageMessageDrawer
          open
          cyberEchoEnabled={false}
          currentUser={{ roles: ['Rer'] } as User}
          onClose={vi.fn()}
        />,
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
        <ManageMessageDrawer
          open
          cyberEchoEnabled={false}
          currentUser={{ roles: ['Rer'] } as User}
          onClose={vi.fn()}
        />,
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
        <ManageMessageDrawer
          open
          cyberEchoEnabled={false}
          currentUser={{ roles: ['Rer'] } as User}
          onClose={vi.fn()}
        />,
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
        <ManageMessageDrawer
          open
          cyberEchoEnabled={false}
          currentUser={{ roles: ['Rer'] } as User}
          onClose={vi.fn()}
        />,
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
          currentUser={{ roles: ['Rer'] } as User}
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
          currentUser={{ roles: ['Rer'] } as User}
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
          currentUser={{ roles: ['Rer'] } as User}
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
      form.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
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

  it('keeps an embedded create editor open, resets it, and restores text focus after success', async () => {
    const onClose = vi.fn();
    const onCreated = vi.fn();
    referenceDataMocks.getUserSigintGroups.mockResolvedValue(['g-1']);
    referenceDataMocks.getGroupInfosBatch.mockResolvedValue([
      { masterKey: 'g-1', name: 'Group 1' },
    ]);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <ManageMessageDrawer
          open
          presentation="embedded"
          cyberEchoEnabled={false}
          currentUser={{ roles: ['Rer'] } as User}
          onClose={onClose}
          onCreated={onCreated}
        />,
      );
      await Promise.resolve();
    });

    expect(
      Array.from(container.querySelectorAll('button')).some(
        (button) => button.textContent === 'Закрити',
      ),
    ).toBe(true);
    expect(container.textContent).not.toContain('Скасувати');

    await act(async () => {
      autocompleteOnChangeByLabel.get('Група')?.(null, {
        masterKey: 'g-1',
        name: 'Group 1',
      });
      textFieldPropsByLabel.get('Текст повідомлення')?.onChange?.({
        target: { value: 'new message body' },
      });
      await Promise.resolve();
    });

    await act(async () => {
      container
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      for (let index = 0; index < 5; index += 1) await Promise.resolve();
    });

    const messageText = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Текст повідомлення"]',
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(container.querySelector('form')).not.toBeNull();
    expect(messageText?.value).toBe('');
    expect(container.textContent).not.toContain('Повідомлення успішно створено.');
    expect(document.activeElement).toBe(messageText);
    expect(
      Array.from(container.querySelectorAll('button')).some(
        (button) => button.textContent === 'Закрити',
      ),
    ).toBe(true);

    await act(async () => {
      root.render(
        <ManageMessageDrawer
          open
          intentKey="create-message:next"
          presentation="embedded"
          cyberEchoEnabled={false}
          currentUser={{ roles: ['Rer'] } as User}
          onClose={onClose}
          onCreated={onCreated}
        />,
      );
    });
    expect(
      Array.from(container.querySelectorAll('button')).some(
        (button) => button.textContent === 'Закрити',
      ),
    ).toBe(true);
    expect(container.textContent).not.toContain('Скасувати');

    await act(async () => root.unmount());
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
        <ManageMessageDrawer
          open
          cyberEchoEnabled={false}
          currentUser={{ roles: ['Rer'] } as User}
          onClose={vi.fn()}
        />,
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

  it('blocks submission while auto-parse is debouncing', async () => {
    vi.useFakeTimers();
    dutySettingsMocks.messageAutoParseEnabled = true;
    directSubmitMocks.parseDirectSubmit.mockResolvedValue({
      text: 'parsed body',
      coords: [],
      to: [],
      locations: [],
    });
    referenceDataMocks.getUserSigintGroups.mockResolvedValue(['g-1']);
    referenceDataMocks.getGroupInfosBatch.mockResolvedValue([{ masterKey: 'g-1' }]);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <ManageMessageDrawer
          open
          cyberEchoEnabled={false}
          currentUser={{ roles: ['Rer'] } as User}
          onClose={vi.fn()}
        />,
      );
      await Promise.resolve();
    });
    await act(async () => {
      autocompleteOnChangeByLabel.get('Група')?.(null, { masterKey: 'g-1' });
      textFieldPropsByLabel.get('Текст повідомлення')?.onChange?.({ target: { value: 'body' } });
      await Promise.resolve();
    });

    const form = container.querySelector('form') as HTMLFormElement;
    const submitButton = container.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(submitButton.disabled).toBe(true);

    form.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }),
    );
    expect(directSubmitMocks.submitDirect).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(700);
      await Promise.resolve();
    });

    expect(directSubmitMocks.parseDirectSubmit).toHaveBeenCalledOnce();
    expect(submitButton.disabled).toBe(false);
    root.unmount();
    vi.useRealTimers();
  });

  it('keeps submission blocked when auto-reparse fails', async () => {
    vi.useFakeTimers();
    dutySettingsMocks.messageAutoParseEnabled = true;
    directSubmitMocks.parseDirectSubmit
      .mockResolvedValueOnce({
        text: 'parsed body',
        freq: '149.500',
        coords: [],
        to: [],
        locations: [],
      })
      .mockRejectedValueOnce(new Error('Parse failure'));
    referenceDataMocks.getUserSigintGroups.mockResolvedValue(['g-1']);
    referenceDataMocks.getGroupInfosBatch.mockResolvedValue([{ masterKey: 'g-1' }]);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <ManageMessageDrawer
          open
          cyberEchoEnabled={false}
          currentUser={{ roles: ['Rer'] } as User}
          onClose={vi.fn()}
        />,
      );
      await Promise.resolve();
    });
    await act(async () => {
      autocompleteOnChangeByLabel.get('Група')?.(null, { masterKey: 'g-1' });
      textFieldPropsByLabel
        .get('Текст повідомлення')
        ?.onChange?.({ target: { value: 'old body' } });
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(700);
      await Promise.resolve();
    });

    const form = container.querySelector('form') as HTMLFormElement;
    const submitButton = container.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(submitButton.disabled).toBe(false);
    expect(autocompleteValuesByLabel.get('Частота (МГц)')).toBe('149.500');

    await act(async () => {
      textFieldPropsByLabel
        .get('Текст повідомлення')
        ?.onChange?.({ target: { value: 'new body' } });
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(700);
      await Promise.resolve();
    });

    expect(directSubmitMocks.parseDirectSubmit).toHaveBeenCalledTimes(2);
    expect(autocompleteValuesByLabel.get('Частота (МГц)')).toBe('149.500');
    expect(submitButton.disabled).toBe(true);
    form.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }),
    );
    expect(directSubmitMocks.submitDirect).not.toHaveBeenCalled();

    root.unmount();
    vi.useRealTimers();
  });

  it.each([
    [['Rer'], true],
    [['Rer', 'DeleteMsg'], false],
    [['Admin'], false],
    [['Full'], false],
  ])('#3955 destination group edit access for %j', async (roles, disabled) => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <ManageMessageDrawer
          open
          cyberEchoEnabled={false}
          currentUser={{ roles } as User}
          onClose={vi.fn()}
          editTarget={{ id: 42, message: buildMessage() }}
        />,
      );
    });
    const group = container.querySelector('input[aria-label="Група"]') as HTMLInputElement;
    expect(group.disabled).toBe(disabled);
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
          currentUser={{ roles: ['Rer'] } as User}
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

  it('#3595 submits an edited image as a same-ID replacement without deleting it', async () => {
    directSubmitMocks.editDirectSubmit.mockResolvedValue({ signal_message_id: 42 });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <ManageMessageDrawer
          open
          cyberEchoEnabled={false}
          currentUser={{ roles: ['Rer'] } as User}
          onClose={vi.fn()}
          editTarget={{
            id: 42,
            message: buildMessage({
              media: Array.from({ length: 20 }, (_, index) => ({
                id: index === 10 ? 'middle-image' : `image-${index}`,
                contentType: 'image/png',
                fileName: index === 10 ? 'middle.png' : `image-${index}.png`,
                sizeBytes: 11,
                href: index === 10 ? '/media/middle-image' : `/media/image-${index}`,
                transcription: null,
              })),
            }),
          }}
        />,
      );
    });
    await act(async () => {
      container
        .querySelector('button[aria-label="Більше дій для middle.png"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      Array.from(container.querySelectorAll('button[role="menuitem"]'))
        .find((button) => button.textContent === 'Перейменувати')
        ?.click();
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    });
    await act(async () => {
      textFieldPropsByLabel.get('Назва файлу')?.onChange?.({ target: { value: 'renamed-middle' } });
      await Promise.resolve();
    });
    await act(async () => {
      Array.from(container.querySelectorAll('button'))
        .filter((button) => button.textContent === 'Перейменувати')
        .at(-1)
        ?.click();
      await Promise.resolve();
    });
    await act(async () => {
      uppyMocks.latest?.addFile({
        name: 'middle-edited.png',
        type: 'image/png',
        size: 11,
        data: new File(['replacement'], 'middle-edited.png', { type: 'image/png' }),
        meta: { replaces_media_id: 'middle-image' },
        uploadURL: '/upload/replacement',
      });
    });

    await act(async () => {
      container
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(directSubmitMocks.editDirectSubmit).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        upload_urls: null,
        attachment_updates: {
          replacements: [{ media_id: 'middle-image', upload_url: '/upload/replacement' }],
          renames: [],
        },
        deleted_media_ids: [],
      }),
    );
    root.unmount();
  });

  it.each([false, true])(
    '#3931 reorders attachments with legacy null positions=%s',
    async (legacy) => {
      directSubmitMocks.editDirectSubmit.mockResolvedValue({ signal_message_id: 42 });
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      await act(async () => {
        root.render(
          <ManageMessageDrawer
            open
            cyberEchoEnabled={false}
            currentUser={{ roles: ['Rer'] } as User}
            onClose={vi.fn()}
            editTarget={{
              id: 42,
              message: buildMessage({
                media: [1, 2, 3].map((position) => ({
                  id: `file-${position}`,
                  orderF64: legacy ? null : position,
                  contentType: 'image/png',
                  fileName: `${position}.png`,
                  sizeBytes: 11,
                  href: `/media/file-${position}`,
                  transcription: null,
                })),
              }),
            }}
          />,
        );
      });
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>('button[aria-label="Перемістити 3.png вище"]')!
          .click();
      });
      const labels = Array.from(
        container.querySelectorAll('button[aria-label^="Більше дій для"]'),
      ).map((button) => button.getAttribute('aria-label'));
      expect(labels).toEqual([
        'Більше дій для 1.png',
        'Більше дій для 3.png',
        'Більше дій для 2.png',
      ]);
      await act(async () => {
        container
          .querySelector('form')!
          .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
      const orders = legacy
        ? [
            { media_id: 'file-1', upload_url: null, order_f64: 1 },
            { media_id: 'file-2', upload_url: null, order_f64: 2 },
            { media_id: 'file-3', upload_url: null, order_f64: 1.5 },
          ]
        : [{ media_id: 'file-3', upload_url: null, order_f64: 1.5 }];
      expect(directSubmitMocks.editDirectSubmit).toHaveBeenCalledWith(
        42,
        expect.objectContaining({ attachment_updates: { replacements: [], renames: [], orders } }),
      );
      root.unmount();
    },
  );

  it('#3931 interleaves a pending upload with existing attachments', async () => {
    directSubmitMocks.editDirectSubmit.mockResolvedValue({ signal_message_id: 42 });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <ManageMessageDrawer
          open
          cyberEchoEnabled={false}
          currentUser={{ roles: ['Rer'] } as User}
          onClose={vi.fn()}
          editTarget={{
            id: 42,
            message: buildMessage({
              media: [1, 2].map((position) => ({
                id: `existing-${position}`,
                orderF64: position,
                contentType: 'image/png',
                fileName: `${position}.png`,
                sizeBytes: 11,
                href: `/media/${position}`,
                transcription: null,
              })),
            }),
          }}
        />,
      );
    });
    await act(async () => {
      uppyMocks.latest!.addFile({
        name: 'new.png',
        type: 'image/png',
        size: 11,
        data: new File(['new'], 'new.png', { type: 'image/png' }),
        uploadURL: '/upload/new',
      });
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Перемістити new.png вище"]')!
        .click();
    });
    await act(async () => {
      container
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(directSubmitMocks.editDirectSubmit).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        upload_urls: ['/upload/new'],
        attachment_updates: {
          replacements: [],
          renames: [],
          orders: [{ media_id: null, upload_url: '/upload/new', order_f64: 1.5 }],
        },
      }),
    );
    root.unmount();
  });

  it('#3321 submits a renamed existing attachment without changing its extension', async () => {
    directSubmitMocks.editDirectSubmit.mockResolvedValue({ signal_message_id: 42 });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <ManageMessageDrawer
          open
          cyberEchoEnabled={false}
          currentUser={{ roles: ['Rer'] } as User}
          onClose={vi.fn()}
          editTarget={{
            id: 42,
            message: buildMessage({
              media: [
                {
                  id: 'document-id',
                  contentType: 'application/pdf',
                  fileName: 'report.pdf',
                  sizeBytes: 4,
                  href: '/media/document-id',
                  transcription: null,
                },
              ],
            }),
          }}
        />,
      );
    });

    await act(async () => {
      container
        .querySelector('button[aria-label="Більше дій для report.pdf"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      Array.from(container.querySelectorAll('button[role="menuitem"]'))
        .find((button) => button.textContent === 'Перейменувати')
        ?.click();
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    });
    await act(async () => {
      textFieldPropsByLabel.get('Назва файлу')?.onChange?.({ target: { value: 'renamed-report' } });
      await Promise.resolve();
    });
    await act(async () => {
      Array.from(container.querySelectorAll('button'))
        .filter((button) => button.textContent === 'Перейменувати')
        .at(-1)
        ?.click();
      await Promise.resolve();
    });
    await act(async () => {
      container
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(directSubmitMocks.editDirectSubmit).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        attachment_updates: {
          replacements: [],
          renames: [{ media_id: 'document-id', file_name: 'renamed-report.pdf' }],
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
          currentUser={{ roles: ['Rer'] } as User}
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
          currentUser={{ roles: ['Rer'] } as User}
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
    expect(unitMocks.getUnitsByIds).toHaveBeenCalledWith([51], expect.anything());
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
          currentUser={{ roles: ['Rer'] } as User}
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
          currentUser={{ roles: ['Rer'] } as User}
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
          currentUser={{ roles: ['Rer'] } as User}
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
          currentUser={{ roles: ['Rer'] } as User}
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
          currentUser={{ roles: ['Rer'] } as User}
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

  it.each([['Rer'], ['Cyber'], ['Cyber', 'UnitsEditor']])(
    '#3568 preserves every DMR metadata row in an edit for %j',
    async (...roles) => {
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
            currentUser={{ roles } as User}
            onClose={vi.fn()}
            editTarget={{
              id: 91,
              message: buildMessage({
                post: 'ORIGINAL-POST',
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

      if (!roles.includes('Rer')) {
        expect(container.textContent).not.toContain('Частота (МГц)');
        expect(container.textContent).not.toContain('DMR метадані');
        expect(container.textContent).not.toContain('Колірний код (CC)');
        expect(directSubmitMocks.searchFreqs).not.toHaveBeenCalled();
      }
      expect(directSubmitMocks.editDirectSubmit.mock.calls[0][1].post).toBe('ORIGINAL-POST');
      expect(directSubmitMocks.editDirectSubmit.mock.calls[0][1].dmr).toMatchObject([
        { cc: 3, sender_id: 101, signal_name: 'DMR' },
        { cc: 3, sender_id: 202, signal_name: 'DMR' },
      ]);
      root.unmount();
    },
  );

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
          currentUser={{ roles: ['Rer'] } as User}
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
          currentUser={{ roles: ['Rer'] } as User}
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
          currentUser={{ roles: ['Rer'] } as User}
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
          currentUser={{ roles: ['Rer'] } as User}
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
          currentUser={{ roles: ['Rer'] } as User}
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
          currentUser={{ roles: ['Rer'] } as User}
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

  it('closes a report editor and reports success when the response has no inline message', async () => {
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
          currentUser={{ roles: ['Rer'] } as User}
          onClose={() => {
            onClose();
            setOpen(false);
          }}
          editTarget={{ id: 124, message: buildMessage() }}
          editAsReport
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
          currentUser={{ roles: ['Rer'] } as User}
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
          currentUser={{ roles: ['Rer'] } as User}
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

  describe('auto-parse setting', () => {
    it('#3620 waits for settings and respects a saved opt-out before auto-parsing', async () => {
      vi.useFakeTimers();
      dutySettingsMocks.messageAutoParseEnabled = true;
      dutySettingsMocks.loadInProgress = true;
      directSubmitMocks.parseDirectSubmit.mockResolvedValue({
        text: '',
        coords: [],
        to: [],
        locations: [],
      });
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      const render = async () => {
        await act(async () => {
          root.render(
            <ManageMessageDrawer
              open
              cyberEchoEnabled={false}
              currentUser={{ roles: ['Rer'] } as User}
              onClose={vi.fn()}
            />,
          );
          await Promise.resolve();
        });
      };
      await render();
      await act(async () => {
        textFieldPropsByLabel
          .get('Текст повідомлення')
          ?.onChange?.({ target: { value: 'Ярус, прием' } });
      });
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
      expect(directSubmitMocks.parseDirectSubmit).not.toHaveBeenCalled();
      dutySettingsMocks.loadInProgress = false;
      dutySettingsMocks.messageAutoParseEnabled = false;
      await render();
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
      expect(directSubmitMocks.parseDirectSubmit).not.toHaveBeenCalled();
      dutySettingsMocks.messageAutoParseEnabled = true;
      await render();
      await act(async () => {
        vi.advanceTimersByTime(700);
        await Promise.resolve();
      });
      expect(directSubmitMocks.parseDirectSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ include_ai_callsigns: true }),
      );
      root.unmount();
      vi.useRealTimers();
    });

    it('keeps manual parsing enabled and ignores an empty source', async () => {
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);

      await act(async () => {
        root.render(
          <ManageMessageDrawer
            open
            cyberEchoEnabled={false}
            currentUser={{ roles: ['Rer'] } as User}
            onClose={vi.fn()}
          />,
        );
        await Promise.resolve();
      });

      const parseButton = Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent === 'Розпарсити',
      ) as HTMLButtonElement;
      expect(parseButton.disabled).toBe(false);

      await act(async () => parseButton.click());
      expect(directSubmitMocks.parseDirectSubmit).not.toHaveBeenCalled();

      await act(async () => {
        textFieldPropsByLabel
          .get('Текст повідомлення')
          ?.onChange?.({ target: { value: 'частота 149.500' } });
      });
      expect(parseButton.disabled).toBe(false);

      root.unmount();
    });

    it('highlights parser feedback without a layout-shifting summary', async () => {
      directSubmitMocks.parseDirectSubmit
        .mockResolvedValueOnce({ text: '', freq: '149.500', coords: [], to: [], locations: [] })
        .mockResolvedValueOnce({ text: '', freq: '151.000', coords: [], to: [], locations: [] });
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);

      await act(async () => {
        root.render(
          <ManageMessageDrawer
            open
            cyberEchoEnabled={false}
            currentUser={{ roles: ['Rer'] } as User}
            onClose={vi.fn()}
          />,
        );
        await Promise.resolve();
      });
      await act(async () => {
        textFieldPropsByLabel
          .get('Текст повідомлення')
          ?.onChange?.({ target: { value: 'частота 149.500' } });
      });
      const parseButton = Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent === 'Розпарсити',
      ) as HTMLButtonElement;
      await act(async () => {
        parseButton.click();
        await Promise.resolve();
      });

      expect(
        container.querySelector('[data-testid="parser-feedback-freq"]')?.getAttribute('data-state'),
      ).toBe('updated');
      expect(container.querySelector('[role="status"]')).toBeNull();

      await act(async () => {
        autocompleteOnInputChangeByLabel.get('Частота (МГц)')?.(null, '150.000', 'input');
        textFieldPropsByLabel
          .get('Текст повідомлення')
          ?.onChange?.({ target: { value: 'частота 151.000' } });
      });
      await act(async () => {
        parseButton.click();
        await Promise.resolve();
      });

      expect(autocompleteValuesByLabel.get('Частота (МГц)')).toBe('150.000');
      expect(
        container.querySelector('[data-testid="parser-feedback-freq"]')?.getAttribute('data-state'),
      ).toBe('conflict');
      const accept = container.querySelector(
        'button[aria-label="Взяти частоту із тексту"]',
      ) as HTMLButtonElement;
      await act(async () => accept.click());
      expect(autocompleteValuesByLabel.get('Частота (МГц)')).toBe('151.000');

      root.unmount();
    });

    it('replaces a selected network when accepting the parsed network', async () => {
      directSubmitMocks.parseDirectSubmit.mockResolvedValueOnce({
        text: '',
        unit: 'Розпізнана мережа',
        coords: [],
        to: [],
        locations: [],
      });
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);

      await act(async () => {
        root.render(
          <ManageMessageDrawer
            open
            cyberEchoEnabled={false}
            currentUser={{ roles: ['Rer'] } as User}
            onClose={vi.fn()}
          />,
        );
        await Promise.resolve();
      });
      await act(async () => {
        autocompleteOnChangeByLabel.get('Мережа')?.(null, {
          id: 1,
          name: 'Ручна мережа',
          unit_ids: [],
          freqs: [],
        });
        textFieldPropsByLabel
          .get('Текст повідомлення')
          ?.onChange?.({ target: { value: 'розпізнана мережа' } });
        await Promise.resolve();
      });
      const parseButton = Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent === 'Розпарсити',
      ) as HTMLButtonElement;
      await act(async () => {
        parseButton.click();
        await Promise.resolve();
      });

      expect(autocompleteValuesByLabel.get('Мережа')).toMatchObject({
        id: 1,
        name: 'Ручна мережа',
      });
      const accept = container.querySelector(
        'button[aria-label="Взяти мережу із тексту"]',
      ) as HTMLButtonElement;
      await act(async () => accept.click());

      expect(autocompleteValuesByLabel.get('Мережа')).toBe('Розпізнана мережа');

      root.unmount();
    });

    it('#3535 accepting a parsed unit released a verified network assignment', async () => {
      setRecentValues({});
      unitMocks.getUnitsByIds.mockResolvedValue([{ id: 51, name: 'Підрозділ мережі' }]);
      directSubmitMocks.parseDirectSubmit.mockResolvedValueOnce({
        text: '',
        unit_v2: 'Розпізнаний підрозділ',
        coords: [],
        to: [],
        locations: [],
      });
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      await act(async () => {
        root.render(
          <ManageMessageDrawer
            open
            cyberEchoEnabled={false}
            currentUser={{ roles: ['Rer'] } as User}
            onClose={vi.fn()}
          />,
        );
      });
      await act(async () => {
        autocompleteOnChangeByLabel.get('Мережа')?.(null, {
          id: 1,
          name: 'Мережа',
          unit_ids: [51],
          freqs: [],
        });
      });
      expect(textFieldPropsByLabel.get('Підрозділ')?.disabled).toBe(true);
      await act(async () => {
        textFieldPropsByLabel
          .get('Текст повідомлення')
          ?.onChange?.({ target: { value: 'Розпізнаний підрозділ' } });
      });
      await act(async () => {
        Array.from(container.querySelectorAll('button'))
          .find((button) => button.textContent === 'Розпарсити')
          ?.click();
      });
      await act(async () => {
        (
          container.querySelector(
            'button[aria-label="Взяти підрозділ із тексту"]',
          ) as HTMLButtonElement
        ).click();
      });
      expect(autocompleteValuesByLabel.get('Підрозділ')).toBe('Розпізнаний підрозділ');
      expect(textFieldPropsByLabel.get('Підрозділ')?.disabled).toBe(false);
      expect(autocompleteValuesByLabel.get('Мережа')).toBe('Мережа');
      root.unmount();
    });

    it('ignores stale unit hydration after accepting a different parsed network', async () => {
      let resolveUnits!: (value: Array<{ id: number; name: string }>) => void;
      unitMocks.getUnitsByIds.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveUnits = resolve;
          }),
      );
      directSubmitMocks.parseDirectSubmit.mockResolvedValueOnce({
        text: '',
        unit: 'Розпізнана мережа',
        coords: [],
        to: [],
        locations: [],
      });
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);

      await act(async () => {
        root.render(
          <ManageMessageDrawer
            open
            cyberEchoEnabled={false}
            currentUser={{ roles: ['Rer'] } as User}
            onClose={vi.fn()}
          />,
        );
        await Promise.resolve();
      });
      await act(async () => {
        autocompleteOnChangeByLabel.get('Мережа')?.(null, {
          id: 1,
          name: 'Ручна мережа',
          unit_ids: [51],
          freqs: [],
        });
        textFieldPropsByLabel
          .get('Текст повідомлення')
          ?.onChange?.({ target: { value: 'розпізнана мережа' } });
        await Promise.resolve();
      });
      const parseButton = Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent === 'Розпарсити',
      ) as HTMLButtonElement;
      await act(async () => {
        parseButton.click();
        await Promise.resolve();
      });
      const accept = container.querySelector(
        'button[aria-label="Взяти мережу із тексту"]',
      ) as HTMLButtonElement;
      await act(async () => accept.click());

      await act(async () => {
        resolveUnits([{ id: 51, name: 'Старий підрозділ' }]);
        await Promise.resolve();
      });

      expect(autocompleteValuesByLabel.get('Мережа')).toBe('Розпізнана мережа');
      expect(autocompleteValuesByLabel.get('Підрозділ')).not.toBe('Старий підрозділ');
      root.unmount();
    });

    it('does not expose a reset-form action in parsing settings', async () => {
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);

      await act(async () => {
        root.render(
          <ManageMessageDrawer
            open
            cyberEchoEnabled={false}
            currentUser={{ roles: ['Rer'] } as User}
            onClose={vi.fn()}
          />,
        );
        await Promise.resolve();
      });

      const settingsButton = container.querySelector(
        'button[aria-label="Налаштування парсингу"]',
      ) as HTMLButtonElement;
      await act(async () => settingsButton.click());

      expect(container.textContent).not.toContain('Скинути форму');
      expect(container.querySelectorAll('[role="menuitem"]')).toHaveLength(1);

      root.unmount();
    });

    it('renders parsing actions as a joined split button when auto-parse is disabled', async () => {
      dutySettingsMocks.messageAutoParseEnabled = false;
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);

      await act(async () => {
        root.render(
          <ManageMessageDrawer
            open
            cyberEchoEnabled={false}
            currentUser={{ roles: ['Rer'] } as User}
            onClose={vi.fn()}
          />,
        );
        await Promise.resolve();
      });

      const parseButton = Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent === 'Розпарсити',
      );
      expect(parseButton).toBeDefined();

      const settingsBtn = container.querySelector('button[aria-label="Налаштування парсингу"]');
      expect(settingsBtn).toBeDefined();
      const parsingActions = container.querySelector('[role="group"][aria-label="Дії парсингу"]');
      expect(parsingActions?.contains(parseButton as Node)).toBe(true);
      expect(parsingActions?.contains(settingsBtn)).toBe(true);
      expect(settingsBtn?.querySelector('[data-testid="ArrowDropDownIcon"]')).not.toBeNull();
      expect(parsingActions?.querySelector('[role="menuitem"]')).toBeNull();

      root.unmount();
    });

    it('renders "Авто-парсинг" button when auto-parse is enabled', async () => {
      dutySettingsMocks.messageAutoParseEnabled = true;
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);

      await act(async () => {
        root.render(
          <ManageMessageDrawer
            open
            cyberEchoEnabled={false}
            currentUser={{ roles: ['Rer'] } as User}
            onClose={vi.fn()}
          />,
        );
        await Promise.resolve();
      });

      const autoParseButton = Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent === 'Авто-парсинг',
      );
      expect(autoParseButton).toBeDefined();
      const statusIcon = autoParseButton?.querySelector('[data-testid="auto-parse-status"]');
      expect(statusIcon?.getAttribute('aria-hidden')).toBe('true');
      expect(statusIcon?.getAttribute('aria-label')).toBeNull();

      root.unmount();
    });

    it('toggles auto-parse setting when clicking menu item', async () => {
      dutySettingsMocks.messageAutoParseEnabled = false;
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);

      await act(async () => {
        root.render(
          <ManageMessageDrawer
            open
            cyberEchoEnabled={false}
            currentUser={{ roles: ['Rer'] } as User}
            onClose={vi.fn()}
          />,
        );
        await Promise.resolve();
      });

      const settingsBtn = container.querySelector(
        'button[aria-label="Налаштування парсингу"]',
      ) as HTMLButtonElement;
      await act(async () => {
        settingsBtn.click();
        await Promise.resolve();
      });

      const menuItem = Array.from(document.querySelectorAll('[role="menuitem"]')).find((item) =>
        item.textContent?.includes('Парсити автоматично'),
      ) as HTMLButtonElement | undefined;
      expect(menuItem).toBeDefined();

      await act(async () => {
        menuItem?.click();
        await Promise.resolve();
      });

      expect(dutySettingsMocks.scheduleSave).toHaveBeenCalledWith(
        expect.objectContaining({
          messageAutoParseEnabled: true,
        }),
      );
      expect(dutySettingsMocks.setMessageAutoParseEnabled).toHaveBeenCalledWith(true);

      root.unmount();
    });

    it('disables parser settings until duty settings finish loading', async () => {
      dutySettingsMocks.loadInProgress = true;
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);

      await act(async () => {
        root.render(
          <ManageMessageDrawer
            open
            cyberEchoEnabled={false}
            currentUser={{ roles: ['Rer'] } as User}
            onClose={vi.fn()}
          />,
        );
        await Promise.resolve();
      });

      expect(
        (container.querySelector('button[aria-label="Налаштування парсингу"]') as HTMLButtonElement)
          .disabled,
      ).toBe(true);
      root.unmount();
    });

    it('shows a settings load error and allows retrying it', async () => {
      dutySettingsMocks.loadError = 'Не вдалося завантажити налаштування.';
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);

      await act(async () => {
        root.render(
          <ManageMessageDrawer
            open
            cyberEchoEnabled={false}
            currentUser={{ roles: ['Rer'] } as User}
            onClose={vi.fn()}
          />,
        );
        await Promise.resolve();
      });

      expect(container.textContent).toContain('Не вдалося завантажити налаштування.');
      const retryButton = Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent === 'Повторити',
      );
      expect(retryButton).toBeDefined();

      await act(async () => {
        retryButton?.click();
        await Promise.resolve();
      });

      expect(dutySettingsMocks.retryLoad).toHaveBeenCalledOnce();
      root.unmount();
    });

    it.each([
      ['edit', { editTarget: { id: 42, message: buildMessage() } }],
      ['report', { editTarget: { id: 42, message: buildMessage() }, editAsReport: true }],
    ] as const)('does not show parser settings errors in %s mode', async (_, modeProps) => {
      dutySettingsMocks.loadError = 'Не вдалося завантажити налаштування.';
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);

      await act(async () => {
        root.render(
          <ManageMessageDrawer
            open
            cyberEchoEnabled={false}
            currentUser={{ roles: ['Rer'] } as User}
            onClose={vi.fn()}
            {...modeProps}
          />,
        );
        await Promise.resolve();
      });

      expect(container.textContent).not.toContain('Не вдалося завантажити налаштування.');
      expect(container.querySelector('button[aria-label="Налаштування парсингу"]')).toBeNull();
      root.unmount();
    });

    it('shows a parser setting save error and restores the previous value', async () => {
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      const render = () =>
        root.render(
          <ManageMessageDrawer
            open
            cyberEchoEnabled={false}
            currentUser={{ roles: ['Rer'] } as User}
            onClose={vi.fn()}
          />,
        );

      await act(async () => {
        render();
        await Promise.resolve();
      });
      await act(async () => {
        (
          container.querySelector('button[aria-label="Налаштування парсингу"]') as HTMLButtonElement
        ).click();
        await Promise.resolve();
      });
      const menuItem = Array.from(document.querySelectorAll('[role="menuitem"]')).find((item) =>
        item.textContent?.includes('Парсити автоматично'),
      ) as HTMLButtonElement;
      await act(async () => {
        menuItem.click();
        await Promise.resolve();
      });

      dutySettingsMocks.saveError = 'Помилка збереження налаштувань';
      await act(async () => {
        render();
        await Promise.resolve();
      });

      expect(dutySettingsMocks.setMessageAutoParseEnabled).toHaveBeenLastCalledWith(false);
      expect(container.textContent).toContain('Помилка збереження налаштувань');
      root.unmount();
    });

    it('keeps a dismissed settings save error closed across unrelated renders', async () => {
      dutySettingsMocks.unstableSetter = true;
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      const render = () =>
        root.render(
          <ManageMessageDrawer
            open
            cyberEchoEnabled={false}
            currentUser={{ roles: ['Rer'] } as User}
            onClose={vi.fn()}
          />,
        );

      await act(async () => {
        render();
        await Promise.resolve();
      });
      await act(async () => {
        (
          container.querySelector('button[aria-label="Налаштування парсингу"]') as HTMLButtonElement
        ).click();
        await Promise.resolve();
      });
      const menuItem = Array.from(document.querySelectorAll('[role="menuitem"]')).find((item) =>
        item.textContent?.includes('Парсити автоматично'),
      ) as HTMLButtonElement;
      await act(async () => {
        menuItem.click();
        await Promise.resolve();
      });

      dutySettingsMocks.saveError = 'Помилка збереження налаштувань';
      await act(async () => {
        render();
        await Promise.resolve();
      });

      const closeButton = container.querySelector(
        'button[aria-label="Закрити сповіщення"]',
      ) as HTMLButtonElement;
      await act(async () => {
        closeButton.click();
        await Promise.resolve();
      });

      expect(container.textContent).not.toContain('Помилка збереження налаштувань');
      root.unmount();
    });

    it('automatically triggers parse with debounce when auto-parse is enabled and user enters text', async () => {
      vi.useFakeTimers();
      dutySettingsMocks.messageAutoParseEnabled = true;
      directSubmitMocks.parseDirectSubmit.mockResolvedValue({
        text: 'auto parsed text',
      });
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);

      await act(async () => {
        root.render(
          <ManageMessageDrawer
            open
            cyberEchoEnabled={false}
            currentUser={{ roles: ['Rer'] } as User}
            onClose={vi.fn()}
          />,
        );
        await Promise.resolve();
      });

      await act(async () => {
        textFieldPropsByLabel
          .get('Текст повідомлення')
          ?.onChange?.({ target: { value: 'incoming message body' } });
      });

      expect(directSubmitMocks.parseDirectSubmit).not.toHaveBeenCalled();

      await act(async () => {
        vi.advanceTimersByTime(700);
        await Promise.resolve();
      });

      expect(directSubmitMocks.parseDirectSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          full_body: 'incoming message body',
        }),
      );

      root.unmount();
      vi.useRealTimers();
    });

    it('shows and restarts the 700 ms auto-parse countdown after each text change', async () => {
      vi.useFakeTimers();
      dutySettingsMocks.messageAutoParseEnabled = true;
      directSubmitMocks.parseDirectSubmit.mockResolvedValue({ text: 'parsed text' });
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);

      await act(async () => {
        root.render(
          <ManageMessageDrawer
            open
            cyberEchoEnabled={false}
            currentUser={{ roles: ['Rer'] } as User}
            onClose={vi.fn()}
          />,
        );
        await Promise.resolve();
      });

      const parseButton = Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent === 'Авто-парсинг',
      ) as HTMLButtonElement;

      await act(async () => {
        textFieldPropsByLabel
          .get('Текст повідомлення')
          ?.onChange?.({ target: { value: 'first version' } });
      });

      expect(
        parseButton.querySelector('[data-testid="auto-parse-status"]')?.getAttribute('data-state'),
      ).toBe('debouncing');

      await act(async () => {
        vi.advanceTimersByTime(600);
        textFieldPropsByLabel
          .get('Текст повідомлення')
          ?.onChange?.({ target: { value: 'latest version' } });
      });
      await act(async () => {
        vi.advanceTimersByTime(699);
      });

      expect(directSubmitMocks.parseDirectSubmit).not.toHaveBeenCalled();

      await act(async () => {
        vi.advanceTimersByTime(1);
        await Promise.resolve();
      });

      expect(directSubmitMocks.parseDirectSubmit).toHaveBeenCalledOnce();
      expect(directSubmitMocks.parseDirectSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ full_body: 'latest version' }),
      );

      root.unmount();
      vi.useRealTimers();
    });

    it('ignores stale parse success when edited text returns to the original value', async () => {
      vi.useFakeTimers();
      dutySettingsMocks.messageAutoParseEnabled = true;
      let resolveFirstParse!: (value: any) => void;
      let resolveSecondParse!: (value: any) => void;
      directSubmitMocks.parseDirectSubmit
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveFirstParse = resolve;
            }),
        )
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveSecondParse = resolve;
            }),
        )
        .mockResolvedValueOnce({ text: 'reparsed text' })
        .mockResolvedValueOnce({ text: 'whitespace parsed text' });
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);

      await act(async () => {
        root.render(
          <ManageMessageDrawer
            open
            cyberEchoEnabled={false}
            currentUser={{ roles: ['Rer'] } as User}
            onClose={vi.fn()}
          />,
        );
        await Promise.resolve();
      });

      const parseButton = Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent === 'Авто-парсинг',
      ) as HTMLButtonElement;
      const advancedFieldsButton = Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent === 'Розширені поля',
      );
      await act(async () => {
        advancedFieldsButton?.click();
      });

      await act(async () => {
        textFieldPropsByLabel
          .get('Текст повідомлення')
          ?.onChange?.({ target: { value: 'same version' } });
      });
      await act(async () => {
        vi.advanceTimersByTime(700);
        await Promise.resolve();
      });
      expect(directSubmitMocks.parseDirectSubmit).toHaveBeenCalledOnce();

      await act(async () => {
        textFieldPropsByLabel
          .get('Текст повідомлення')
          ?.onChange?.({ target: { value: 'different version' } });
        textFieldPropsByLabel
          .get('Текст повідомлення')
          ?.onChange?.({ target: { value: 'same version' } });
      });

      expect(parseButton.querySelector('[data-testid="check-icon"]')).toBeNull();
      expect(
        parseButton.querySelector('[data-testid="auto-parse-status"]')?.getAttribute('data-state'),
      ).toBe('debouncing');

      await act(async () => {
        resolveFirstParse({ text: 'stale parsed text' });
        await Promise.resolve();
      });
      expect(parseButton.querySelector('[data-testid="check-icon"]')).toBeNull();
      expect(textFieldPropsByLabel.get('Коротке повідомлення')?.value ?? '').toBe('');

      await act(async () => {
        vi.advanceTimersByTime(700);
        await Promise.resolve();
      });
      expect(directSubmitMocks.parseDirectSubmit).toHaveBeenCalledTimes(2);
      expect(directSubmitMocks.parseDirectSubmit).toHaveBeenLastCalledWith(
        expect.objectContaining({ full_body: 'same version' }),
      );

      await act(async () => {
        resolveSecondParse({ text: 'latest parsed text' });
        await Promise.resolve();
      });
      expect(parseButton.querySelector('[data-testid="check-icon"]')).not.toBeNull();
      expect(textFieldPropsByLabel.get('Коротке повідомлення')?.value).toBe('latest parsed text');

      await act(async () => {
        textFieldPropsByLabel
          .get('Текст повідомлення')
          ?.onChange?.({ target: { value: 'temporary edit' } });
        textFieldPropsByLabel
          .get('Текст повідомлення')
          ?.onChange?.({ target: { value: 'same version' } });
      });
      expect(parseButton.querySelector('[data-testid="check-icon"]')).toBeNull();
      expect(
        parseButton.querySelector('[data-testid="auto-parse-status"]')?.getAttribute('data-state'),
      ).toBe('debouncing');

      await act(async () => {
        vi.advanceTimersByTime(700);
        await Promise.resolve();
      });
      expect(directSubmitMocks.parseDirectSubmit).toHaveBeenCalledTimes(3);

      await act(async () => {
        textFieldPropsByLabel
          .get('Текст повідомлення')
          ?.onChange?.({ target: { value: 'same version ' } });
      });
      expect(
        parseButton.querySelector('[data-testid="auto-parse-status"]')?.getAttribute('data-state'),
      ).toBe('debouncing');

      await act(async () => {
        vi.advanceTimersByTime(700);
        await Promise.resolve();
      });
      expect(directSubmitMocks.parseDirectSubmit).toHaveBeenCalledTimes(4);
      expect(directSubmitMocks.parseDirectSubmit).toHaveBeenLastCalledWith(
        expect.objectContaining({ full_body: 'same version' }),
      );

      root.unmount();
      vi.useRealTimers();
    });

    it('shows spinner in parse button while parse is in flight', async () => {
      let resolveParse!: (value: any) => void;
      directSubmitMocks.parseDirectSubmit.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveParse = resolve;
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
            currentUser={{ roles: ['Rer'] } as User}
            onClose={vi.fn()}
          />,
        );
        await Promise.resolve();
      });

      await act(async () => {
        textFieldPropsByLabel
          .get('Текст повідомлення')
          ?.onChange?.({ target: { value: 'test parse' } });
      });

      const parseButton = Array.from(container.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('Розпарсити'),
      ) as HTMLButtonElement;

      await act(async () => {
        parseButton.click();
        await Promise.resolve();
      });

      expect(parseButton.disabled).toBe(true);
      expect(parseButton.querySelector('[data-testid="spinner"]')).not.toBeNull();

      await act(async () => {
        resolveParse({ text: 'parsed' });
        await Promise.resolve();
      });

      expect(parseButton.querySelector('[data-testid="spinner"]')).toBeNull();
      expect(parseButton.querySelector('[data-testid="check-icon"]')).not.toBeNull();

      root.unmount();
    });

    it('keeps success checkmark until text changes, then restores standard icon', async () => {
      directSubmitMocks.parseDirectSubmit.mockResolvedValue({ text: 'parsed text' });

      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);

      await act(async () => {
        root.render(
          <ManageMessageDrawer
            open
            cyberEchoEnabled={false}
            currentUser={{ roles: ['Rer'] } as User}
            onClose={vi.fn()}
          />,
        );
        await Promise.resolve();
      });

      await act(async () => {
        textFieldPropsByLabel
          .get('Текст повідомлення')
          ?.onChange?.({ target: { value: 'test parse' } });
      });

      const parseButton = Array.from(container.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('Розпарсити'),
      ) as HTMLButtonElement;

      await act(async () => {
        parseButton.click();
        await Promise.resolve();
      });

      expect(parseButton.querySelector('[data-testid="check-icon"]')).not.toBeNull();

      // Typing more text resets the checkmark
      await act(async () => {
        textFieldPropsByLabel
          .get('Текст повідомлення')
          ?.onChange?.({ target: { value: 'test parse modified' } });
      });

      expect(parseButton.querySelector('[data-testid="check-icon"]')).toBeNull();

      root.unmount();
    });

    it('shows error icon when parsing fails, and clears it when text changes', async () => {
      directSubmitMocks.parseDirectSubmit.mockRejectedValue(new Error('Parse failure'));

      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);

      await act(async () => {
        root.render(
          <ManageMessageDrawer
            open
            cyberEchoEnabled={false}
            currentUser={{ roles: ['Rer'] } as User}
            onClose={vi.fn()}
          />,
        );
        await Promise.resolve();
      });

      await act(async () => {
        textFieldPropsByLabel
          .get('Текст повідомлення')
          ?.onChange?.({ target: { value: 'invalid text' } });
      });

      const parseButton = Array.from(container.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('Розпарсити'),
      ) as HTMLButtonElement;

      await act(async () => {
        parseButton.click();
        await Promise.resolve();
      });

      expect(parseButton.querySelector('[data-testid="error-icon"]')).not.toBeNull();

      // Changing text resets the error icon
      await act(async () => {
        textFieldPropsByLabel
          .get('Текст повідомлення')
          ?.onChange?.({ target: { value: 'fixed text' } });
      });

      expect(parseButton.querySelector('[data-testid="error-icon"]')).toBeNull();

      root.unmount();
    });

    it('updates date and time when they disappear from parsed text', async () => {
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);

      await act(async () => {
        root.render(
          <ManageMessageDrawer
            open
            cyberEchoEnabled={false}
            currentUser={{ roles: ['Rer'] } as User}
            onClose={vi.fn()}
          />,
        );
        await Promise.resolve();
      });

      directSubmitMocks.parseDirectSubmit.mockResolvedValueOnce({
        text: 'test',
        timestamp: '2026-09-01T05:50:00Z',
        is_time_null: false,
      });

      await act(async () => {
        textFieldPropsByLabel
          .get('Текст повідомлення')
          ?.onChange?.({ target: { value: '123 прк | 2026-09-01\n05-50' } });
      });

      const parseButton = Array.from(container.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('Розпарсити'),
      ) as HTMLButtonElement;

      await act(async () => {
        parseButton.click();
        await Promise.resolve();
      });

      expect(pickerValuesByLabel.get('Час перехоплення')).not.toBeNull();
      expect(pickerValuesByLabel.get('Дата перехоплення')).not.toBeNull();

      directSubmitMocks.parseDirectSubmit.mockResolvedValueOnce({
        text: 'test',
        timestamp: '2026-09-01T00:00:00Z',
        is_time_null: true,
      });

      await act(async () => {
        textFieldPropsByLabel
          .get('Текст повідомлення')
          ?.onChange?.({ target: { value: '123 прк | 2026-09-01' } });
      });

      await act(async () => {
        parseButton.click();
        await Promise.resolve();
      });

      expect(pickerValuesByLabel.get('Дата перехоплення')).not.toBeNull();
      expect(pickerValuesByLabel.get('Час перехоплення')).toBeNull();

      directSubmitMocks.parseDirectSubmit.mockResolvedValueOnce({ text: 'test' });
      await act(async () => {
        textFieldPropsByLabel
          .get('Текст повідомлення')
          ?.onChange?.({ target: { value: '123 прк без дати' } });
      });
      await act(async () => {
        parseButton.click();
        await Promise.resolve();
      });

      expect(
        dayjs(pickerValuesByLabel.get('Дата перехоплення') as dayjs.ConfigType).isSame(
          dayjs(),
          'day',
        ),
      ).toBe(true);
      expect(pickerValuesByLabel.get('Час перехоплення')).toBeNull();

      root.unmount();
    });

    it('clears the coordinate list when parsing no longer finds coordinates', async () => {
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);

      await act(async () => {
        root.render(
          <ManageMessageDrawer
            open
            cyberEchoEnabled={false}
            currentUser={{ roles: ['Rer'] } as User}
            onClose={vi.fn()}
          />,
        );
        await Promise.resolve();
      });

      directSubmitMocks.parseDirectSubmit.mockResolvedValueOnce({
        text: 'test',
        coords: [{ lat: 49.123457, lon: 37.234568 }],
        to: [],
        locations: [],
      });
      await act(async () => {
        textFieldPropsByLabel
          .get('Текст повідомлення')
          ?.onChange?.({ target: { value: 'Повідомлення з координатами' } });
      });

      const parseButton = Array.from(container.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('Розпарсити'),
      ) as HTMLButtonElement;
      await act(async () => {
        parseButton.click();
        await Promise.resolve();
      });
      expect(container.querySelector('button[aria-label="Видалити координату 1"]')).not.toBeNull();

      directSubmitMocks.parseDirectSubmit.mockResolvedValueOnce({
        text: 'test',
        coords: [],
        to: [],
        locations: [],
      });
      await act(async () => {
        textFieldPropsByLabel
          .get('Текст повідомлення')
          ?.onChange?.({ target: { value: 'Повідомлення без координат' } });
      });
      await act(async () => {
        parseButton.click();
        await Promise.resolve();
      });

      expect(container.querySelector('button[aria-label="Видалити координату 1"]')).toBeNull();
      expect(container.textContent).toContain('Координати ще не додані');

      root.unmount();
    });

    it('restores initial create values when source becomes empty without manual field changes', async () => {
      vi.useFakeTimers();
      setRecentValues({
        group: ['g-1'],
        unit: ['Початковий підрозділ'],
        deviceName: ['Початковий пристрій'],
      });
      referenceDataMocks.getUserSigintGroups.mockResolvedValue(['g-1']);
      referenceDataMocks.getGroupInfosBatch.mockResolvedValue([
        { masterKey: 'g-1', name: 'Group 1' },
      ]);
      dutySettingsMocks.messageAutoParseEnabled = true;
      directSubmitMocks.parseDirectSubmit.mockResolvedValue({
        text: 'parsed',
        freq: '149.500',
        unit_v2: 'Розпізнаний підрозділ',
        timestamp: '2026-09-16T05:52:00Z',
        coords: [{ lat: 49.123457, lon: 37.234568 }],
        to: [],
        locations: [],
      });
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);

      await act(async () => {
        root.render(
          <ManageMessageDrawer
            open
            cyberEchoEnabled
            currentUser={{ roles: ['Rer'] } as User}
            onClose={vi.fn()}
          />,
        );
        await Promise.resolve();
      });

      await act(async () => {
        textFieldPropsByLabel
          .get('Текст повідомлення')
          ?.onChange?.({ target: { value: '49.123457, 37.234568' } });
      });
      await act(async () => {
        vi.advanceTimersByTime(700);
        await Promise.resolve();
      });

      expect(autocompleteValuesByLabel.get('Частота (МГц)')).toBe('149.500');
      expect(autocompleteValuesByLabel.get('Підрозділ')).toBe('Розпізнаний підрозділ');
      expect(pickerValuesByLabel.get('Час перехоплення')).not.toBeNull();

      await act(async () => {
        textFieldPropsByLabel.get('Текст повідомлення')?.onChange?.({ target: { value: '' } });
        await Promise.resolve();
      });

      expect(autocompleteValuesByLabel.get('Частота (МГц)') ?? '').toBe('');
      expect(autocompleteValuesByLabel.get('Підрозділ')).toEqual({
        id: 1,
        name: 'Початковий підрозділ',
      });
      expect(autocompleteValuesByLabel.get('Назва пристрою')).toBe('Початковий пристрій');
      expect(
        dayjs(pickerValuesByLabel.get('Дата перехоплення') as dayjs.ConfigType).isSame(
          dayjs(),
          'day',
        ),
      ).toBe(true);
      expect(pickerValuesByLabel.get('Час перехоплення')).toBeNull();
      expect(container.textContent).toContain('Координати ще не додані');

      root.unmount();
      vi.useRealTimers();
    });

    it('preserves a manually selected group while resetting parsed fields for an empty source', async () => {
      vi.useFakeTimers();
      referenceDataMocks.getUserSigintGroups.mockResolvedValue(['g-1']);
      referenceDataMocks.getGroupInfosBatch.mockResolvedValue([
        { masterKey: 'g-1', name: 'Group 1' },
      ]);
      dutySettingsMocks.messageAutoParseEnabled = true;
      directSubmitMocks.parseDirectSubmit.mockResolvedValue({
        text: 'parsed',
        freq: '149.500',
        coords: [],
        to: [],
        locations: [],
      });
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);

      await act(async () => {
        root.render(
          <ManageMessageDrawer
            open
            cyberEchoEnabled={false}
            currentUser={{ roles: ['Rer'] } as User}
            onClose={vi.fn()}
          />,
        );
        await Promise.resolve();
      });
      await act(async () => {
        autocompleteOnChangeByLabel.get('Група')?.(null, { masterKey: 'g-1' });
        await Promise.resolve();
      });
      await act(async () => {
        textFieldPropsByLabel
          .get('Текст повідомлення')
          ?.onChange?.({ target: { value: 'частота 149.500' } });
      });
      await act(async () => {
        vi.advanceTimersByTime(700);
        await Promise.resolve();
      });
      expect(autocompleteValuesByLabel.get('Частота (МГц)')).toBe('149.500');

      await act(async () => {
        textFieldPropsByLabel.get('Текст повідомлення')?.onChange?.({ target: { value: '' } });
        await Promise.resolve();
      });

      expect(autocompleteValuesByLabel.get('Частота (МГц)') ?? '').toBe('');
      expect(autocompleteValuesByLabel.get('Група')).toMatchObject([{ masterKey: 'g-1' }]);
      root.unmount();
      vi.useRealTimers();
    });

    it('still restores pristine fields after an inaccessible recent group is cleared internally', async () => {
      vi.useFakeTimers();
      setRecentValues({ group: ['stale-group'] });
      referenceDataMocks.getUserSigintGroups.mockResolvedValue(['g-1']);
      referenceDataMocks.getGroupInfosBatch.mockResolvedValue([
        { masterKey: 'g-1', name: 'Group 1' },
      ]);
      dutySettingsMocks.messageAutoParseEnabled = true;
      directSubmitMocks.parseDirectSubmit.mockResolvedValue({
        text: 'parsed',
        freq: '149.500',
        coords: [],
        to: [],
        locations: [],
      });
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);

      await act(async () => {
        root.render(
          <ManageMessageDrawer
            open
            cyberEchoEnabled={false}
            currentUser={{ roles: ['Rer'] } as User}
            onClose={vi.fn()}
          />,
        );
        await Promise.resolve();
      });
      expect(autocompleteValuesByLabel.get('Група')).toEqual([]);

      await act(async () => {
        textFieldPropsByLabel
          .get('Текст повідомлення')
          ?.onChange?.({ target: { value: 'частота 149.500' } });
      });
      await act(async () => {
        vi.advanceTimersByTime(700);
        await Promise.resolve();
      });
      expect(autocompleteValuesByLabel.get('Частота (МГц)')).toBe('149.500');

      await act(async () => {
        textFieldPropsByLabel.get('Текст повідомлення')?.onChange?.({ target: { value: '' } });
        await Promise.resolve();
      });
      expect(autocompleteValuesByLabel.get('Частота (МГц)') ?? '').toBe('');

      await act(async () => {
        textFieldPropsByLabel
          .get('Текст повідомлення')
          ?.onChange?.({ target: { value: 'новий текст' } });
        await Promise.resolve();
      });
      expect((container.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(
        true,
      );

      root.unmount();
      vi.useRealTimers();
    });

    it('keeps every field unchanged when source becomes empty after a manual field change', async () => {
      vi.useFakeTimers();
      dutySettingsMocks.messageAutoParseEnabled = true;
      directSubmitMocks.parseDirectSubmit.mockResolvedValue({
        text: 'test',
        coords: [{ lat: 49.123457, lon: 37.234568 }],
        to: [],
        locations: [],
      });
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);

      await act(async () => {
        root.render(
          <ManageMessageDrawer
            open
            cyberEchoEnabled
            currentUser={{ roles: ['Rer'] } as User}
            onClose={vi.fn()}
          />,
        );
        await Promise.resolve();
      });

      await act(async () => {
        textFieldPropsByLabel
          .get('Текст повідомлення')
          ?.onChange?.({ target: { value: '49.123457, 37.234568' } });
      });
      await act(async () => {
        vi.advanceTimersByTime(700);
        await Promise.resolve();
      });
      expect(container.querySelector('button[aria-label="Видалити координату 1"]')).not.toBeNull();

      await act(async () => {
        autocompleteOnInputChangeByLabel.get('Назва пристрою')?.(null, 'Ручний пристрій', 'input');
      });

      await act(async () => {
        textFieldPropsByLabel
          .get('Додати координату')
          ?.onChange?.({ target: { value: '49.22346, 37.33457' } });
      });
      await act(async () => {
        textFieldPropsByLabel.get('Додати координату')?.onBlur?.();
        await Promise.resolve();
      });
      expect(container.querySelectorAll('button[aria-label^="Видалити координату"]')).toHaveLength(
        2,
      );

      await act(async () => {
        textFieldPropsByLabel.get('Текст повідомлення')?.onChange?.({ target: { value: '' } });
        await Promise.resolve();
      });

      expect(container.querySelectorAll('button[aria-label^="Видалити координату"]')).toHaveLength(
        2,
      );
      expect(container.textContent).toContain('37U CQ 71194 42681');
      expect(autocompleteValuesByLabel.get('Назва пристрою')).toBe('Ручний пристрій');
      expect(container.textContent).not.toContain('Координати ще не додані');

      root.unmount();
      vi.useRealTimers();
    });

    it('keeps a manually deleted parsed coordinate suppressed on later auto-parse', async () => {
      vi.useFakeTimers();
      dutySettingsMocks.messageAutoParseEnabled = true;
      directSubmitMocks.parseDirectSubmit.mockResolvedValue({
        text: 'test',
        coords: [{ lat: 49.123457, lon: 37.234568 }],
        to: [],
        locations: [],
      });
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);

      await act(async () => {
        root.render(
          <ManageMessageDrawer
            open
            cyberEchoEnabled={false}
            currentUser={{ roles: ['Rer'] } as User}
            onClose={vi.fn()}
          />,
        );
        await Promise.resolve();
      });
      await act(async () => {
        textFieldPropsByLabel
          .get('Текст повідомлення')
          ?.onChange?.({ target: { value: '49.123457, 37.234568 перша версія' } });
      });
      await act(async () => {
        vi.advanceTimersByTime(700);
        await Promise.resolve();
      });
      expect(container.querySelector('button[aria-label="Видалити координату 1"]')).not.toBeNull();

      await act(async () => {
        container
          .querySelector<HTMLButtonElement>('button[aria-label="Видалити координату 1"]')
          ?.click();
      });
      expect(container.textContent).toContain('Координати ще не додані');

      await act(async () => {
        textFieldPropsByLabel
          .get('Текст повідомлення')
          ?.onChange?.({ target: { value: '49.123457, 37.234568 друга версія' } });
      });
      await act(async () => {
        vi.advanceTimersByTime(700);
        await Promise.resolve();
      });

      expect(container.textContent).toContain('Координати ще не додані');
      expect(container.querySelector('button[aria-label="Видалити координату 1"]')).toBeNull();

      root.unmount();
      vi.useRealTimers();
    });

    it('clears parsed coordinates when manually parsing empty message text', async () => {
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);

      await act(async () => {
        root.render(
          <ManageMessageDrawer
            open
            cyberEchoEnabled={false}
            currentUser={{ roles: ['Rer'] } as User}
            onClose={vi.fn()}
          />,
        );
        await Promise.resolve();
      });

      directSubmitMocks.parseDirectSubmit.mockResolvedValueOnce({
        text: 'test',
        coords: [{ lat: 49.123457, lon: 37.234568 }],
        to: [],
        locations: [],
      });
      await act(async () => {
        textFieldPropsByLabel
          .get('Текст повідомлення')
          ?.onChange?.({ target: { value: '49.123457, 37.234568' } });
      });

      const parseButton = Array.from(container.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('Розпарсити'),
      ) as HTMLButtonElement;
      await act(async () => {
        parseButton.click();
        await Promise.resolve();
      });
      expect(container.querySelector('button[aria-label="Видалити координату 1"]')).not.toBeNull();

      await act(async () => {
        textFieldPropsByLabel.get('Текст повідомлення')?.onChange?.({ target: { value: '' } });
      });
      await act(async () => {
        parseButton.click();
        await Promise.resolve();
      });

      expect(container.querySelector('button[aria-label="Видалити координату 1"]')).toBeNull();
      expect(container.textContent).toContain('Координати ще не додані');

      root.unmount();
    });
  });

  describe('minimal report window', () => {
    const minimalPayload = {
      full_body: 'original copied body',
      text: 'original copied body',
      to: [],
      retained_media_ids: ['media-1'],
      parent_signal_message_ids: [42],
    };
    const minimalHosts: HTMLElement[] = [];

    function setUpMinimalReport(payload: Record<string, unknown> = minimalPayload) {
      aiIntelReportMocks.quickIntelReportSuggestion.mockClear();
      directSubmitMocks.submitDirect.mockClear();
      directSubmitMocks.submitDirect.mockResolvedValue({ signal_message_id: 91 });
      directSubmitMocks.copyDirectSubmit.mockResolvedValue({ payloads: [payload] });
      const container = document.createElement('div');
      const host = document.createElement('div');
      document.body.append(container, host);
      minimalHosts.push(container, host);
      const onExpand = vi.fn();
      return { container, host, onExpand, root: createRoot(container) };
    }

    function reportDrawer(
      minimalReport: { host: HTMLElement; onExpand: () => void } | null,
      extraProps: Partial<ComponentProps<typeof ManageMessageDrawer>> = {},
    ) {
      return (
        <ManageMessageDrawer
          open
          presentation="embedded"
          cyberEchoEnabled={false}
          currentUser={{ roles: ['Rer'] } as User}
          onClose={vi.fn()}
          reportSource={{
            id: 42,
            message: buildMessage({
              text: 'original card body',
              media: [
                {
                  id: 'media-1',
                  contentType: 'image/jpeg',
                  fileName: 'photo.jpg',
                  sizeBytes: 10,
                  href: '/media/photo.jpg',
                  transcription: null,
                } as InboxMessage['media'][number],
              ],
            }),
          }}
          minimalReport={minimalReport}
          {...extraProps}
        />
      );
    }

    async function typeReport(value: string) {
      await act(async () => {
        textFieldPropsByLabel.get('Текст розвіддонесення')?.onChange?.({ target: { value } });
        await Promise.resolve();
      });
    }

    async function submitMinimalReport(host: HTMLElement) {
      await act(async () => {
        host
          .querySelector('form')!
          .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await Promise.resolve();
        await Promise.resolve();
      });
    }

    afterEach(() => {
      minimalHosts.splice(0).forEach((element) => element.remove());
    });

    it('shows only the original and report text inside the feed host', async () => {
      const { container, host, onExpand, root } = setUpMinimalReport();
      await act(async () => root.render(reportDrawer({ host, onExpand })));

      const panel = host.querySelector('[data-manage-message-presentation="minimal"]');
      expect(panel).not.toBeNull();
      expect(container.querySelector('[data-manage-message-presentation]')).toBeNull();
      expect(panel?.textContent).toContain('Створити розвіддонесення');
      expect(panel?.textContent).toContain('original copied body');
      expect(panel?.textContent).toContain('Без надсилання в групу.');
      expect(textFieldPropsByLabel.has('Текст розвіддонесення')).toBe(true);
      expect(textFieldPropsByLabel.has('Текст оригінального повідомлення')).toBe(false);
      expect(textFieldPropsByLabel.has('Відправити в групу')).toBe(false);
      expect(aiIntelReportMocks.quickIntelReportSuggestion).not.toHaveBeenCalled();
      await act(async () => {
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      });
      expect(document.activeElement).toBe(
        host.querySelector('textarea[aria-label="Текст розвіддонесення"]'),
      );

      await act(async () => {
        (host.querySelector('button[aria-label^="Розгорнути"]') as HTMLButtonElement).click();
      });
      expect(onExpand).toHaveBeenCalledTimes(1);
      await act(async () => root.unmount());
    });

    it('never sends a text-only report to a group and keeps source attachments', async () => {
      referenceDataMocks.getUserSigintGroups.mockResolvedValue(['g-1']);
      referenceDataMocks.getGroupInfosBatch.mockResolvedValue([
        { masterKey: 'g-1', name: 'Group 1' },
      ]);
      const { host, onExpand, root } = setUpMinimalReport();
      await act(async () => root.render(reportDrawer({ host, onExpand })));

      await typeReport('quick report');
      await submitMinimalReport(host);

      expect(onExpand).not.toHaveBeenCalled();
      expect(directSubmitMocks.submitDirect).toHaveBeenCalledWith(
        expect.objectContaining({
          full_body: 'quick report',
          signal_group_master_key: null,
          retained_media_ids: ['media-1'],
          parent_signal_message_ids: [42],
        }),
      );
      await act(async () => root.unmount());
    });

    it('keeps the draft on expand, still asks for a group and starts AI suggestions', async () => {
      referenceDataMocks.getUserSigintGroups.mockResolvedValue(['g-1']);
      referenceDataMocks.getGroupInfosBatch.mockResolvedValue([
        { masterKey: 'g-1', name: 'Group 1' },
      ]);
      const { container, host, onExpand, root } = setUpMinimalReport();
      await act(async () => root.render(reportDrawer({ host, onExpand })));
      await typeReport('draft that must survive');

      await act(async () => root.render(reportDrawer(null)));

      expect(host.querySelector('[data-manage-message-presentation]')).toBeNull();
      expect(
        container.querySelector('[data-manage-message-presentation="embedded"]'),
      ).not.toBeNull();
      expect(textFieldPropsByLabel.get('Текст розвіддонесення')?.value).toBe(
        'draft that must survive',
      );
      expect(autocompleteValuesByLabel.get('Відправити в групу')).toBeNull();
      expect(directSubmitMocks.copyDirectSubmit).toHaveBeenCalledTimes(1);
      expect(aiIntelReportMocks.quickIntelReportSuggestion).toHaveBeenCalledTimes(1);
      await act(async () => root.unmount());
    });

    it('expands instead of hiding a pasted attachment', async () => {
      const { host, onExpand, root } = setUpMinimalReport();
      await act(async () => root.render(reportDrawer({ host, onExpand })));
      const paste = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(paste, 'clipboardData', {
        value: {
          items: [
            {
              kind: 'file',
              getAsFile: () => new File(['image'], 'pasted.png', { type: 'image/png' }),
            },
          ],
        },
      });

      await act(async () => {
        host.querySelector('textarea')?.dispatchEvent(paste);
        await Promise.resolve();
      });

      expect(paste.defaultPrevented).toBe(true);
      expect(onExpand).toHaveBeenCalledTimes(1);
      await act(async () => root.unmount());
    });

    const fullReportSource = {
      id: 42,
      message: buildMessage({
        media: Array.from({ length: 20 }, (_, index) => ({
          id: `media-${index}`,
          contentType: 'image/jpeg',
          fileName: `photo-${index}.jpg`,
          sizeBytes: 10,
          href: `/media/${index}.jpg`,
          transcription: null,
        })) as InboxMessage['media'],
      }),
    };

    async function pasteRejectedFile(host: HTMLElement) {
      const paste = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(paste, 'clipboardData', {
        value: {
          items: [
            {
              kind: 'file',
              getAsFile: () => new File(['image'], 'over-limit.png', { type: 'image/png' }),
            },
          ],
        },
      });
      await act(async () => {
        host.querySelector('textarea')?.dispatchEvent(paste);
        await Promise.resolve();
      });
      return paste;
    }

    it('expands to show a rejected pasted attachment', async () => {
      const { host, onExpand, root } = setUpMinimalReport();
      await act(async () =>
        root.render(reportDrawer({ host, onExpand }, { reportSource: fullReportSource })),
      );

      const paste = await pasteRejectedFile(host);

      expect(paste.defaultPrevented).toBe(true);
      expect(onExpand).toHaveBeenCalledTimes(1);
      await act(async () => root.unmount());
    });

    it('does not carry a rejected attachment into the next report after closing', async () => {
      const { host, onExpand, root } = setUpMinimalReport();
      const ref = createRef<ManageMessageEditorHandle>();
      const nextReport = { id: 43, message: buildMessage({ text: 'next source' }) };
      await act(async () =>
        root.render(reportDrawer({ host, onExpand }, { ref, reportSource: fullReportSource })),
      );
      await pasteRejectedFile(host);
      expect(onExpand).toHaveBeenCalledTimes(1);

      await act(async () => ref.current?.closeWithoutConfirmation());
      await act(async () =>
        root.render(reportDrawer(null, { ref, open: false, reportSource: null })),
      );
      // The Duty page builds a new expand callback for every intent.
      const expandNext = vi.fn();
      await act(async () =>
        root.render(
          reportDrawer(
            { host, onExpand: expandNext },
            { ref, reportSource: nextReport, intentKey: 'create-report:43' },
          ),
        ),
      );

      expect(expandNext).not.toHaveBeenCalled();
      await act(async () => root.unmount());
    });

    it('does not carry a rejected attachment into a replacing report', async () => {
      const { host, onExpand, root } = setUpMinimalReport();
      const ref = createRef<ManageMessageEditorHandle>();
      const nextReport = { id: 43, message: buildMessage({ text: 'next source' }) };
      const firstIntent = { ref, reportSource: fullReportSource, intentKey: 'create-report:42' };
      await act(async () => root.render(reportDrawer({ host, onExpand }, firstIntent)));
      await pasteRejectedFile(host);
      const expandNext = vi.fn();

      await act(async () => {
        ref.current?.requestIntentChange({
          key: 'create-report:43',
          commit: () =>
            root.render(
              reportDrawer(
                { host, onExpand: expandNext },
                { ref, reportSource: nextReport, intentKey: 'create-report:43' },
              ),
            ),
        });
      });

      expect(expandNext).not.toHaveBeenCalled();
      await act(async () => root.unmount());
    });

    it('expands when a field hidden by the panel fails validation', async () => {
      const { host, onExpand, root } = setUpMinimalReport({
        ...minimalPayload,
        freq: 'not-a-freq',
      });
      await act(async () => root.render(reportDrawer({ host, onExpand })));

      await typeReport('quick report');
      await submitMinimalReport(host);

      expect(directSubmitMocks.submitDirect).not.toHaveBeenCalled();
      expect(onExpand).toHaveBeenCalledTimes(1);
      await act(async () => root.unmount());
    });

    it('explains why an unresolved unit blocks the panel', async () => {
      const { host, onExpand, root } = setUpMinimalReport({
        ...minimalPayload,
        unit: 'Невизначений підрозділ',
        unit_id: 0,
      });
      await act(async () => root.render(reportDrawer({ host, onExpand })));

      await typeReport('quick report');

      expect(host.textContent).toContain('Потрібні додаткові поля: розгорніть панель.');
      expect((host.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(
        true,
      );
      await act(async () => root.unmount());
    });

    it('edits a report in place without changing its group', async () => {
      directSubmitMocks.editDirectSubmit.mockClear();
      directSubmitMocks.editDirectSubmit.mockResolvedValue({ signal_message_id: 7 });
      const { host, onExpand, root } = setUpMinimalReport();
      await act(async () =>
        root.render(
          reportDrawer(
            { host, onExpand },
            {
              reportSource: null,
              editAsReport: true,
              editTarget: {
                id: 7,
                message: buildMessage({ text: 'old report', groupMasterKey: 'g-1' }),
              },
            },
          ),
        ),
      );

      expect(host.textContent).toContain('Редагувати розвіддонесення');
      expect(host.textContent).toContain('Зберегти');
      expect(host.textContent).not.toContain('Без надсилання в групу.');
      await typeReport('edited report');
      await submitMinimalReport(host);

      expect(directSubmitMocks.editDirectSubmit).toHaveBeenCalledWith(
        7,
        expect.objectContaining({ full_body: 'edited report', signal_group_master_key: 'g-1' }),
      );
      await act(async () => root.unmount());
    });
  });
});
