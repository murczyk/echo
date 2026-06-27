/**
 * @vitest-environment happy-dom
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@mui/material', () => ({
  Box: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Button: ({ children }: { children?: ReactNode }) => <button type="button">{children}</button>,
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
  TextField: ({ label, required }: { label?: ReactNode; required?: boolean }) => (
    <label>
      <span>{label}{required ? ' *' : ''}</span>
    </label>
  ),
}));

vi.mock('../../../components/PowerAlert', () => ({
  PowerAlert: ({ children, severity }: { children?: ReactNode; severity?: string }) => (
    <div data-severity={severity}>{children}</div>
  ),
}));

import { NetworkFreqNewKeyDialog } from './NetworkFreqNewKeyDialog';

type Rendered = {
  container: HTMLDivElement;
  root: Root;
};

const rendered: Rendered[] = [];

function renderDialog(): Rendered {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(
      <NetworkFreqNewKeyDialog
        open
        title="Новий ключ"
        saving={false}
        keyValue=""
        descriptionValue=""
        encryptionId={null}
        encryptionOptions={[]}
        onClose={() => {}}
        onKeyChange={() => {}}
        onKeyBlur={() => {}}
        onDescriptionChange={() => {}}
        onEncryptionChange={() => {}}
        onCreate={() => {}}
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

describe('NetworkFreqNewKeyDialog', () => {
  it('renders the info hint inline through PowerAlert', () => {
    const view = renderDialog();
    rendered.push(view);

    expect(view.container.querySelector('[data-severity="info"]')).not.toBeNull();
    expect(view.container.textContent).toContain('Ключ буде додано до системи одразу після створення');
  });
});
