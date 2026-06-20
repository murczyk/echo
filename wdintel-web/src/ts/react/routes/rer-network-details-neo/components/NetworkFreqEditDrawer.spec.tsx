/**
 * @vitest-environment happy-dom
 */
import { act, forwardRef, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const apiMock = vi.hoisted(() => ({
  createKey: vi.fn(),
  listKeys: vi.fn(),
}));

vi.mock('@mui/material', () => ({
  Box: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Button: forwardRef<HTMLButtonElement, { children?: ReactNode; disabled?: boolean; onClick?: () => void }>(({ children, disabled, onClick }, ref) => (
    <button ref={ref} type="button" disabled={disabled} onClick={onClick}>
      {children}
    </button>
  )),
  ButtonBase: forwardRef<HTMLButtonElement, { children?: ReactNode; disabled?: boolean; onClick?: () => void }>(({ children, disabled, onClick }, ref) => (
    <button ref={ref} type="button" disabled={disabled} onClick={onClick}>
      {children}
    </button>
  )),
  CircularProgress: () => <span data-testid="spinner" />,
  Autocomplete: ({ children, renderInput }: { children?: ReactNode; renderInput?: (params: any) => ReactNode }) => (
    <div data-testid="autocomplete">{typeof renderInput === 'function' ? renderInput({}) : children}</div>
  ),
  Skeleton: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Dialog: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogActions: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Drawer: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  FormControl: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  InputLabel: ({ children }: { children?: ReactNode }) => <label>{children}</label>,
  MenuItem: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Select: ({
    children,
    value,
    labelId,
    id,
    inputProps,
    sx: _sx,
    ...props
  }: { children?: ReactNode; value?: string; labelId?: string; id?: string; inputProps?: { name?: string }; sx?: unknown; [key: string]: any }) => (
    <div data-value={value} data-label-id={labelId} data-id={id} data-name={inputProps?.name} {...props}>
      {children}
    </div>
  ),
  ButtonGroup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  TextField: ({ label, value, onChange, onBlur, placeholder, readOnly, required, disabled, inputProps }: { label?: ReactNode; value?: string; onChange?: (event: any) => void; onBlur?: () => void; placeholder?: string; readOnly?: boolean; required?: boolean; disabled?: boolean; inputProps?: { readOnly?: boolean } }) => (
    <label>
      <span>{label}{required ? ' *' : ''}</span>
      <input aria-label={typeof label === 'string' ? label : undefined} placeholder={placeholder} value={value ?? ''} onChange={onChange} onBlur={onBlur} readOnly={inputProps?.readOnly ?? readOnly ?? onChange === undefined} disabled={disabled ?? false} />
    </label>
  ),
  Stack: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Typography: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock('../../../components/PowerAlert', () => ({
  PowerAlert: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock('../../../services/api/networks', () => ({
  createKey: apiMock.createKey,
  listKeys: apiMock.listKeys,
}));

vi.mock('../../../components/loadingOverlayStyles', () => ({
  pageDrawerBackdropSx: () => ({}),
}));

vi.mock('./NetworkFreqActivityPeriodControl', () => ({
  NetworkFreqActivityPeriodControl: ({
    activeFrom,
    activeTo,
  }: {
    activeFrom: string;
    activeTo: string;
  }) => <div data-testid="activity-period">Активна з{`${activeFrom}|${activeTo}`}</div>,
}));

vi.mock('./dropdownProps', () => ({
  NEO_AUTOCOMPLETE_SLOT_PROPS: {},
  NEO_SELECT_MENU_PROPS: {},
}));

import { NetworkFreqEditDrawer } from './NetworkFreqEditDrawer';
import type { NetworkFreqEditForm } from '../use-rer-network-details-neo-page.shared';

type Rendered = {
  container: HTMLDivElement;
  root: Root;
};

const rendered: Rendered[] = [];

function buildForm(overrides: Partial<NetworkFreqEditForm> = {}): NetworkFreqEditForm {
  return {
    networkFreqId: 1,
    freq: '148.2500',
    modulation: 'DMR',
    encryptionId: 11,
    activeFrom: '2026-06-13',
    activeTo: '',
    encryptionKeyIds: [],
    ...overrides,
  };
}

function renderDrawer(form: NetworkFreqEditForm): Rendered {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(
      <NetworkFreqEditDrawer
        open
        form={form}
        saving={false}
        error={null}
        networkId={null}
        encryptions={[{ id: 11, name: 'DMR' }]}
        onClose={() => {}}
        onChange={() => {}}
        onSave={() => {}}
      />,
    );
  });

  return { container, root };
}

function renderManagedDrawer(form: NetworkFreqEditForm): Rendered {
  apiMock.listKeys.mockResolvedValue({ keys: [] });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  function Harness() {
    const [currentForm, setCurrentForm] = useState(form);
    return (
      <NetworkFreqEditDrawer
        open
        form={currentForm}
        saving={false}
        error={null}
        networkId={1}
        modulations={[{ id: 11, name: 'DMR' }]}
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

describe('NetworkFreqEditDrawer', () => {
  it('passes the current frequency to the read-only Rx field', () => {
    const view = renderDrawer(buildForm({ freq: '148.2500' }));
    rendered.push(view);

    const techToggle = [...view.container.querySelectorAll('button')].find((button) => button.textContent?.includes('ТЕХНІЧНІ ДАНІ')) as HTMLButtonElement | undefined;
    act(() => {
      techToggle?.click();
    });

    const freqField = view.container.querySelector('input[aria-label="Частота *"]') as HTMLInputElement | null;
    const rxField = view.container.querySelector('input[aria-label="Rx"]') as HTMLInputElement | null;
    expect(freqField?.value).toBe('148.2500');
    expect(rxField?.value).toBe('148.2500');
  });

  it('keeps frequency read-only in edit mode', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    function Harness() {
      const [currentForm, setCurrentForm] = useState(buildForm({ freq: '148.2500' }));
      return (
        <NetworkFreqEditDrawer
          open
          form={currentForm}
          saving={false}
          error={null}
          networkId={null}
          modulations={[{ id: 11, name: 'DMR' }]}
          onClose={() => {}}
          onChange={setCurrentForm}
          onSave={() => {}}
        />
      );
    }

    act(() => {
      root.render(<Harness />);
    });

    rendered.push({ container, root });

    const freqField = container.querySelector('input[aria-label="Частота *"]') as HTMLInputElement | null;
    expect(freqField?.disabled).toBe(true);
    expect(freqField?.readOnly).toBe(true);
    expect(freqField?.value).toBe('148.2500');
  });

  it('marks the new key field as required', () => {
    const view = renderManagedDrawer(buildForm());
    rendered.push(view);

    const addKeyButton = [...view.container.querySelectorAll('button')].find((button) => button.textContent?.includes('Додати новий ключ')) as HTMLButtonElement | undefined;
    act(() => {
      addKeyButton?.click();
    });

    expect(view.container.textContent).toContain('Ключ *');
    expect(view.container.textContent).toContain('Ключ буде додано до системи одразу після створення');
    expect(view.container.querySelector('input[placeholder="A-Z, 0-9 (4-64 символи)"]')).not.toBeNull();
  });

  it('shows the base section heading and key section before technical data', () => {
    const view = renderDrawer(buildForm());
    rendered.push(view);

    expect(view.container.textContent).toContain('Основні дані');
    expect(view.container.textContent).toContain('Тип *');
    expect(view.container.textContent).toContain('Модуляція');
    expect(view.container.textContent).toContain('Ключі');
    expect(view.container.textContent).not.toContain('Шифрування *');
    expect(view.container.querySelector('[data-testid="summary-header"]')).toBeNull();
  });

  it('keeps keys and type below the activity block', () => {
    const view = renderDrawer(buildForm());
    rendered.push(view);

    const text = view.container.textContent ?? '';
    expect(text.indexOf('Активна з')).toBeLessThan(text.indexOf('Ключі'));
    expect(text.indexOf('Ключі')).toBeLessThan(text.indexOf('ТЕХНІЧНІ ДАНІ'));
    expect(text.indexOf('Тип *')).toBeLessThan(text.indexOf('ТЕХНІЧНІ ДАНІ'));
  });

  it('disables save when the start date is empty', () => {
    const view = renderDrawer(buildForm({ activeFrom: '' }));
    rendered.push(view);

    const saveButton = [...view.container.querySelectorAll('button')].find((button) => button.textContent === 'Зберегти') as HTMLButtonElement | undefined;
    expect(saveButton?.disabled).toBe(true);
  });

  it('disables save when the end date is invalid in inactive mode', () => {
    const view = renderDrawer(buildForm({ activeTo: 'not-a-date' }));
    rendered.push(view);

    const saveButton = [...view.container.querySelectorAll('button')].find((button) => button.textContent === 'Зберегти') as HTMLButtonElement | undefined;
    expect(saveButton?.disabled).toBe(true);
  });

  it('does not show removed helper texts in the tech area', () => {
    const view = renderDrawer(buildForm());
    rendered.push(view);

    const techToggle = [...view.container.querySelectorAll('button')].find((button) => button.textContent?.includes('ТЕХНІЧНІ ДАНІ')) as HTMLButtonElement | undefined;
    act(() => {
      techToggle?.click();
    });

    expect(view.container.textContent).not.toContain('Поля нижче поки що лише для перегляду.');
    expect(view.container.textContent).not.toContain('Поки що не зберігаються.');
  });

  it('renders keys without expanding the technical section', async () => {
    const view = renderManagedDrawer(buildForm({ modulationId: null }));
    rendered.push(view);

    await act(async () => {
      await Promise.resolve();
    });

    expect(view.container.querySelector('[data-testid="autocomplete"]')).not.toBeNull();
    expect(view.container.textContent).toContain('Ключі');
  });

  it('validates a new key before creating it', async () => {
    const view = renderManagedDrawer(buildForm());
    rendered.push(view);

    const addKeyButton = [...view.container.querySelectorAll('button')].find((button) => button.textContent?.includes('Додати новий ключ')) as HTMLButtonElement | undefined;
    await act(async () => {
      addKeyButton?.click();
      await Promise.resolve();
    });

    const keyInput = view.container.querySelector('input[aria-label="Ключ"]') as HTMLInputElement | null;
    expect(keyInput?.placeholder).toBe('A-Z, 0-9 (4-64 символи)');

    await act(async () => {
      keyInput?.focus();
      keyInput?.blur();
      await Promise.resolve();
    });

    const createButton = [...view.container.querySelectorAll('button')].find((button) => button.textContent?.includes('Створити')) as HTMLButtonElement | undefined;
    expect(createButton?.disabled).toBe(true);
  });
});
