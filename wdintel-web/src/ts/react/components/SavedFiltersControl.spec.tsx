/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

type TestSavedFilter = {
  id: number;
  name: string;
};

vi.mock('@mui/material', () => ({
  Autocomplete: (props: {
    options: TestSavedFilter[];
    value: TestSavedFilter | null;
    onChange?: (_event: Event, next: TestSavedFilter | null) => void;
    renderInput: (params: object) => ReactNode;
  }) => (
    <div>
      {props.renderInput({})}
      <button type="button" onClick={() => props.onChange?.(new Event('change'), props.options[0] ?? null)}>
        select-first
      </button>
      <button type="button" onClick={() => props.onChange?.(new Event('change'), null)}>
        clear
      </button>
      <div data-testid="selected-filter">{props.value?.name ?? ''}</div>
    </div>
  ),
  Box: ({ children, component: Component = 'div', ...props }: { children: ReactNode; component?: string }) => (
    <Component {...props}>{children}</Component>
  ),
  Button: (props: {
    children: ReactNode;
    disabled?: boolean;
    onClick?: () => void;
    type?: string;
  }) => (
    <button type={props.type ?? 'button'} disabled={props.disabled} onClick={props.onClick}>
      {props.children}
    </button>
  ),
  Chip: ({ label }: { label: string }) => <span>{label}</span>,
  Dialog: ({ children, open }: { children: ReactNode; open: boolean }) => (open ? <div>{children}</div> : null),
  DialogActions: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  IconButton: (props: { children: ReactNode; disabled?: boolean; onClick?: (event: unknown) => void; 'aria-label'?: string }) => (
    <button type="button" aria-label={props['aria-label']} disabled={props.disabled} onClick={props.onClick}>
      {props.children}
    </button>
  ),
  Menu: ({ children, open }: { children: ReactNode; open: boolean }) => (open ? <div>{children}</div> : null),
  MenuItem: (props: { children: ReactNode; disabled?: boolean; onClick?: () => void }) => (
    <button type="button" disabled={props.disabled} onClick={props.onClick}>
      {props.children}
    </button>
  ),
  Paper: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Stack: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TextField: (props: { label?: string; value?: string; onChange?: (event: { target: { value: string } }) => void }) => (
    <label>
      <span>{props.label}</span>
      <input
        value={props.value ?? ''}
        onChange={(event) => props.onChange?.({ target: { value: event.currentTarget.value } })}
      />
    </label>
  ),
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import { SavedFiltersControl } from './SavedFiltersControl';
import type { SavedFiltersControlProps } from './SavedFiltersControl';

type Rendered = {
  container: HTMLDivElement;
  root: Root;
};

function buildSavedFilter(id: number, name: string): TestSavedFilter {
  return { id, name };
}

function buildProps(overrides: Partial<SavedFiltersControlProps<TestSavedFilter>> = {}) {
  return {
    savedFilters: [buildSavedFilter(1, 'Base filter'), buildSavedFilter(2, 'Alt filter')],
    selectedSavedFilter: null,
    savedFilterName: '',
    isDirty: false,
    saveInFlight: false,
    onApplySavedFilter: vi.fn(),
    onSavedFilterNameChange: vi.fn(),
    onUpdateExisting: vi.fn(),
    onSaveAsNew: vi.fn(),
    onRenameExisting: vi.fn(),
    onDeleteExisting: vi.fn(),
    ...overrides,
  } satisfies SavedFiltersControlProps<TestSavedFilter>;
}

async function renderComponent(
  props: SavedFiltersControlProps<TestSavedFilter>,
): Promise<Rendered> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<SavedFiltersControl {...props} />);
  });
  return { container, root };
}

function getButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.includes(label));
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Button not found: ${label}`);
  return button;
}

function getButtonByAriaLabel(container: HTMLElement, ariaLabel: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find(
    (item) => item.getAttribute('aria-label') === ariaLabel,
  );
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Button not found: ${ariaLabel}`);
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

