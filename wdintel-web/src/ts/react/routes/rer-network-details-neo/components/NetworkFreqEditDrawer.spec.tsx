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
  Drawer: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  FormControl: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  InputLabel: ({ children }: { children?: ReactNode }) => <label>{children}</label>,
  MenuItem: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Select: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Stack: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Typography: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock('../../../components/PowerAlert', () => ({
  PowerAlert: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
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
  }) => <div data-testid="activity-period">{`${activeFrom}|${activeTo}`}</div>,
}));

vi.mock('./NetworkFreqSummaryHeader', () => ({
  NetworkFreqSummaryHeader: () => <div data-testid="summary-header" />,
}));

vi.mock('./dropdownProps', () => ({
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
    kind: 'DMR',
    modulationId: 11,
    activeFrom: '2026-06-13',
    activeTo: '',
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
        freq={null}
        saving={false}
        error={null}
        modulations={[{ id: 11, name: 'FM' }]}
        onClose={() => {}}
        onChange={() => {}}
        onSave={() => {}}
      />,
    );
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
});
