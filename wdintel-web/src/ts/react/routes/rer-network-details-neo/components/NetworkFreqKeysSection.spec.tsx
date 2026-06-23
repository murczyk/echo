/**
 * @vitest-environment happy-dom
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@mui/material', () => ({
  Autocomplete: ({ renderInput, sx }: { renderInput?: (params: any) => ReactNode; sx?: unknown }) => {
    const resolvedSx = typeof sx === 'function'
      ? sx({
          palette: {
            mode: 'light',
            action: { disabledBackground: '#ddd', disabled: '#bbb' },
            grey: { 400: '#ccc', 700: '#777' },
            text: { secondary: '#888' },
          },
        } as any)
      : sx;

    const outlinedRoot = resolvedSx && typeof resolvedSx === 'object' ? (resolvedSx as any)['& .MuiOutlinedInput-root'] : null;
    const inputRoot = resolvedSx && typeof resolvedSx === 'object' ? (resolvedSx as any)['& .MuiAutocomplete-inputRoot'] : null;
    const input = resolvedSx && typeof resolvedSx === 'object' ? (resolvedSx as any)['& .MuiAutocomplete-input'] : null;
    const placeholder = resolvedSx && typeof resolvedSx === 'object' ? (resolvedSx as any)['& .MuiAutocomplete-input::placeholder'] : null;
    const endAdornment = resolvedSx && typeof resolvedSx === 'object' ? (resolvedSx as any)['& .MuiAutocomplete-endAdornment'] : null;

    return (
      <div
        data-testid="autocomplete"
        data-outlined-height={outlinedRoot?.height ?? ''}
        data-outlined-min-height={outlinedRoot?.minHeight ?? ''}
        data-input-root-align={inputRoot?.alignItems ?? ''}
        data-outlined-padding={outlinedRoot?.padding ?? ''}
        data-input-height={input?.height ?? ''}
        data-input-line-height={input?.lineHeight ?? ''}
        data-input-font-weight={input?.fontWeight ?? ''}
        data-placeholder-font-weight={placeholder?.fontWeight ?? ''}
        data-end-adornment-top={endAdornment?.top ?? ''}
        data-end-adornment-right={endAdornment?.right ?? ''}
      >
        {typeof renderInput === 'function' ? renderInput({}) : null}
      </div>
    );
  },
  Box: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Button: ({ children }: { children?: ReactNode }) => <button type="button">{children}</button>,
  Chip: ({ label }: { label?: ReactNode }) => <span>{label}</span>,
  Skeleton: () => <div data-testid="skeleton" />,
  Stack: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  TextField: ({ placeholder, size }: { placeholder?: string; size?: string }) => (
    <input data-size={size} placeholder={placeholder} />
  ),
  Typography: ({ children, variant }: { children?: ReactNode; variant?: string }) => (
    <div data-variant={variant}>{children}</div>
  ),
}));

vi.mock('../../../components/PowerAlert', () => ({
  PowerAlert: ({ children, severity }: { children?: ReactNode; severity?: string }) => (
    <div data-severity={severity}>{children}</div>
  ),
}));

vi.mock('./dropdownProps', () => ({
  NEO_AUTOCOMPLETE_SLOT_PROPS: {},
}));

import { NetworkFreqKeysSection } from './NetworkFreqKeysSection';

type Rendered = {
  container: HTMLDivElement;
  root: Root;
};

const rendered: Rendered[] = [];

function renderSection(): Rendered {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(
      <NetworkFreqKeysSection
        canManageKeys
        saving={false}
        networkId={1}
        keysLoading={false}
        keysError={null}
        keys={[]}
        selectedKeys={[]}
        onSelectedKeysChange={() => {}}
        onAddNewKey={() => {}}
        formatKeyLabel={() => 'key'}
      />,
    );
  });

  return { container, root };
}

function renderSectionWithSelectedKeys(): Rendered {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(
      <NetworkFreqKeysSection
        canManageKeys
        saving={false}
        networkId={1}
        keysLoading={false}
        keysError={null}
        keys={[{ id: 1, key: 'ABCD', description: null, modulationId: null } as any]}
        selectedKeys={[{ id: 1, key: 'ABCD', description: null, modulationId: null } as any]}
        onSelectedKeysChange={() => {}}
        onAddNewKey={() => {}}
        formatKeyLabel={() => 'key'}
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

describe('NetworkFreqKeysSection', () => {
  it('renders the heading as the same uppercase group style and keeps autocomplete compact', () => {
    const view = renderSection();
    rendered.push(view);

    expect(view.container.querySelector('[data-variant="subtitle1"]')).not.toBeNull();
    expect(view.container.textContent).toContain('Ключі');
    expect(view.container.querySelector('[data-testid="autocomplete"]')).not.toBeNull();
    expect(view.container.querySelector('[data-testid="autocomplete"]')?.getAttribute('data-outlined-height')).toBe('40');
    expect(view.container.querySelector('[data-testid="autocomplete"]')?.getAttribute('data-outlined-min-height')).toBe('40');
    expect(view.container.querySelector('[data-testid="autocomplete"]')?.getAttribute('data-input-root-align')).toBe('center');
    expect(view.container.querySelector('[data-testid="autocomplete"]')?.getAttribute('data-outlined-padding')).toBe('0 46px 0 14px !important');
    expect(view.container.querySelector('[data-testid="autocomplete"]')?.getAttribute('data-input-height')).toBe('40');
    expect(view.container.querySelector('[data-testid="autocomplete"]')?.getAttribute('data-input-line-height')).toBe('20px');
    expect(view.container.querySelector('[data-testid="autocomplete"]')?.getAttribute('data-input-font-weight')).toBe('400');
    expect(view.container.querySelector('[data-testid="autocomplete"]')?.getAttribute('data-placeholder-font-weight')).toBe('400');
    expect(view.container.querySelector('[data-testid="autocomplete"]')?.getAttribute('data-end-adornment-top')).toBe('50%');
    expect(view.container.querySelector('[data-testid="autocomplete"]')?.getAttribute('data-end-adornment-right')).toBe('10');
    expect(view.container.querySelector('input[placeholder="Пошук і вибір ключів"]')?.getAttribute('data-size')).toBe('small');
  });

  it('lets the autocomplete grow when selected chips exist', () => {
    const view = renderSectionWithSelectedKeys();
    rendered.push(view);

    expect(view.container.querySelector('[data-testid="autocomplete"]')?.getAttribute('data-outlined-height')).toBe('auto');
    expect(view.container.querySelector('[data-testid="autocomplete"]')?.getAttribute('data-input-root-align')).toBe('center');
  });
});
