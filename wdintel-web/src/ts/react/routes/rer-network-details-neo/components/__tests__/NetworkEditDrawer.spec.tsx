/**
 * @vitest-environment happy-dom
 */
import { act, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@mui/material', () => ({
  Autocomplete: ({
    options,
    getOptionLabel,
    renderInput,
  }: {
    options?: Array<{ id: number; label?: string; name?: string }>;
    getOptionLabel?: (option: { id: number; label?: string; name?: string }) => string;
    renderInput?: (params: unknown) => ReactNode;
  }) => (
    <div>
      <div data-testid="autocomplete-options">
        {(options ?? [])
          .map(
            (option) => getOptionLabel?.(option) ?? option.label ?? option.name ?? `#${option.id}`,
          )
          .join('|')}
      </div>
      {renderInput ? renderInput({} as never) : null}
    </div>
  ),
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
  ButtonBase: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  Checkbox: ({
    checked,
    disabled,
    onChange,
  }: {
    checked?: boolean;
    disabled?: boolean;
    onChange?: (event: { target: { checked: boolean } }) => void;
  }) => (
    <input
      aria-label="Не архівувати автоматично"
      checked={checked ?? false}
      disabled={disabled}
      type="checkbox"
      onChange={(event) => onChange?.(event as never)}
    />
  ),
  CircularProgress: () => <span data-testid="spinner" />,
  Drawer: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  FormControlLabel: ({ control, label }: { control?: ReactNode; label?: ReactNode }) => (
    <label>
      {control}
      <span>{label}</span>
    </label>
  ),
  FormControl: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  InputLabel: ({ children }: { children?: ReactNode }) => <label>{children}</label>,
  MenuItem: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Select: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Stack: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  TextField: ({
    label,
    helperText,
    onBlur,
    onChange,
    value,
  }: {
    label?: ReactNode;
    helperText?: ReactNode;
    onBlur?: () => void;
    onChange?: (event: { target: { value: string } }) => void;
    value?: string;
  }) => (
    <label>
      <span>{label}</span>
      <input
        aria-label={typeof label === 'string' ? label : undefined}
        value={value ?? ''}
        onBlur={onBlur}
        onChange={(event) => onChange?.(event as never)}
      />
      {helperText ? <span>{helperText}</span> : null}
    </label>
  ),
  Typography: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock('../../../../components/PowerAlert', () => ({
  PowerAlert: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock('../../../../components/SearchableMultiOptionAutocomplete', () => ({
  SearchableMultiOptionAutocomplete: ({
    options,
    getOptionLabel,
  }: {
    options: Array<{ id: number; label?: string; name?: string }>;
    getOptionLabel: (option: { id: number; label?: string; name?: string }) => string;
  }) => (
    <div data-testid="unit-options">
      {options.map((option) => getOptionLabel(option)).join('|')}
    </div>
  ),
}));

vi.mock('.././NetworkFreqActivityPeriodControl', () => ({
  NetworkFreqActivityPeriodControl: () => <div data-testid="freq-activity-period-control" />,
}));

import { NetworkEditDrawer } from '.././NetworkEditDrawer';
import type { NetworkEditLookupOption } from '.././network-edit-autocomplete';
import type { NetworkUpsertForm } from '../../use-rer-network-details-neo-page.shared';
import { NETWORK_STATUS_ACTIVE } from '../../network-status';

type Rendered = {
  container: HTMLDivElement;
  root: Root;
  setForm: (next: NetworkUpsertForm | null) => void;
  saveSpy: ReturnType<typeof vi.fn>;
};

const rendered: Rendered[] = [];

function buildForm(overrides: Partial<NetworkUpsertForm> = {}): NetworkUpsertForm {
  return {
    id: null,
    name: 'управління',
    location: '',
    radioStation: '',
    purpose: 'для управління підлеглим особовим складом',
    operationMode: 'дуплекс',
    operationType: 'ведення службового радіообміну',
    operationPeriod: 'цілодобово',
    doNotArchive: false,
    status: NETWORK_STATUS_ACTIVE,
    aorIds: [],
    unitIds: [],
    postIds: [],
    freq: '',
    modulation: 'DMR',
    encryptionId: null,
    activeFrom: '',
    activeTo: '',
    encryptionKeyIds: [],
    ...overrides,
  };
}

function renderDrawer(
  form: NetworkUpsertForm | null,
  mode: 'create' | 'edit' = 'create',
  options: { frequencyOptional?: boolean } = {},
): Rendered {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const saveSpy = vi.fn();
  let setForm = (_next: NetworkUpsertForm | null) => {};

  function Harness() {
    const [currentForm, nextSetForm] = useState<NetworkUpsertForm | null>(form);
    setForm = nextSetForm;
    return (
      <NetworkEditDrawer
        open
        mode={mode}
        form={currentForm}
        saving={false}
        error={null}
        referenceLoading={false}
        aorOptions={[
          { id: 3, label: 'Вся смуга' } as NetworkEditLookupOption,
          { id: 1, label: 'Альфа' } as NetworkEditLookupOption,
          { id: 2, label: 'Бета' } as NetworkEditLookupOption,
        ]}
        unitOptions={[
          { id: 1, label: '11 АК' } as NetworkEditLookupOption,
          { id: 2, label: '12 ОМБр' } as NetworkEditLookupOption,
        ]}
        postOptions={[{ id: 1, label: '_stihl_XN Пост' } as NetworkEditLookupOption]}
        encryptionOptions={[{ id: 11, label: 'FM' } as NetworkEditLookupOption]}
        onClose={() => {}}
        onChange={nextSetForm}
        onSave={saveSpy}
        frequencyOptional={options.frequencyOptional}
      />
    );
  }

  act(() => {
    root.render(<Harness />);
  });

  return { container, root, setForm, saveSpy };
}

afterEach(() => {
  for (const item of rendered.splice(0)) {
    act(() => {
      item.root.unmount();
    });
    item.container.remove();
  }
});

// @test-scope safeguard: prevents network changes from being saved with invalid required metadata, frequencies, or lost referenced units.
describe('NetworkEditDrawer', () => {
  it('keeps validation text hidden on initial open and shows it after blur', () => {
    const view = renderDrawer(buildForm({ freq: '123.4567' }));
    rendered.push(view);

    expect(view.container.textContent).not.toContain('Невірний формат частоти');
    expect(view.container.textContent).toContain('Перша частота *');
    expect(
      [...view.container.querySelectorAll('button')].some(
        (button) => button.textContent === 'Перша частота *',
      ),
    ).toBe(false);

    act(() => {
      view.setForm(buildForm({ freq: '123.45' }));
    });

    const freqInput = view.container.querySelector(
      'input[aria-label="Частота"]',
    ) as HTMLInputElement | null;
    expect(freqInput).not.toBeNull();

    act(() => {
      freqInput?.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });

    expect(view.container.textContent).toContain('Невірний формат частоти (наприклад: 146.5000)');
  });

  it('shows the ordered all-band AOR option first and the unit options from shared search labels', () => {
    const view = renderDrawer(buildForm({ aorIds: [3], unitIds: [2] }));
    rendered.push(view);

    expect(view.container.querySelector('[data-testid="autocomplete-options"]')?.textContent).toBe(
      'Вся смуга|Альфа|Бета',
    );
    expect(view.container.querySelector('[data-testid="unit-options"]')?.textContent).toBe(
      '11 АК|12 ОМБр',
    );
  });

  it('disables create save while the first frequency is invalid', () => {
    const view = renderDrawer(buildForm());
    rendered.push(view);

    const saveButton = [...view.container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Створити',
    ) as HTMLButtonElement | undefined;
    expect(saveButton?.disabled).toBe(true);
    expect(
      view.container.querySelector('[data-testid="freq-activity-period-control"]'),
    ).not.toBeNull();
  });

  it('allows create save with blank optional frequency', () => {
    const view = renderDrawer(
      buildForm({
        name: 'управління',
        location: 'район',
        aorIds: [1],
      }),
      'create',
      { frequencyOptional: true },
    );
    rendered.push(view);

    const saveButton = [...view.container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Створити',
    ) as HTMLButtonElement | undefined;
    expect(saveButton?.disabled).toBe(false);
    expect(view.container.textContent).toContain('Перша частота');
    expect(view.container.textContent).not.toContain('Перша частота *');
  });

  it('toggles auto-archive protection', () => {
    const view = renderDrawer(buildForm());
    rendered.push(view);

    const operationalButton = [...view.container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Оперативні параметри'),
    );
    expect(operationalButton).toBeDefined();

    act(() => {
      operationalButton?.click();
    });

    const checkbox = view.container.querySelector(
      'input[aria-label="Не архівувати автоматично"]',
    ) as HTMLInputElement | null;
    expect(checkbox).not.toBeNull();
    expect(checkbox?.checked).toBe(false);

    act(() => {
      checkbox?.click();
    });

    expect(checkbox?.checked).toBe(true);
  });

  it('disables edit save while required metadata is invalid', () => {
    const view = renderDrawer(
      buildForm({ id: 10, name: 'управління', location: 'район', aorIds: [] }),
      'edit',
    );
    rendered.push(view);

    const saveButton = [...view.container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Зберегти',
    ) as HTMLButtonElement | undefined;
    expect(saveButton?.disabled).toBe(true);
  });

  it('preserves referenced unit ids that are absent from the active catalog', () => {
    const view = renderDrawer(
      buildForm({
        id: 10,
        name: 'управління',
        location: 'район',
        aorIds: [1],
        unitIds: [99],
        freq: '123.4567',
      }),
      'edit',
    );
    rendered.push(view);

    const saveButton = [...view.container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Зберегти',
    );
    act(() => saveButton?.click());

    expect(view.saveSpy).toHaveBeenCalledWith(expect.objectContaining({ unitIds: [99] }));
  });
});
