/**
 * @vitest-environment happy-dom
 */
import { act, useState } from 'react';
import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    destroy() {
      this.cancelAll();
    }
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
  Dialog: ({ children, open }: { children?: ReactNode; open?: boolean }) =>
    open ? <div role="dialog">{children}</div> : null,
  DialogActions: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogContentText: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
  DialogTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
  Drawer: ({ children, open }: { children?: ReactNode; open?: boolean }) =>
    open ? <div role="dialog">{children}</div> : null,
  Menu: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  MenuItem: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
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
  createTheme: () => ({
    palette: {
      background: { default: '#121212' },
      mode: 'dark',
    },
  }),
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

import { ManageMessageDrawer } from '../shared/manage-message/ManageMessageDrawer';

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

function Harness() {
  const [open, setOpen] = useState(true);

  return (
    <>
      <ManageMessageDrawer
        open={open}
        cyberEchoEnabled
        currentUser={null}
        onClose={() => setOpen(false)}
        onCreated={() => setOpen(false)}
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

  it('closes the composer after successful direct submission', async () => {
    submitDirect.mockResolvedValueOnce({
      signal_message_id: 101,
    });
    await mountHarness();

    expect(container.textContent).toContain('Створити повідомлення');
    await submitComposer();

    expect(container.textContent).not.toContain('Створити повідомлення');
    expect(submitDirect).toHaveBeenCalledTimes(1);
    expect(container.querySelector('form')).toBeNull();
  });

  it('closes the rendered composer when the host creation callback rejects', async () => {
    const containerLocal = document.createElement('div');
    document.body.appendChild(containerLocal);
    const rootLocal = createRoot(containerLocal);
    const onCreated = vi.fn().mockRejectedValue(new Error('creation callback failed'));
    submitDirect.mockResolvedValueOnce({
      signal_message_id: 505,
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
    expect(containerLocal.textContent).not.toContain('creation callback failed');
    expect(containerLocal.textContent).not.toContain('Сталася помилка');
    expect(containerLocal.querySelector('[role="dialog"]')).toBeNull();

    await act(async () => {
      rootLocal.unmount();
    });
  });
});
