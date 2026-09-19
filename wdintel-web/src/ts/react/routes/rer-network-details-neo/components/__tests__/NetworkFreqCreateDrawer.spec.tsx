/**
 * @vitest-environment happy-dom
 */
import { act, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const apiMock = vi.hoisted(() => ({
  createKey: vi.fn(),
  listKeys: vi.fn(),
}));

vi.mock('@mui/material', () => ({
  Box: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Button: ({
    children,
    disabled,
    onClick,
  }: {
    children?: ReactNode;
    disabled?: boolean;
    onClick?: () => void;
  }) => (
    <button type="button" disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
  ButtonBase: ({
    children,
    disabled,
    onClick,
  }: {
    children?: ReactNode;
    disabled?: boolean;
    onClick?: () => void;
  }) => (
    <button type="button" disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
  ButtonGroup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  CircularProgress: () => <span data-testid="spinner" />,
  Dialog: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogActions: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Drawer: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  FormControl: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  InputLabel: ({ children, shrink }: { children?: ReactNode; shrink?: boolean }) => (
    <label data-shrink={shrink ? 'true' : 'false'}>{children}</label>
  ),
  MenuItem: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Select: ({
    children,
    value,
    renderValue,
    inputProps,
    labelId,
    id,
    ...props
  }: {
    children?: ReactNode;
    value?: string;
    renderValue?: (value: unknown) => ReactNode;
    inputProps?: { name?: string };
    labelId?: string;
    id?: string;
    [key: string]: any;
  }) => (
    <div
      data-value={value}
      data-label-id={labelId}
      data-id={id}
      data-name={inputProps?.name}
      {...props}
    >
      {typeof renderValue === 'function' ? renderValue(value) : children}
    </div>
  ),
  Stack: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  TextField: ({
    label,
    value,
    onChange,
    onBlur,
    placeholder,
    readOnly,
    required,
    disabled,
    inputProps,
    helperText,
  }: {
    label?: ReactNode;
    value?: string;
    onChange?: (event: any) => void;
    onBlur?: () => void;
    placeholder?: string;
    readOnly?: boolean;
    required?: boolean;
    disabled?: boolean;
    inputProps?: { readOnly?: boolean };
    helperText?: ReactNode;
  }) => (
    <label>
      <span>
        {label}
        {required ? ' *' : ''}
      </span>
      <input
        aria-label={typeof label === 'string' ? label : undefined}
        placeholder={placeholder}
        value={value ?? ''}
        onChange={onChange}
        onBlur={onBlur}
        readOnly={inputProps?.readOnly ?? readOnly ?? onChange === undefined}
        disabled={disabled ?? false}
      />
      {helperText ? <div data-testid="helper-text">{helperText}</div> : null}
    </label>
  ),
  Typography: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock('../../../../components/PowerAlert', () => ({
  PowerAlert: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock('../../../../components/PowerChip', () => ({
  PowerChip: ({
    label,
    selected,
    onClick,
  }: {
    label: ReactNode;
    selected?: boolean;
    onClick?: () => void;
  }) => (
    <button type="button" data-selected={selected ? 'true' : 'false'} onClick={onClick}>
      {label}
    </button>
  ),
}));

vi.mock('../../../../services/api/networks', () => ({
  createKey: apiMock.createKey,
  listKeys: apiMock.listKeys,
}));

vi.mock('../../../../components/loadingOverlayStyles', () => ({
  pageDrawerBackdropSx: () => ({}),
}));

vi.mock('.././NetworkFreqActivityPeriodControl', () => ({
  NetworkFreqActivityPeriodControl: ({
    activeFrom,
    activeTo,
  }: {
    activeFrom: string;
    activeTo: string;
  }) => <div data-testid="activity-period">Активна з{`${activeFrom}|${activeTo}`}</div>,
}));

vi.mock('.././NetworkFreqKeysSection', () => ({
  NetworkFreqKeysSection: () => <div data-testid="keys-section" />,
}));

import { NetworkFreqCreateDrawer } from '.././NetworkFreqCreateDrawer';
import type { NetworkFreqCreateWizardForm } from '../../use-rer-network-details-neo-page.shared';

type Rendered = {
  container: HTMLDivElement;
  root: Root;
};

const rendered: Rendered[] = [];

function buildForm(
  overrides: Partial<NetworkFreqCreateWizardForm> = {},
): NetworkFreqCreateWizardForm {
  return {
    freq: '146.5000',
    modulation: 'DMR',
    encryptionId: 11,
    activeFrom: '2026-06-13',
    activeTo: '',
    encryptionKeyIds: [],
    ...overrides,
  };
}

function renderDrawer(form: NetworkFreqCreateWizardForm): Rendered {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  function Harness() {
    const [currentForm, setCurrentForm] = useState(form);
    return (
      <NetworkFreqCreateDrawer
        open
        form={currentForm}
        saving={false}
        error={null}
        networkId={null}
        canManageKeys={false}
        encryptions={[{ id: 11, name: 'DMR' }]}
        onClose={() => {}}
        onChange={setCurrentForm}
        onSave={() => {}}
      />
    );
  }

  act(() => {
    root.render(<Harness />);
  });

  return { container, root };
}

function renderDrawerWithEncryptions(
  form: NetworkFreqCreateWizardForm,
  encryptions: { id: number; name: string }[],
): Rendered {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  function Harness() {
    const [currentForm, setCurrentForm] = useState(form);
    return (
      <NetworkFreqCreateDrawer
        open
        form={currentForm}
        saving={false}
        error={null}
        networkId={null}
        canManageKeys={false}
        encryptions={encryptions}
        onClose={() => {}}
        onChange={setCurrentForm}
        onSave={() => {}}
      />
    );
  }

  act(() => {
    root.render(<Harness />);
  });

  return { container, root };
}

function renderManagedDrawer(form: NetworkFreqCreateWizardForm): Rendered {
  apiMock.listKeys.mockResolvedValue({ keys: [] });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  function Harness() {
    const [currentForm, setCurrentForm] = useState(form);
    return (
      <NetworkFreqCreateDrawer
        open
        form={currentForm}
        saving={false}
        error={null}
        networkId={1}
        canManageKeys
        encryptions={[{ id: 11, name: 'DMR' }]}
        onClose={() => {}}
        onChange={setCurrentForm}
        onSave={() => {}}
      />
    );
  }

  act(() => {
    root.render(<Harness />);
  });

  return { container, root };
}

afterEach(() => {
  for (const item of rendered.splice(0)) {
    act(() => {
      item.root.unmount();
    });
    item.container.remove();
  }
});
describe('NetworkFreqCreateDrawer', () => {
  it('shows the base section heading and hides the create-only description field', () => {
    const view = renderDrawer(buildForm());
    rendered.push(view);

    expect(view.container.textContent).toContain('Основні дані');
    expect(view.container.textContent).not.toContain("Опис (необов'язково)");
  });

  it('keeps the frequency error hidden until the field is touched', async () => {
    const view = renderDrawer(buildForm({ freq: '' }));
    rendered.push(view);

    expect(view.container.querySelector('[data-testid="helper-text"]')).toBeNull();

    const freqInput = view.container.querySelector(
      'input[aria-label="Частота *"]',
    ) as HTMLInputElement | null;
    await act(async () => {
      freqInput?.focus();
      freqInput?.blur();
      await Promise.resolve();
    });

    expect(view.container.querySelector('[data-testid="helper-text"]')?.textContent).toContain(
      'Це поле обов',
    );
  });

  it('marks the new key field as required', () => {
    const view = renderManagedDrawer(buildForm());
    rendered.push(view);

    const addKeyButton = [...view.container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Додати новий ключ'),
    ) as HTMLButtonElement | undefined;
    act(() => {
      addKeyButton?.click();
    });

    expect(view.container.textContent).toContain('Ключ *');
    expect(view.container.textContent).toContain(
      'Ключ буде додано до системи одразу після створення',
    );
    expect(
      view.container.querySelector('input[placeholder="A-Z, 0-9 (4-64 символи)"]'),
    ).not.toBeNull();
  });

  it('renders keys before the technical section', () => {
    const view = renderDrawer(buildForm());
    rendered.push(view);

    expect(view.container.querySelector('[data-testid="keys-section"]')).not.toBeNull();
    expect(view.container.textContent).toContain('ТЕХНІЧНІ ДАНІ');
  });

  it('disables save when the start date is invalid', () => {
    const view = renderDrawer(buildForm({ activeFrom: '' }));
    rendered.push(view);

    const saveButton = [...view.container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Зберегти',
    ) as HTMLButtonElement | undefined;
    expect(saveButton?.disabled).toBe(true);
  });

  it('renders the deviation select when offset mode is selected', async () => {
    const view = renderDrawer(buildForm());
    rendered.push(view);

    const offsetChip = [...view.container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Девіація до центральної частоти'),
    ) as HTMLButtonElement | undefined;
    await act(async () => {
      offsetChip?.click();
      await Promise.resolve();
    });

    const deviationSelect = view.container.querySelector(
      '[data-testid="deviation-select"]',
    ) as HTMLDivElement | null;
    expect(deviationSelect).not.toBeNull();
    expect(deviationSelect?.getAttribute('data-value')).toBe('146.5000');
  });

  it('wires the empty deviation select with stable metadata', async () => {
    const view = renderDrawer(buildForm({ freq: '' }));
    rendered.push(view);

    const offsetChip = [...view.container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Девіація до центральної частоти'),
    ) as HTMLButtonElement | undefined;
    await act(async () => {
      offsetChip?.click();
      await Promise.resolve();
    });

    const deviationSelect = view.container.querySelector(
      '[data-testid="deviation-select"]',
    ) as HTMLDivElement | null;
    expect(deviationSelect).not.toBeNull();
    expect(deviationSelect?.getAttribute('data-label-id')).toBe(
      'network-freq-deviation-select-label',
    );
    expect(deviationSelect?.getAttribute('data-id')).toBe('network-freq-deviation-select');
    expect(deviationSelect?.getAttribute('data-name')).toBe('networkFreqDeviationBase');
    expect(view.container.textContent).toContain('Оберіть основну частоту');
    expect(view.container.querySelector('[data-shrink="true"]')).not.toBeNull();
  });

  it('shows the tech section as unavailable for non-DMR modes', () => {
    const view = renderDrawer(buildForm({ modulation: 'NFM' }));
    rendered.push(view);

    expect(view.container.textContent).toContain('доступно лише для DMR');
    expect(view.container.querySelector('[data-testid="keys-section"]')).not.toBeNull();
  });

  it('enables the tech section when modulation is DMR', () => {
    const view = renderDrawer(buildForm({ modulation: 'DMR' }));
    rendered.push(view);

    const techToggle = [...view.container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('ТЕХНІЧНІ ДАНІ'),
    ) as HTMLButtonElement | undefined;
    expect(techToggle?.disabled).toBe(false);
  });

  it('disables the tech section when modulation is AM', () => {
    const view = renderDrawer(buildForm({ modulation: 'AM' }));
    rendered.push(view);

    const techToggle = [...view.container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('ТЕХНІЧНІ ДАНІ'),
    ) as HTMLButtonElement | undefined;
    expect(techToggle?.disabled).toBe(true);
    expect(view.container.textContent).toContain('доступно лише для DMR');
    expect(view.container.querySelector('[data-testid="keys-section"]')).not.toBeNull();
  });

  it('renders keys without expanding the technical section', () => {
    const view = renderDrawer(buildForm());
    rendered.push(view);

    expect(view.container.querySelector('[data-testid="keys-section"]')).not.toBeNull();
    expect(view.container.textContent).not.toContain('Поля нижче поки що лише для перегляду.');
    expect(view.container.textContent).not.toContain('Поки що не зберігаються.');
    expect(view.container.textContent).not.toContain(
      'Можна додати кілька ключів до однієї частоти.',
    );
  });

  it('validates a new key before creating it', async () => {
    const view = renderManagedDrawer(buildForm());
    rendered.push(view);

    const addKeyButton = [...view.container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Додати новий ключ'),
    ) as HTMLButtonElement | undefined;
    await act(async () => {
      addKeyButton?.click();
      await Promise.resolve();
    });

    const keyInput = view.container.querySelector(
      'input[aria-label="Ключ"]',
    ) as HTMLInputElement | null;
    expect(keyInput?.placeholder).toBe('A-Z, 0-9 (4-64 символи)');

    await act(async () => {
      keyInput?.focus();
      keyInput?.blur();
      await Promise.resolve();
    });

    const createButton = [...view.container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Створити'),
    ) as HTMLButtonElement | undefined;
    expect(createButton?.disabled).toBe(true);
  });
});
