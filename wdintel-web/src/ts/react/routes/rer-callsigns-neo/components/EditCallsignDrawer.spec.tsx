/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Source, Unit } from '../../../../../Bindings';
import { EditCallsignDrawer } from './EditCallsignDrawer';

let latestDrawerProps: Record<string, unknown> | null = null;

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
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
  Drawer: (props: Record<string, unknown>) => {
    latestDrawerProps = props;
    return <div>{props.children as ReactNode}</div>;
  },
  Stack: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  TextField: ({ label }: { label?: ReactNode }) => <div>{label}</div>,
  Typography: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock('../../../components/PowerAlert', () => ({
  PowerAlert: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock('../../../components/loadingOverlayStyles', () => ({
  pageDrawerBackdropSx: () => ({}),
}));

vi.mock('./CallsignFormFields', () => ({
  CallsignFormFields: () => <div data-testid="callsign-form-fields" />,
}));

afterEach(() => {
  latestDrawerProps = null;
  document.body.innerHTML = '';
});

describe('EditCallsignDrawer', () => {
  it('passes disableRestoreFocus through to the drawer modal', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <EditCallsignDrawer
          open
          form={{
            id: 1,
            callsign: 'ЛЕС',
            position: '',
            fullName: '',
            comment: '',
            developing: false,
            radioFreq: '',
            unitId: 1,
            sourceId: 1,
            callsignAdditionalSourceIds: [],
          }}
          units={[{ id: 1, name: '11 АК' } as Unit]}
          sources={[{ id: 1, name: 'РО' } as Source]}
          submitting={false}
          error={null}
          onClose={vi.fn()}
          onChange={vi.fn()}
          onSave={vi.fn()}
          disableRestoreFocus
        />,
      );
    });

    expect(latestDrawerProps?.ModalProps).toMatchObject({ disableRestoreFocus: true });

    root.unmount();
    container.remove();
  });
});
