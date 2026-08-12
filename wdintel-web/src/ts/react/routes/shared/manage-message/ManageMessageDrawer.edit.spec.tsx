/**
 * @vitest-environment happy-dom
 */
import type { ReactNode } from 'react';
import { act, forwardRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InboxMessage } from '../../../../../Bindings';

const referenceDataMocks = vi.hoisted(() => ({
  getUserSigintGroups: vi.fn().mockResolvedValue([]),
  getGroupInfosBatch: vi.fn().mockResolvedValue([]),
  getTagsForDisplay: vi.fn().mockResolvedValue({ tagsMap: {}, tagsOrder: [] }),
}));
const directSubmitMocks = vi.hoisted(() => ({
  submitDirect: vi.fn().mockResolvedValue({ signal_message_id: 1 }),
  editDirectSubmit: vi.fn(),
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
const uppyMocks = vi.hoisted(() => ({
  latest: null as {
    emitUploadProgress: (percentage: number) => void;
    emitUploadSuccess: () => void;
  } | null,
}));

vi.mock('../../../services/api/inbox-reference-data', () => ({
  getUserSigintGroups: referenceDataMocks.getUserSigintGroups,
  getGroupInfosBatch: referenceDataMocks.getGroupInfosBatch,
  getTagsForDisplay: referenceDataMocks.getTagsForDisplay,
}));
vi.mock('../../../services/api/direct-submit', () => ({
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
  formatDirectSubmitError: (error: unknown) =>
    error instanceof Error ? error.message : 'save failed',
}));
vi.mock('../../../services/api/networks', () => ({
  getNetworksByIds: networkMocks.getNetworksByIds,
}));
vi.mock('../../../services/api/units', () => ({
  getUnitsByIds: unitMocks.getUnitsByIds,
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
    removeFile(id: string) {
      this.files = this.files.filter((file) => file.id !== id);
      this.listeners.get('file-removed')?.forEach((callback) => callback());
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
vi.mock('./drawer-sections/CoordinateInputPreview', () => ({ CoordinateInputPreview: () => null }));

vi.mock('../../../components/PowerDateTimePicker', () => ({
  PowerDatePicker: ({ label, value }: { label?: string; value?: unknown }) => {
    if (label) pickerValuesByLabel.set(label, value);
    return <div>{label}</div>;
  },
}));
vi.mock('../../../components/PowerAlert', () => ({
  PowerAlert: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock('../../../components/loadingOverlayStyles', () => ({
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
  onChange?: (event: { target: { value: string } }) => void;
  onBlur?: () => void;
  onKeyDown?: (event: KeyboardEvent) => void;
  placeholder?: string;
  value?: string;
  disabled?: boolean;
};

const textFieldPropsByLabel = new Map<string | undefined, TextFieldMockProps>();
const autocompleteOnChangeByLabel = new Map<string, (event: unknown, value: unknown) => void>();
const autocompleteValuesByLabel = new Map<string, unknown>();
const autocompleteInputValuesByLabel = new Map<string, string>();
const autocompleteOptionLabelsByLabel = new Map<string, string[]>();
const pickerValuesByLabel = new Map<string, unknown>();

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
  Typography: ({ children, component = 'div' }: { children?: ReactNode; component?: string }) => {
    const Component = component as keyof HTMLElementTagNameMap;
    return <Component>{children}</Component>;
  },
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
    onChange,
    onBlur,
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
      onBlur,
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
        onBlur={onBlur}
        onKeyDown={onKeyDown as never}
      />
    ) : (
      <input
        aria-label={labelKey}
        placeholder={placeholder}
        value={value ?? ''}
        disabled={disabled}
        onChange={(event) => onChange?.(event as never)}
        onBlur={onBlur}
        onKeyDown={onKeyDown as never}
      />
    );
  },
  Autocomplete: ({
    renderInput,
    value,
    inputValue,
    onChange,
    options,
    getOptionLabel,
    loading: _loading,
  }: {
    renderInput?: (params: unknown) => ReactNode;
    value?: unknown;
    inputValue?: string;
    onChange?: (event: unknown, value: unknown) => void;
    options?: unknown[];
    getOptionLabel?: (option: unknown) => string;
    loading?: boolean;
  }) => {
    const input = renderInput?.({ InputProps: {} } as never);
    const label = (input as { props?: { label?: unknown } } | undefined)?.props?.label;
    if (typeof label === 'string' && onChange) {
      autocompleteOnChangeByLabel.set(label, onChange);
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
    deviceName: null,
    ...overrides,
  } as InboxMessage;
}

describe('ManageMessageDrawer edit mode', () => {
  afterEach(() => {
    textFieldPropsByLabel.clear();
    autocompleteOnChangeByLabel.clear();
    autocompleteValuesByLabel.clear();
    autocompleteInputValuesByLabel.clear();
    autocompleteOptionLabelsByLabel.clear();
    pickerValuesByLabel.clear();
    directSubmitMocks.submitDirect.mockReset();
    directSubmitMocks.submitDirect.mockResolvedValue({ signal_message_id: 1 });
    directSubmitMocks.editDirectSubmit.mockReset();
    directSubmitMocks.createDeviceName.mockReset();
    directSubmitMocks.createDeviceName.mockResolvedValue({ id: 1 });
    directSubmitMocks.parseDirectSubmit.mockReset();
    directSubmitMocks.searchNetworkNames.mockReset();
    directSubmitMocks.searchNetworkNames.mockResolvedValue([]);
    networkMocks.getNetworksByIds.mockReset();
    networkMocks.getNetworksByIds.mockResolvedValue([]);
    unitMocks.getUnitsByIds.mockReset();
    unitMocks.getUnitsByIds.mockResolvedValue([]);
    document.body.innerHTML = '';
    referenceDataMocks.getTagsForDisplay.mockResolvedValue({ tagsMap: {}, tagsOrder: [] });
    referenceDataMocks.getUserSigintGroups.mockReset();
    referenceDataMocks.getGroupInfosBatch.mockReset();
    referenceDataMocks.getUserSigintGroups.mockResolvedValue([]);
    referenceDataMocks.getGroupInfosBatch.mockResolvedValue([]);
    setRecentValues({});
    uppyMocks.latest = null;
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
      dispatchShortcut();
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
