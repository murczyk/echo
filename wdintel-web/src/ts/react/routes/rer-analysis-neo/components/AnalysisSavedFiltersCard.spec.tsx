/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SavedFilter } from '../../../../../Bindings';

vi.mock('@mui/material', () => ({
  Alert: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Autocomplete: (props: {
    options: SavedFilter[];
    value: SavedFilter | null;
    onChange?: (_event: Event, next: SavedFilter | null) => void;
    renderInput: (params: object) => ReactNode;
  }) => (
    <div>
      {props.renderInput({})}
      <button type="button" onClick={() => props.onChange?.(new Event('change'), props.options[0] ?? null)}>
        apply-first-filter
      </button>
      <div data-testid="selected-filter">{props.value?.name ?? ''}</div>
    </div>
  ),
  Button: (props: {
    children: ReactNode;
    disabled?: boolean;
    onClick?: () => void;
    color?: string;
    variant?: string;
  }) => (
    <button type="button" disabled={props.disabled} onClick={props.onClick}>
      {props.children}
    </button>
  ),
  Paper: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Stack: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TextField: (props: { label?: string; value?: string; onChange?: (event: { target: { value: string } }) => void }) => (
    <label>
      <span>{props.label}</span>
      <input value={props.value ?? ''} onChange={(event) => props.onChange?.({ target: { value: event.currentTarget.value } })} />
    </label>
  ),
  Typography: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import { AnalysisSavedFiltersCard } from './AnalysisSavedFiltersCard';

type Rendered = {
  container: HTMLDivElement;
  root: Root;
};

function buildSavedFilter(id: number, name: string): SavedFilter {
  return {
    id,
    name,
    req: {
      sinceDateInclusiveMs: 1,
      tillDateNoninclusiveMs: 2,
      selectedGroups: null,
      selectedSenders: null,
      selectedFreqs: null,
      selectedPosts: null,
      selectedCallsigns: null,
      selectedUnits: null,
      selectedLocations: null,
      selectedAors: null,
      orWithExtendedForm: null,
      orBookmarked: null,
      orImportant: null,
      orWithCoords: null,
      orWithoutCoords: null,
      search: null,
      selectedTags: null,
      selectedNetworks: null,
      withoutNetwork: null,
      metadataCc: null,
      metadataSender: null,
      metadataReceiver: null,
      metadataHash: null,
      onlyWithMetadata: null,
      withoutMetadata: null,
      includePelengLocations: null,
      unitsExactMatchOnly: null,
      filterTagsOption: null,
      withoutModelTags: null,
      reportTagsOnlyThisUnit: null,
    },
  };
}

function buildProps(overrides: Partial<ComponentProps<typeof AnalysisSavedFiltersCard>> = {}): ComponentProps<typeof AnalysisSavedFiltersCard> {
  return {
    isDirty: false,
    loadedSavedFilter: null,
    saveInFlight: false,
    savedFilterName: '',
    savedFilters: [buildSavedFilter(1, 'Base filter')],
    onApplySavedFilter: vi.fn(),
    onDeleteLoadedSavedFilter: vi.fn(),
    onRenameExisting: vi.fn(),
    onSaveAsNew: vi.fn(),
    onSavedFilterNameChange: vi.fn(),
    onUpdateExisting: vi.fn(),
    ...overrides,
  };
}

async function renderComponent(props: ComponentProps<typeof AnalysisSavedFiltersCard>): Promise<Rendered> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<AnalysisSavedFiltersCard {...props} />);
  });
  return { container, root };
}

function getButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.includes(label));
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Button not found: ${label}`);
  return button;
}

function getInput(container: HTMLElement, labelText: string): HTMLInputElement {
  const label = Array.from(container.querySelectorAll('label')).find((item) => item.textContent?.includes(labelText));
  if (!label) throw new Error(`Label not found: ${labelText}`);
  const input = label.querySelector('input');
  if (!(input instanceof HTMLInputElement)) throw new Error(`Input not found for label: ${labelText}`);
  return input;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
  });
}

async function typeInput(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('AnalysisSavedFiltersCard', () => {
  const rendered: Rendered[] = [];

  afterEach(() => {
    for (const item of rendered.splice(0)) {
      act(() => {
        item.root.unmount();
      });
      item.container.remove();
    }
  });

  it('disables save and update actions according to the current saved-filter state', async () => {
    const view = await renderComponent(
      buildProps({
        savedFilterName: 'Base filter',
        loadedSavedFilter: buildSavedFilter(1, 'Base filter'),
        isDirty: false,
      }),
    );
    rendered.push(view);

    expect(getButton(view.container, 'Зберегти як новий').disabled).toBe(false);
    expect(getButton(view.container, 'Перейменувати').disabled).toBe(true);
    expect(getButton(view.container, 'Оновити вибраний').disabled).toBe(true);
    expect(getButton(view.container, 'Видалити').disabled).toBe(false);
    expect(view.container.textContent).toContain('Поточний стан збігається із вибраним фільтром.');
    expect(view.container.textContent).toContain('Зберегти як новий');
  });

  it('wires saved-filter selection into the apply callback', async () => {
    const onApplySavedFilter = vi.fn();
    const view = await renderComponent(
      buildProps({
        onApplySavedFilter,
      }),
    );
    rendered.push(view);

    await click(getButton(view.container, 'apply-first-filter'));

    expect(onApplySavedFilter).toHaveBeenCalledWith(expect.objectContaining({ id: 1, name: 'Base filter' }));
  });

  it('wires filter-name editing into the rename callback', async () => {
    const onSavedFilterNameChange = vi.fn();
    const view = await renderComponent(
      buildProps({
        savedFilterName: 'New name',
        onSavedFilterNameChange,
      }),
    );
    rendered.push(view);

    await typeInput(getInput(view.container, 'Назва фільтра'), 'Changed name');

    expect(onSavedFilterNameChange).toHaveBeenCalledWith('Changed name');
  });

  it('wires explicit rename into its callback', async () => {
    const onRenameExisting = vi.fn();
    const view = await renderComponent(
      buildProps({
        savedFilterName: 'Changed name',
        loadedSavedFilter: buildSavedFilter(1, 'Base filter'),
        onRenameExisting,
      }),
    );
    rendered.push(view);

    await click(getButton(view.container, 'Перейменувати'));

    expect(onRenameExisting).toHaveBeenCalledTimes(1);
    expect(view.container.textContent).toContain('Назва відрізняється від вибраного фільтра.');
  });

  it('wires save, update, and delete buttons into their callbacks', async () => {
    const onSaveAsNew = vi.fn();
    const onUpdateExisting = vi.fn();
    const onDeleteLoadedSavedFilter = vi.fn();
    const view = await renderComponent(
      buildProps({
        savedFilterName: 'Base filter',
        loadedSavedFilter: buildSavedFilter(1, 'Base filter'),
        isDirty: true,
        onSaveAsNew,
        onUpdateExisting,
        onDeleteLoadedSavedFilter,
      }),
    );
    rendered.push(view);

    expect(view.container.textContent).toContain('Фільтр "Base filter": є незбережені зміни.');

    await click(getButton(view.container, 'Оновити вибраний'));
    await click(getButton(view.container, 'Зберегти як новий'));
    await click(getButton(view.container, 'Видалити'));

    expect(onSaveAsNew).toHaveBeenCalledTimes(1);
    expect(onUpdateExisting).toHaveBeenCalledTimes(1);
    expect(onDeleteLoadedSavedFilter).toHaveBeenCalledTimes(1);
  });

  it('explains the rename flow separately when only the name changed', async () => {
    const view = await renderComponent(
      buildProps({
        savedFilterName: 'Changed name',
        loadedSavedFilter: buildSavedFilter(1, 'Base filter'),
      }),
    );
    rendered.push(view);

    expect(view.container.textContent).toContain('Фільтр "Base filter": змінено назву.');
  });
});