describe('SavedFiltersControl', () => {
  const rendered: Rendered[] = [];

  afterEach(() => {
    for (const item of rendered.splice(0)) {
      act(() => {
        item.root.unmount();
      });
      item.container.remove();
    }
  });

  it('applies selected filters and reflects the selected value', async () => {
    const onApplySavedFilter = vi.fn();
    const view = await renderComponent(
      buildProps({
        selectedSavedFilter: buildSavedFilter(1, 'Base filter'),
        savedFilterName: 'Base filter',
        onApplySavedFilter,
      }),
    );
    rendered.push(view);

    expect(view.container.textContent).toContain('Збережені фільтри');
    expect(view.container.querySelector('[data-testid="selected-filter"]')?.textContent).toBe('Base filter');
    await click(getButton(view.container, 'select-first'));

    expect(onApplySavedFilter).toHaveBeenCalledWith(expect.objectContaining({ id: 2, name: 'Alt filter' }));
  });

  it('shows an empty state message when there are no saved filters', async () => {
    const view = await renderComponent(
      buildProps({
        savedFilters: [],
      }),
    );
    rendered.push(view);

    expect(view.container.textContent).toContain('Збережені фільтри відсутні');
  });

  it('can disable saving as new from the menu', async () => {
    const view = await renderComponent(
      buildProps({
        selectedSavedFilter: buildSavedFilter(1, 'Base filter'),
        savedFilterName: 'Base filter',
        canSaveAsNew: false,
      }),
    );
    rendered.push(view);

    await click(getButtonByAriaLabel(view.container, 'Дії зі збереженими фільтрами'));
    expect(getButton(view.container, 'Зберегти як новий').disabled).toBe(true);
  });

  it('saves as new and renames through compact dialogs', async () => {
    const onSaveAsNew = vi.fn();
    const onRenameExisting = vi.fn();
    const onSavedFilterNameChange = vi.fn();
    const view = await renderComponent(
      buildProps({
        selectedSavedFilter: buildSavedFilter(1, 'Base filter'),
        savedFilterName: 'Draft name',
        onSaveAsNew,
        onRenameExisting,
        onSavedFilterNameChange,
      }),
    );
    rendered.push(view);

    await click(getButtonByAriaLabel(view.container, 'Дії зі збереженими фільтрами'));
    await click(getButton(view.container, 'Зберегти як новий'));
    const saveDialogInput = getInput(view.container, 'Назва');
    await typeInput(saveDialogInput, 'New filter');
    await click(getButton(view.container, 'Зберегти'));

    expect(onSaveAsNew).toHaveBeenCalledWith('New filter');
    expect(onSavedFilterNameChange).toHaveBeenCalledWith('New filter');

    await click(getButtonByAriaLabel(view.container, 'Дії зі збереженими фільтрами'));
    await click(getButton(view.container, 'Перейменувати'));
    const renameDialogInput = getInput(view.container, 'Назва');
    await typeInput(renameDialogInput, 'Updated filter');
    await click(getButton(view.container, 'Перейменувати'));

    expect(onRenameExisting).toHaveBeenCalledWith('Updated filter');
  });

  it('keeps the dialog open when the action reports failure', async () => {
    const onSaveAsNew = vi.fn().mockResolvedValue(false);
    const onSavedFilterNameChange = vi.fn();
    const view = await renderComponent(
      buildProps({
        selectedSavedFilter: buildSavedFilter(1, 'Base filter'),
        savedFilterName: 'Draft name',
        onSaveAsNew,
        onSavedFilterNameChange,
      }),
    );
    rendered.push(view);

    await click(getButtonByAriaLabel(view.container, 'Дії зі збереженими фільтрами'));
    await click(getButton(view.container, 'Зберегти як новий'));
    await typeInput(getInput(view.container, 'Назва'), 'New filter');
    await click(getButton(view.container, 'Зберегти'));

    expect(onSaveAsNew).toHaveBeenCalledWith('New filter');
    expect(onSavedFilterNameChange).not.toHaveBeenCalled();
    expect(view.container.textContent).toContain('Зберегти як новий');
  });

  it('runs update and delete actions from the menu', async () => {
    const onUpdateExisting = vi.fn();
    const onDeleteExisting = vi.fn();
    const view = await renderComponent(
      buildProps({
        selectedSavedFilter: buildSavedFilter(1, 'Base filter'),
        savedFilterName: 'Base filter',
        isDirty: true,
        onUpdateExisting,
        onDeleteExisting,
      }),
    );
    rendered.push(view);

    await click(getButtonByAriaLabel(view.container, 'Дії зі збереженими фільтрами'));
    await click(getButton(view.container, 'Оновити вибраний фільтр'));
    await click(getButtonByAriaLabel(view.container, 'Дії зі збереженими фільтрами'));
    await click(getButton(view.container, 'Видалити'));

    expect(onUpdateExisting).toHaveBeenCalledTimes(1);
    expect(onDeleteExisting).toHaveBeenCalledTimes(1);
  });

  it('keeps the menu enabled when no filter is selected', async () => {
    const view = await renderComponent(buildProps());
    rendered.push(view);

    expect(getButtonByAriaLabel(view.container, 'Дії зі збереженими фільтрами').disabled).toBe(false);
    await click(getButtonByAriaLabel(view.container, 'Дії зі збереженими фільтрами'));
    expect(getButton(view.container, 'Зберегти як новий').disabled).toBe(false);
  });
});
