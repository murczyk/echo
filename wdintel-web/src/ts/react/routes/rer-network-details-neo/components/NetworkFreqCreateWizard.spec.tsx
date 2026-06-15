/**
 * @vitest-environment happy-dom
 */
import { act, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@mui/material', () => ({
  Box: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Button: ({ children, disabled, onClick }: { children?: ReactNode; disabled?: boolean; onClick?: () => void }) => (
    <button type="button" disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
  CircularProgress: () => <span data-testid="spinner" />,
  Dialog: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogActions: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  FormControl: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  InputLabel: ({ children }: { children?: ReactNode }) => <label>{children}</label>,
  MenuItem: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Select: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Stack: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  TextField: ({ label, value }: { label?: ReactNode; value?: string }) => (
    <label>
      <span>{label}</span>
      <input aria-label={typeof label === 'string' ? label : undefined} value={value ?? ''} readOnly />
    </label>
  ),
  Typography: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock('../../../components/PowerAlert', () => ({
  PowerAlert: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock('./NetworkFreqActivityPeriodControl', () => ({
  NetworkFreqActivityPeriodControl: ({
    activeFrom,
    activeTo,
  }: {
    activeFrom: string;
    activeTo: string;
  }) => <div data-testid="activity-period">{`${activeFrom}|${activeTo}`}</div>,
}));

vi.mock('./NetworkFreqKeysSection', () => ({
  NetworkFreqKeysSection: () => <div data-testid="keys-section" />,
}));

vi.mock('./NetworkFreqSectionCard', () => ({
  NetworkFreqSectionCard: ({ children, title }: { children?: ReactNode; title: string }) => (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  ),
}));

import { NetworkFreqCreateWizard } from './NetworkFreqCreateWizard';
import type { NetworkFreqCreateWizardForm } from '../use-rer-network-details-neo-page.shared';

type Rendered = {
  container: HTMLDivElement;
  root: Root;
};

const rendered: Rendered[] = [];

function buildForm(overrides: Partial<NetworkFreqCreateWizardForm> = {}): NetworkFreqCreateWizardForm {
  return {
    freq: '146.5000',
    kind: 'DMR',
    modulationId: 11,
    description: '',
    activeFrom: '',
    activeTo: '',
    encryptionKeyIds: [],
    ...overrides,
  };
}

function renderWizard(form: NetworkFreqCreateWizardForm): Rendered {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  function Harness() {
    const [currentForm, setCurrentForm] = useState(form);
    return (
      <NetworkFreqCreateWizard
        open
        step={1}
        form={currentForm}
        saving={false}
        error={null}
        networkId={null}
        canManageKeys={false}
        modulations={[{ id: 11, name: 'FM' }]}
        onClose={() => {}}
        onChange={setCurrentForm}
        onStepChange={() => {}}
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

describe('NetworkFreqCreateWizard', () => {
  it('disables save when the start date is empty', () => {
    const view = renderWizard(buildForm({ activeFrom: '' }));
    rendered.push(view);

    const saveButton = [...view.container.querySelectorAll('button')].find((button) => button.textContent === 'Зберегти') as HTMLButtonElement | undefined;
    expect(saveButton?.disabled).toBe(true);
  });

  it('keeps save enabled when the start date is valid', () => {
    const view = renderWizard(buildForm({ activeFrom: '2026-06-13' }));
    rendered.push(view);

    const saveButton = [...view.container.querySelectorAll('button')].find((button) => button.textContent === 'Зберегти') as HTMLButtonElement | undefined;
    expect(saveButton?.disabled).toBe(false);
  });
});
