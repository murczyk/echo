/** @vitest-environment happy-dom */
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const searchUnits = vi.hoisted(() => vi.fn());
const notify = vi.hoisted(() => vi.fn());
vi.mock('../../../services/api/units', () => ({
  DEFAULT_LIST_UNITS_REQ: {},
  searchUnitsStrictThenRelaxed: searchUnits,
}));
vi.mock('../../../components/PowerSnackbar', () => ({
  usePowerSnackbar: () => ({ notify }),
}));

import { MetadataEditor, type EditorState } from '../RerReportMetadataEditor';

let root: Root | null = null;
const rows: [] = [];

function Editor({ initialLabels = [] }: { initialLabels?: string[] }) {
  const [state, setState] = useState<EditorState>({
    id: null,
    unit: null,
    locations: [],
    labels: initialLabels,
  });
  return (
    <MetadataEditor
      state={state}
      rows={rows}
      saving={false}
      error={null}
      onChange={setState}
      onClose={() => {}}
      onSave={() => {}}
    />
  );
}

async function selectUnit(name: string) {
  const input = document.querySelector<HTMLInputElement>('input[role="combobox"]')!;
  await act(async () => {
    input.focus();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  });
  await vi.waitFor(() => {
    expect(
      Array.from(document.querySelectorAll('[role="option"]')).some(
        (option) => option.textContent === name,
      ),
    ).toBe(true);
  });
  const option = Array.from(document.querySelectorAll('[role="option"]')).find(
    (option) => option.textContent === name,
  )!;
  await act(async () => option.dispatchEvent(new MouseEvent('click', { bubbles: true })));
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.clearAllMocks();
});

describe('RER metadata editor', () => {
  // Regression: https://github.com/echoua/echo/issues/3598
  it('keeps the selected unit text and its default label aligned when changing or clearing units', async () => {
    searchUnits.mockResolvedValue([
      { id: 1, name: 'Unit A' },
      { id: 2, name: 'Unit B' },
    ]);
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<Editor />));
    await selectUnit('Unit A');
    expect(document.querySelector<HTMLInputElement>('input[role="combobox"]')?.value).toBe(
      'Unit A',
    );
    expect(document.querySelector('[data-testid="CancelIcon"]')?.parentElement?.textContent).toBe(
      'Unit A',
    );
    await selectUnit('Unit B');
    expect(document.querySelector<HTMLInputElement>('input[role="combobox"]')?.value).toBe(
      'Unit B',
    );
    expect(document.querySelector('[data-testid="CancelIcon"]')?.parentElement?.textContent).toBe(
      'Unit B',
    );
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('button[title="Clear"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    expect(document.querySelector('[data-testid="CancelIcon"]')).toBeNull();
    await selectUnit('Unit A');
    expect(document.querySelector<HTMLInputElement>('input[role="combobox"]')?.value).toBe(
      'Unit A',
    );
    expect(document.querySelector('[data-testid="CancelIcon"]')?.parentElement?.textContent).toBe(
      'Unit A',
    );
  });

  // Regression: https://github.com/echoua/echo/issues/3598
  it('replaces and clears the seeded label while preserving custom labels', async () => {
    searchUnits.mockResolvedValue([
      { id: 1, name: 'Unit A' },
      { id: 2, name: 'Unit B' },
    ]);
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<Editor initialLabels={['custom', 'Unit B']} />));
    const labels = () =>
      Array.from(document.querySelectorAll('[data-testid="CancelIcon"]')).map(
        (icon) => icon.parentElement?.textContent,
      );
    await selectUnit('Unit A');
    expect(labels()).toEqual(['Unit A', 'custom', 'Unit B']);
    await selectUnit('Unit B');
    expect(labels()).toEqual(['Unit B', 'custom']);
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('button[title="Clear"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    expect(labels()).toEqual(['custom']);
    await selectUnit('Unit A');
    expect(labels()).toEqual(['Unit A', 'custom']);
  });
});
