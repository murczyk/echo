/**
 * @vitest-environment happy-dom
 */
import { RadioFeaturesProvider } from '../../../shared/RadioFeatures';
import { act, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
  Checkbox: ({
    checked,
    onChange,
  }: {
    checked?: boolean;
    onChange?: (event: { target: { checked: boolean } }) => void;
  }) => (
    <input
      type="checkbox"
      checked={checked}
      readOnly={!onChange}
      onChange={(event) => onChange?.({ target: { checked: event.target.checked } })}
    />
  ),
  Drawer: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  FormControlLabel: ({ control, label }: { control?: ReactNode; label?: ReactNode }) => (
    <label>
      {control}
      {label}
    </label>
  ),
  Stack: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  TextField: ({
    label,
    helperText,
    value,
    onChange,
  }: {
    label?: ReactNode;
    helperText?: ReactNode;
    value?: string;
    onChange?: (event: { target: { value: string } }) => void;
  }) => (
    <label>
      {label}
      <input value={value} onChange={onChange} />
      {helperText ? <span>{helperText}</span> : null}
    </label>
  ),
  Typography: ({
    children,
    noWrap: _ignoredNoWrap,
    ...props
  }: {
    children?: ReactNode;
    noWrap?: boolean;
    [key: string]: unknown;
  }) => <div {...props}>{children}</div>,
}));

