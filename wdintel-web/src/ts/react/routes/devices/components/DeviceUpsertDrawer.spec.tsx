/**
 * @vitest-environment happy-dom
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@mui/material', () => ({
  Autocomplete: ({ renderInput }: { renderInput?: (params: unknown) => ReactNode }) => (
    <div>{renderInput?.({} as never)}</div>
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
  CircularProgress: () => <span data-testid="spinner" />,
  Divider: () => <hr />,
  Drawer: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  IconButton: ({
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
  Stack: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  TextField: ({
    label,
    value,
    helperText,
    type,
  }: {
    label?: ReactNode;
    value?: string;
    helperText?: ReactNode;
    type?: string;
  }) => (
    <label>
      <span>{label}</span>
      <input
        aria-label={typeof label === 'string' ? label : undefined}
        type={type}
        value={value ?? ''}
        readOnly
      />
      {helperText ? <span>{helperText}</span> : null}
    </label>
  ),
  Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Typography: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock('../../../components/PowerAlert', () => ({
  PowerAlert: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock('./DeviceCustomFieldsEditor', () => ({
  DeviceCustomFieldsEditor: () => <div data-testid="device-custom-fields-editor" />,
}));

import { DeviceUpsertDrawer } from './DeviceUpsertDrawer';
import {
  createDefaultDeviceUpsertForm,
  type DeviceFieldPermissions,
  type DeviceUpsertForm,
} from '../device-form';

const rendered: Array<{ container: HTMLDivElement; root: Root }> = [];

function buildForm(overrides: Partial<DeviceUpsertForm> = {}): DeviceUpsertForm {
  return {
    ...createDefaultDeviceUpsertForm(),
    sourceLabel: 'Source device',
    ...overrides,
  };
}

function renderDrawer(
  form: DeviceUpsertForm,
  mode: 'create' | 'edit',
  fieldPermissions: DeviceFieldPermissions,
) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(
      <DeviceUpsertDrawer
        open
        mode={mode}
        fieldPermissions={fieldPermissions}
        form={form}
        saving={false}
        error={null}
        serverFieldErrors={{}}
        referenceLoading={false}
        aorOptions={[]}
        unitOptions={[]}
        onClose={() => {}}
        onChange={() => {}}
        onSave={() => {}}
      />,
    );
  });

  return { container, root };
}

function inputByLabel(container: HTMLDivElement, label: string): HTMLInputElement | null {
  return container.querySelector(`input[aria-label="${label}"]`);
}

afterEach(() => {
  for (const view of rendered.splice(0)) {
    act(() => view.root.unmount());
    view.container.remove();
  }
});

describe('DeviceUpsertDrawer', () => {
  it('shows only the permitted field groups', () => {
    const createView = renderDrawer(buildForm(), 'create', {
      sourceData: true,
      analyticalData: false,
    });
    rendered.push(createView);

    expect(inputByLabel(createView.container, 'Джерельна мітка')?.value).toBe('Source device');
    expect(inputByLabel(createView.container, 'Зовнішнє посилання')).not.toBeNull();
    expect(inputByLabel(createView.container, 'Аналітична назва')).toBeNull();
    expect(
      createView.container.querySelector('[data-testid="device-custom-fields-editor"]'),
    ).not.toBeNull();

    const analyticalView = renderDrawer(buildForm({ name: 'Analytical name' }), 'edit', {
      sourceData: false,
      analyticalData: true,
    });
    rendered.push(analyticalView);

    expect(inputByLabel(analyticalView.container, 'Джерельна мітка')).toBeNull();
    expect(inputByLabel(analyticalView.container, 'Аналітична назва')?.value).toBe(
      'Analytical name',
    );
    expect(
      analyticalView.container.querySelector('[data-testid="device-custom-fields-editor"]'),
    ).toBeNull();
  });
});
