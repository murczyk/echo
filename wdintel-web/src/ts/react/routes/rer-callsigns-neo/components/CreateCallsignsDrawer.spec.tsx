/**
 * @vitest-environment happy-dom
 */
import { act, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@mui/material', () => ({
  Alert: ({ children, severity }: { children?: ReactNode; severity?: string }) => (
    <div data-severity={severity}>{children}</div>
  ),
  Autocomplete: ({
    disabled,
    inputValue,
    onInputChange,
    renderInput,
  }: {
    disabled?: boolean;
    inputValue?: string;
    onInputChange?: (_event: unknown, value: string, reason: string) => void;
    renderInput?: (params: unknown) => ReactNode;
  }) => (
    <div>
      {((latestAutocompleteInputChange = onInputChange ?? null), null)}
      <input
        aria-label="unit-search"
        disabled={disabled}
        value={inputValue ?? ''}
        onChange={(event) => onInputChange?.(event, (event.target as HTMLInputElement).value, 'input')}
      />
      {renderInput ? renderInput({} as never) : null}
    </div>
  ),
  Box: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Button: ({ children, disabled }: { children?: ReactNode; disabled?: boolean }) => (
    <button type="button" disabled={disabled}>{children}</button>
  ),
  Checkbox: ({ checked }: { checked?: boolean }) => <input type="checkbox" checked={checked} readOnly />,
  Divider: () => <hr />,
  Drawer: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  FormControl: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  FormControlLabel: ({ control, label }: { control?: ReactNode; label?: ReactNode }) => (
    <label>
      {control}
      {label}
    </label>
  ),
  FormHelperText: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  IconButton: ({ children }: { children?: ReactNode }) => <button type="button">{children}</button>,
  InputLabel: ({ children }: { children?: ReactNode }) => <label>{children}</label>,
  MenuItem: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Select: ({ children, renderValue }: { children?: ReactNode; renderValue?: (value: readonly (string | number)[]) => ReactNode }) => (
    <div>
      {renderValue ? renderValue([]) : null}
      {children}
    </div>
  ),
  Stack: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  TextField: ({ label, helperText }: { label?: ReactNode; helperText?: ReactNode }) => (
    <label>
      {label}
      {helperText ? <div>{helperText}</div> : null}
    </label>
  ),
  Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Typography: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

import { CreateCallsignsDrawer } from './CreateCallsignsDrawer';
import type { CallsignDraftRow, CallsignDuplicateHintGroup } from '../types';
import type { Source, Unit } from '../../../../../Bindings';
import { UNIT_SELECTION_REQUIRED_ERROR } from '../helpers';

let latestAutocompleteInputChange:
  | ((_event: unknown, value: string, reason: string) => void)
  | null = null;

type Rendered = {
  container: HTMLDivElement;
  root: Root;
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

function renderComponent(
  duplicateHintGroups: CallsignDuplicateHintGroup[],
  initialAddUnitId: number | null = 1,
): Rendered {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const rows: CallsignDraftRow[] = [
    { callsign: 'ЛЕС', position: '', fullName: '', comment: '', developing: false, radioFreq: '' },
    { callsign: 'БАРС', position: '', fullName: '', comment: '', developing: false, radioFreq: '' },
    { callsign: 'ВОЛК', position: '', fullName: '', comment: '', developing: false, radioFreq: '' },
  ];

  function Harness() {
    const [addUnitId, setAddUnitId] = useState<number | null>(initialAddUnitId);

    return (
      <CreateCallsignsDrawer
        open
        onClose={() => {}}
        units={[{ id: 1, name: '11 АК' } as Unit]}
        sources={[{ id: 1, name: 'РО' } as Source]}
        addUnitId={addUnitId}
        addSourceId={1}
        addCallsignAdditionalSourceIds={[]}
        rows={rows}
        submitting={false}
        disabled={false}
        validationError={null}
        duplicateHintGroups={duplicateHintGroups}
        onAddUnitIdChange={setAddUnitId}
        onAddSourceIdChange={() => {}}
        onAddCallsignAdditionalSourceIdsChange={() => {}}
        onRowChange={() => {}}
        onAppendRow={() => {}}
        onRemoveRow={() => {}}
        onClearRows={() => {}}
        onApplyPastedRows={() => {}}
        onSubmit={() => {}}
      />,
    );
  }

  act(() => {
    root.render(<Harness />);
  });

  return { container, root };
}

describe('CreateCallsignsDrawer', () => {
  it('renders a sticky duplicate summary and row-level hints', () => {
    const view = renderComponent([
      {
        rowIndex: 0,
        matches: [
          { id: 10, callsign: 'ЛЕСНОЙ', position: 'Командир', fullName: '', comment: '', unitName: '11 АК' },
          { id: 11, callsign: 'ЛЕСНИК', position: 'Оператор', fullName: '', comment: '', unitName: '11 АК' },
        ],
      },
      {
        rowIndex: 1,
        matches: [
          { id: 12, callsign: 'БАРС-4', position: 'Командир', fullName: '', comment: '', unitName: '11 АК' },
        ],
      },
      {
        rowIndex: 2,
        matches: [
          { id: 13, callsign: 'ВОЛК-1', position: 'Командир', fullName: '', comment: '', unitName: '11 АК' },
        ],
      },
    ]);
    rendered.push(view);

    expect(view.container.textContent).toContain('Схожі позивні знайдено: 4 у 3 рядках');
    expect(view.container.textContent).toContain('Рядок 1: ЛЕСНОЙ | 11 АК');
    expect(view.container.textContent).toContain('Схожі існуючі позивні: 2');
    expect(view.container.textContent).toContain('+ 1 more');
    expect(view.container.textContent).toContain('Рядок 2: БАРС-4 | 11 АК');
  });

  it('shows a unit selection error when the input text is not a selected unit', () => {
    const view = renderComponent([], null);
    rendered.push(view);

    const input = view.container.querySelector('input[aria-label="unit-search"]') as HTMLInputElement;
    expect(input).toBeTruthy();

    act(() => {
      latestAutocompleteInputChange?.({} as never, '78 мсп 42 мсд', 'input');
    });

    expect(view.container.textContent).toContain(UNIT_SELECTION_REQUIRED_ERROR);

    const addButton = Array.from(view.container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Додати',
    ) as HTMLButtonElement | undefined;

    expect(addButton?.disabled).toBe(true);
  });
});