vi.mock('../../../../components/PowerAlert', () => ({
  PowerAlert: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock('../../../../components/SearchableOptionAutocomplete', () => ({
  SearchableOptionAutocomplete: () => <div data-testid="unit-autocomplete" />,
}));

vi.mock('.././NetworkCallsignSourceUi', () => ({
  NetworkCallsignSourceChip: ({
    source,
    selected,
    onClick,
  }: {
    source: { id: number; name: string };
    selected: boolean;
    onClick: () => void;
  }) => (
    <button type="button" aria-pressed={selected} onClick={onClick}>
      {source.name}
    </button>
  ),
  sortNetworkCallsignSources: (sources: Array<{ id: number; name: string }>) => sources,
}));

import { NetworkCallsignDrawer } from '.././NetworkCallsignDrawer';
import { createDefaultNetworkCallsignDrawerForm } from '../../network-callsigns.forms';
import type { NetworkCallsignDrawerForm } from '../../network-callsigns.types';
import type { Source } from '../../../../../../Bindings';

type Rendered = {
  container: HTMLDivElement;
  root: Root;
  saveForm: () => NetworkCallsignDrawerForm | null;
  getRenderCount: () => number;
};

const rendered: Rendered[] = [];

afterEach(() => {
  for (const item of rendered.splice(0)) {
    act(() => {
      item.root.unmount();
    });
    item.container.remove();
  }
});

function renderHarness(initialForm: NetworkCallsignDrawerForm, radioFeaturesAllowed = true) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  let savedForm: NetworkCallsignDrawerForm | null = null;
  let renderCount = 0;

  function Harness() {
    renderCount += 1;
    const [error, setError] = useState<string | null>(null);

    return (
      <NetworkCallsignDrawer
        open
        mode="create"
        form={initialForm}
        sources={[
          { id: 1, name: 'РЕР', createdAt: 0 } as Source,
          { id: 2, name: 'OSINT', createdAt: 0 } as Source,
        ]}
        units={[{ id: 1, label: '11 АК' }]}
        saving={false}
        error={error}
        onClose={() => {}}
        onSave={(form) => {
          savedForm = form;
          if (form && !form.developing && form.sourceId === null) {
            setError('Джерело є обовʼязковим');
          }
        }}
      />
    );
  }

  act(() => {
    root.render(
      <RadioFeaturesProvider allowed={radioFeaturesAllowed}>
        <Harness />
      </RadioFeaturesProvider>,
    );
  });

  return {
    container,
    root,
    saveForm: () => {
      act(() => {
        [...container.querySelectorAll('button')]
          .find((button) => button.textContent === 'Зберегти')
          ?.click();
      });
      return savedForm;
    },
    getRenderCount: () => renderCount,
  };
}
describe('NetworkCallsignDrawer', () => {
  it('#4108 keeps typing local to the drawer and saves the latest draft', () => {
    const view = renderHarness({
      ...createDefaultNetworkCallsignDrawerForm(10, 1),
      callsign: 'СОКІЛ',
    });
    rendered.push(view);
    const renderCount = view.getRenderCount();
    const input = view.container.querySelector('input') as HTMLInputElement;

    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        'БАРС',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(input.value).toBe('БАРС');
    expect(view.getRenderCount()).toBe(renderCount);
    expect(view.saveForm()).toMatchObject({ callsign: 'БАРС' });
  });

  it('#3568 allows a Cyber network callsign without a hidden RO frequency', () => {
    const view = renderHarness(
      {
        ...createDefaultNetworkCallsignDrawerForm(10, 1),
        callsign: 'СОКІЛ',
        sourceId: 2,
        radioFreq: '',
        developing: false,
      },
      false,
    );
    rendered.push(view);
    expect(view.container.textContent).not.toContain('Частота');
    const save = [...view.container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Зберегти',
    );
    expect(save?.disabled).toBe(false);
  });

  it('allows developing rows to save without a source', () => {
    const view = renderHarness({
      ...createDefaultNetworkCallsignDrawerForm(10, null),
      callsign: 'СОКІЛ',
    });
    rendered.push(view);

    const saveButton = [...view.container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Зберегти',
    ) as HTMLButtonElement | undefined;

    expect(saveButton?.disabled).toBe(false);
  });

  it('requires source and unit for catalog rows before save', () => {
    const view = renderHarness({
      ...createDefaultNetworkCallsignDrawerForm(10, null),
      callsign: 'СОКІЛ',
      developing: false,
    });
    rendered.push(view);

    const saveButton = [...view.container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Зберегти',
    ) as HTMLButtonElement | undefined;

    expect(saveButton?.disabled).toBe(true);

    const viewWithSource = renderHarness({
      ...createDefaultNetworkCallsignDrawerForm(10, null),
      callsign: 'СОКІЛ',
      sourceId: 1,
      developing: false,
    });
    rendered.push(viewWithSource);

    const saveButtonWithoutUnit = [...viewWithSource.container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Зберегти',
    ) as HTMLButtonElement | undefined;

    expect(saveButtonWithoutUnit?.disabled).toBe(true);

    const validView = renderHarness({
      ...createDefaultNetworkCallsignDrawerForm(10, 1),
      callsign: 'СОКІЛ',
      sourceId: 1,
      developing: false,
    });
    rendered.push(validView);

    const validSaveButton = [...validView.container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Зберегти',
    ) as HTMLButtonElement | undefined;

    expect(validSaveButton?.disabled).toBe(false);
  });

  it('shows the source label without an asterisk for developing rows', () => {
    const view = renderHarness({
      ...createDefaultNetworkCallsignDrawerForm(10, null),
      callsign: 'СОКІЛ',
    });
    rendered.push(view);

    expect(view.container.textContent).toContain('Джерело');
    expect(view.container.textContent).not.toContain('Джерело *');
  });

  it('shows the source validation hint when a selected source is cleared', () => {
    const view = renderHarness({
      ...createDefaultNetworkCallsignDrawerForm(10, null),
      callsign: 'СОКІЛ',
      sourceId: 1,
      developing: false,
    });
    rendered.push(view);

    act(() => {
      [...view.container.querySelectorAll('button')]
        .find((button) => button.textContent === 'РЕР')
        ?.click();
    });

    expect(
      view.container.querySelector('[data-testid="network-callsign-source-error"]')?.textContent,
    ).toBe('Джерело є обовʼязковим');
  });

  it('keeps marker state exclusive when switching between main, command and none', () => {
    const view = renderHarness({
      ...createDefaultNetworkCallsignDrawerForm(10, null),
      callsign: 'СОКІЛ',
      sourceId: 1,
    });
    rendered.push(view);

    const clickButton = (label: string) => {
      act(() => {
        [...view.container.querySelectorAll('button')]
          .find((button) => button.textContent?.includes(label))
          ?.click();
      });
    };

    clickButton('Головна радіостанція');
    expect(view.saveForm()).toMatchObject({ mainRadioStation: true, commandControl: false });

    clickButton('Ланка управління');
    expect(view.saveForm()).toMatchObject({ mainRadioStation: false, commandControl: true });

    clickButton('Без маркера');
    expect(view.saveForm()).toMatchObject({ mainRadioStation: false, commandControl: false });
  });

  it('allows a catalog-linked row to switch back to developing', () => {
    const view = renderHarness({
      ...createDefaultNetworkCallsignDrawerForm(10, 1),
      callsign: 'СОКІЛ',
      sourceId: 1,
      developing: false,
    });
    rendered.push(view);

    act(() => {
      [...view.container.querySelectorAll('button')]
        .find((button) => button.textContent === 'В дорозвідці')
        ?.click();
    });

    expect(view.saveForm()).toMatchObject({
      developing: true,
    });

    act(() => {
      [...view.container.querySelectorAll('button')]
        .find((button) => button.textContent === 'Каталог')
        ?.click();
    });

    expect(view.saveForm()).toMatchObject({
      developing: false,
    });
  });
});
