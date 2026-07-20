/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const editorMock = vi.hoisted(() => vi.fn());
const notifyMock = vi.hoisted(() => vi.fn());

vi.mock('./useOrganismKeywordSetsEditor', () => ({
  useOrganismKeywordSetsEditor: (...args: unknown[]) => editorMock(...args),
}));
vi.mock('../../components/PowerSnackbar', () => ({
  usePowerSnackbar: () => ({ notify: notifyMock }),
}));
vi.mock('../../components/KeywordFormsEditor', () => ({
  KeywordFormsEditor: () => <div data-testid="keyword-editor" />,
}));
vi.mock('./dialogs', () => ({ DeleteConfirmDialog: () => null }));

import { FeedKeywordsPanel } from './FeedKeywordsPanel';

const selected = { id: 1, name: 'Alpha', words: ['alpha'], canEdit: true, canDelete: true };
const filter = { highlightKeywordSetId: 1, highlightKeywordsEnabled: true } as never;

function setup(overrides: Record<string, unknown> = {}) {
  const saveEditorSet = vi.fn().mockResolvedValue(1);
  editorMock.mockReturnValue({
    selected,
    name: selected.name,
    words: selected.words,
    setWords: vi.fn(),
    isDirty: true,
    saving: false,
    saveError: null,
    syncSelectedId: vi.fn(),
    clearSaveError: vi.fn(),
    discardChanges: vi.fn(),
    handleSave: saveEditorSet,
    handleCreate: vi.fn().mockResolvedValue(2),
    handleRename: vi.fn().mockResolvedValue(true),
    handleDelete: vi.fn().mockResolvedValue(null),
    ...overrides,
  });
  return { saveEditorSet };
}

async function renderPanel() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onFilterChange = vi.fn();
  await act(async () => {
    root.render(
      <FeedKeywordsPanel
        feedId="feed-1"
        filter={filter}
        keywordSets={[selected as never]}
        onFilterChange={onFilterChange}
        onKeywordSetsReload={vi.fn().mockResolvedValue(undefined)}
      />,
    );
  });
  return { container, root, onFilterChange };
}

async function openEditor(container: HTMLDivElement) {
  await act(async () => {
    container
      .querySelector<HTMLButtonElement>('button[aria-label="Дії з наборами ключових слів"]')
      ?.click();
  });
  const edit = Array.from(document.body.querySelectorAll('li,button')).find((node) =>
    node.textContent?.includes('Редагувати слова'),
  );
  await act(async () => (edit as HTMLElement)?.click());
}

describe('FeedKeywordsPanel success notifications', () => {
  beforeEach(() => {
    notifyMock.mockReset();
    editorMock.mockReset();
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('notifies after handleSave resolves, preserving selection and collapse', async () => {
    const { saveEditorSet } = setup();
    let resolveSave!: (id: number) => void;
    saveEditorSet.mockImplementation(
      () =>
        new Promise<number>((resolve) => {
          resolveSave = resolve;
        }),
    );
    const { container, root, onFilterChange } = await renderPanel();
    await openEditor(container);
    expect(container.querySelector('[data-testid="keyword-editor"]')).not.toBeNull();

    const saveButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Зберегти',
    );
    await act(async () => (saveButton as HTMLElement)?.click());
    expect(saveEditorSet).toHaveBeenCalledTimes(1);
    expect(notifyMock).not.toHaveBeenCalled();
    expect(onFilterChange).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="keyword-editor"]')).not.toBeNull();
    resolveSave(7);
    await act(async () => Promise.resolve());
    expect(notifyMock).toHaveBeenCalledWith({ severity: 'success', message: 'Збережено' });
    expect(onFilterChange).toHaveBeenCalledWith('feed-1', {
      ...filter,
      highlightKeywordSetId: 7,
      highlightKeywordsEnabled: null,
    });
    expect(container.querySelector('[data-testid="keyword-editor"]')).toBeNull();
    await act(async () => root.unmount());
  });

  it('does not notify when handleSave returns null and keeps the editor open', async () => {
    const handleSave = vi.fn().mockResolvedValue(null);
    setup({ saveError: 'save failed', handleSave });
    const { container, root, onFilterChange } = await renderPanel();
    await openEditor(container);
    const saveButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Зберегти',
    );
    await act(async () => (saveButton as HTMLElement)?.click());
    expect(handleSave).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('save failed');
    expect(notifyMock).not.toHaveBeenCalled();
    expect(onFilterChange).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="keyword-editor"]')).not.toBeNull();
    await act(async () => root.unmount());
  });
});
