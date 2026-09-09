/**
 * @vitest-environment happy-dom
 */
import { act, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@mui/material', () => ({
  Box: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Button: ({
    children,
    disabled,
    onClick,
    variant,
  }: {
    children?: ReactNode;
    disabled?: boolean;
    onClick?: () => void;
    variant?: string;
  }) => (
    <button type="button" data-variant={variant} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
  ButtonGroup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Stack: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Typography: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock('.././NetworkFreqDatePickerField', () => ({
  NetworkFreqDatePickerField: ({
    label,
    value,
    disabled,
    required,
    helperText,
    onBlur,
    textFieldSx,
  }: {
    label: string;
    value: string;
    disabled?: boolean;
    required?: boolean;
    helperText?: ReactNode;
    onBlur?: () => void;
    textFieldSx?: { width?: string };
  }) => (
    <label>
      <span>{label}</span>
      <input aria-label={label} value={value} disabled={disabled} onBlur={onBlur} readOnly />
      {required ? <span data-testid={`${label}-required`}>*</span> : null}
      {textFieldSx ? <span data-testid={`${label}-width`}>{textFieldSx.width ?? ''}</span> : null}
      {helperText ? <span>{helperText}</span> : null}
    </label>
  ),
}));

import { NetworkFreqActivityPeriodControl } from '.././NetworkFreqActivityPeriodControl';

type Rendered = {
  container: HTMLDivElement;
  root: Root;
};

const rendered: Rendered[] = [];

function renderHarness(
  initialState: { activeFrom: string; activeTo: string; disabled?: boolean } = {
    activeFrom: '2026-06-13',
    activeTo: '',
  },
) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  function Harness() {
    const [activeFrom, setActiveFrom] = useState(initialState.activeFrom);
    const [activeTo, setActiveTo] = useState(initialState.activeTo);

    return (
      <div>
        <NetworkFreqActivityPeriodControl
          activeFrom={activeFrom}
          activeTo={activeTo}
          onActiveFromChange={setActiveFrom}
          onActiveToChange={setActiveTo}
          disabled={initialState.disabled}
          required
          activeFromHelperText="from"
          activeToHelperText="to"
        />
        <pre data-testid="state">{JSON.stringify({ activeFrom, activeTo })}</pre>
      </div>
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

// @test-scope safeguard: prevents invalid or future network-frequency activity periods from being persisted.
describe('NetworkFreqActivityPeriodControl', () => {
  it('starts active and hides the end date', () => {
    const view = renderHarness({ activeFrom: '2026-06-13', activeTo: '' });
    rendered.push(view);

    expect(view.container.textContent).toContain('Активна');
    expect(view.container.textContent).not.toContain('Активна по');
    expect(view.container.querySelector('[data-testid="Активна з-width"]')?.textContent).toBe(
      '100%',
    );
  });

  it('shows the end date when switching to inactive and initializes it if empty', () => {
    const view = renderHarness({ activeFrom: '2026-06-13', activeTo: '' });
    rendered.push(view);

    act(() => {
      [...view.container.querySelectorAll('button')]
        .find((button) => button.textContent === 'Неактивна')
        ?.click();
    });

    expect(view.container.textContent).toContain('Активна по');
    expect(
      (view.container.querySelector('[data-testid="state"]') as HTMLElement).textContent,
    ).not.toContain('"activeTo":""');
  });

  it('clears the end date when switching back to active', () => {
    const view = renderHarness({ activeFrom: '2026-06-13', activeTo: '2026-06-14' });
    rendered.push(view);

    act(() => {
      [...view.container.querySelectorAll('button')]
        .find((button) => button.textContent === 'Активна')
        ?.click();
    });

    expect(
      (view.container.querySelector('[data-testid="state"]') as HTMLElement).textContent,
    ).toContain('"activeTo":""');
    expect(view.container.textContent).not.toContain('Активна по');
  });

  it('disables both buttons and date fields when disabled', () => {
    const view = renderHarness({
      activeFrom: '2026-06-13',
      activeTo: '2026-06-14',
      disabled: true,
    });
    rendered.push(view);

    const buttons = [...view.container.querySelectorAll('button')];
    expect(buttons.every((button) => button.disabled)).toBe(true);
    expect(
      [...view.container.querySelectorAll('input')].every(
        (input) => (input as HTMLInputElement).disabled,
      ),
    ).toBe(true);
  });

  it('warns for either activity date more than one month in the future', () => {
    const view = renderHarness({ activeFrom: '2100-01-01', activeTo: '2100-01-02' });
    rendered.push(view);

    expect(
      view.container.textContent?.match(
        /Перевірте дату: вона більш ніж на місяць у майбутньому\./g,
      ),
    ).toHaveLength(2);
  });
});
