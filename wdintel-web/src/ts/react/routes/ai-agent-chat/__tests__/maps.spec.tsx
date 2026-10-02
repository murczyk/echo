/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiAgentMapDocument, AiAgentMapSummary } from '../../../../../Bindings';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  download: vi.fn(),
  edit: vi.fn(),
  undo: vi.fn(),
  redo: vi.fn(),
  notify: vi.fn(),
  select: vi.fn(),
  workspaceFrom: (document: object, revision = 1) => ({
    revision,
    canUndo: revision > 1,
    canRedo: false,
    document,
    changes: { addedCount: 0, updatedCount: 0, removedCount: 0, changes: [] },
    revisions: [
      {
        revision,
        parentRevision: revision > 1 ? revision - 1 : null,
        origin: revision > 1 ? 'user' : 'artifact',
        summary: revision > 1 ? 'Змінено 1' : 'Опублікована мапа',
        createdAt: '2026-10-01T10:00:00',
      },
    ],
  }),
}));
vi.mock('../../../services/api/ai-agent', () => ({
  getAiAgentMap: mocks.get,
  downloadAiAgentMap: mocks.download,
  openAiAgentMapWorkspace: (summary: unknown, signal?: AbortSignal) =>
    Promise.resolve(mocks.get(summary, signal)).then((document) => mocks.workspaceFrom(document)),
  editAiAgentMap: mocks.edit,
  undoAiAgentMap: mocks.undo,
  redoAiAgentMap: mocks.redo,
}));
vi.mock('../../../components/PowerSnackbar', () => ({
  usePowerSnackbar: () => ({ notify: mocks.notify }),
}));
vi.mock('../MapCanvas', () => ({
  default: ({
    records,
    onSelect,
  }: {
    records: AiAgentMapDocument['records'];
    onSelect: (id: string, additive: boolean) => void;
  }) => (
    <div>
      {records.map((record) => (
        <button
          key={record.id}
          aria-label={`Точка ${record.name}`}
          onClick={() => onSelect(record.id, false)}
        >
          {record.name}
        </button>
      ))}
    </div>
  ),
}));
vi.mock('../app6d-catalog', async (importOriginal) => {
  const { APP6D_CATALOG } = await import('./app6d-catalog-fixture');
  return {
    ...(await importOriginal<typeof import('../app6d-catalog')>()),
    loadCatalog: () => Promise.resolve(APP6D_CATALOG),
  };
});
vi.mock('../../shared/message-card/CoordinatePreviewMapSurface', () => ({
  CoordinatePreviewMapSurface: () => <span>Точки</span>,
}));
import { HttpRequestError } from '../../../services/api/client';
import { CitationMarkdown } from '../CitationMarkdown';
import { MapWorkspace } from '../MapWorkspace';
import {
  loadSharedMapDocument,
  MapSelectionContext,
  resetSharedMapDocuments,
} from '../map-documents';

const summary: AiAgentMapSummary = {
  id: '11111111-1111-4111-8111-111111111111',
  requestId: '22222222-2222-4222-8222-222222222222',
  title: 'Головна мапа',
  isMain: true,
  totalCount: 1,
  validCount: 1,
  invalidCount: 0,
  warnings: [],
};
const mapDocument = (value = summary): AiAgentMapDocument => ({
  ...value,
  records: [
    {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      sidc: '10062000001209020000',
      name: value.title + ' подія',
      observationDatetime: '2026-09-28T11:20:00',
      coordinateSystem: 'msk2000',
      platformType: 'CAPDOC',
      originalX: '52-15227',
      originalY: '6548669',
      x: '5215227',
      y: '6548669',
      latitude: 47.068994,
      longitude: 33.639175,
      comments: ['Вантаж А'],
      sources: [],
      warnings: [],
    },
  ],
});
let container: HTMLDivElement;
let root: Root;
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
async function render(element: React.ReactNode) {
  await act(async () => root.render(element));
  await flush();
}
async function keydown(init: KeyboardEventInit) {
  const target = document.querySelector('[data-testid="ai-map-workspace"]');
  expect(target).not.toBeNull();
  await act(async () =>
    target?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init })),
  );
  await flush();
}
async function click(label: string) {
  const target = [...document.querySelectorAll('button,[role="menuitem"]')].find(
    (button) => button.getAttribute('aria-label') === label || button.textContent?.trim() === label,
  );
  expect(target).toBeDefined();
  await act(async () => target?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await flush();
}
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.get.mockResolvedValue(mapDocument());
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  }));
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  mocks.dirty = false;
  resetSharedMapDocuments();
});

describe('#3064 map documents', () => {
  it('loads registered inline chips lazily and leaves invented references inert', async () => {
    let visible: IntersectionObserverCallback = () => {};
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: IntersectionObserverCallback) {
          visible = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    await render(
      <MapSelectionContext.Provider value={mocks.select}>
        <CitationMarkdown
          maps={[summary]}
        >{`[мапа](echo-map:${summary.id}) [мапа](echo-map:invented)`}</CitationMarkdown>
      </MapSelectionContext.Provider>,
    );
    expect(mocks.get).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Мапа недоступна');
    await act(async () =>
      visible([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver),
    );
    await flush();
    expect(mocks.get).toHaveBeenCalledTimes(1);
    await click('Відкрити мапу: Головна мапа');
    expect(mocks.select.mock.calls[0][0]).toEqual(summary);
  });
  it('shares one artifact load between thumbnails', async () => {
    const first = loadSharedMapDocument(summary);
    const second = loadSharedMapDocument(summary);
    expect(second).toBe(first);
    await first;
    expect(mocks.get).toHaveBeenCalledTimes(1);
    const third = loadSharedMapDocument(summary);
    expect(third).not.toBe(first);
    await third;
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });
  it('ignores an obsolete load after replacing the selected map', async () => {
    let finish: (document: AiAgentMapDocument) => void = () => {};
    let obsoleteSignal: AbortSignal | undefined;
    mocks.get.mockImplementationOnce((_summary: AiAgentMapSummary, signal: AbortSignal) => {
      obsoleteSignal = signal;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const next = {
      ...summary,
      id: '33333333-3333-4333-8333-333333333333',
      title: 'Підмапа',
      isMain: false,
    };
    mocks.get.mockResolvedValueOnce(mapDocument(next));
    await render(<MapWorkspace key={summary.id} summary={summary} onClose={() => {}} />);
    await render(<MapWorkspace key={next.id} summary={next} onClose={() => {}} />);
    expect(obsoleteSignal?.aborted).toBe(true);
    await act(async () => finish(mapDocument()));
    expect(container.textContent).toContain('Підмапа подія');
    expect(container.textContent).not.toContain('Головна мапа подія');
    expect(mocks.notify).not.toHaveBeenCalled();
    await click('Точка Підмапа подія');
    expect(container.querySelector('[data-testid="ai-map-record-details"]')?.textContent).toContain(
      'Вантаж А',
    );
  });
  it('explains unavailable KMZ, permits CSV, and displays download errors', async () => {
    const empty = { ...summary, validCount: 0, invalidCount: 1, warnings: ['Рядок 1: INVALID'] };
    const document = mapDocument(empty);
    document.records[0] = { ...document.records[0], latitude: null, longitude: null };
    mocks.get.mockResolvedValue(document);
    mocks.download.mockRejectedValue(new Error('HTTP 403'));
    await render(<MapWorkspace summary={empty} onClose={() => {}} />);
    expect(container.textContent).toContain('1 без координат');
    await click('Завантажити мапу');
    const kmz = [...window.document.querySelectorAll('[role="menuitem"]')].find((item) =>
      item.textContent?.startsWith('KMZ'),
    );
    expect(kmz?.getAttribute('aria-disabled')).toBe('true');
    expect(kmz?.textContent).toContain('немає коректних точок');
    await click('CSV');
    expect(mocks.download).toHaveBeenCalledWith(empty, 'csv', []);
    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ severity: 'error' }));
  });
  it('toasts retrieval failures and retries the selected document', async () => {
    mocks.get.mockRejectedValueOnce(new Error('HTTP 403'));
    await render(<MapWorkspace summary={summary} onClose={() => {}} />);
    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ severity: 'error' }));
    await click('Спробувати ще раз');
    expect(container.textContent).toContain('Головна мапа подія');
  });
  it('closes on Escape even while the map is still loading', async () => {
    mocks.get.mockReturnValueOnce(new Promise(() => {}));
    const onClose = vi.fn();
    await render(<MapWorkspace summary={summary} onClose={onClose} />);
    await keydown({ key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
  it('removes the selection as one revision, offers undo, and reloads after a conflict', async () => {
    mocks.edit.mockRejectedValueOnce(
      new HttpRequestError(409, 'Мапа змінилася. Оновіть перегляд і повторіть дію.'),
    );
    mocks.edit.mockResolvedValueOnce({ revision: 2 });
    await render(<MapWorkspace summary={summary} onClose={() => {}} />);
    await click('Точка Головна мапа подія');
    await click('Видалити вибрані');
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Мапа змінилася. Оновіть перегляд і повторіть дію.' }),
    );
    await click('Точка Головна мапа подія');
    await keydown({ key: 'Delete' });
    expect(mocks.edit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        requestId: summary.requestId,
        mapId: summary.id,
        expectedRevision: 1,
        operations: [
          expect.objectContaining({
            op: 'remove',
            selector: expect.objectContaining({ ids: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'] }),
          }),
        ],
      }),
    );
    expect(mocks.notify).toHaveBeenLastCalledWith(expect.objectContaining({ severity: 'info' }));
  });
  it('changes the identity of the selection through the symbol editor', async () => {
    mocks.edit.mockResolvedValue({ revision: 2 });
    await render(<MapWorkspace summary={summary} onClose={() => {}} />);
    await click('Точка Головна мапа подія');
    expect(container.textContent).toContain('Ворожий');
    await click('Дружній');
    await click('Застосувати до 1');
    expect(mocks.edit).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevision: 1,
        operations: [
          expect.objectContaining({
            op: 'setComponents',
            selector: expect.objectContaining({ ids: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'] }),
            components: expect.objectContaining({ identity: '3', symbolSet: null }),
          }),
        ],
      }),
    );
  });
  it('keeps rare identities and the echelon out of the way and selects all filtered records', async () => {
    mocks.edit.mockResolvedValue({ revision: 2 });
    const document = mapDocument();
    document.records.push({
      ...document.records[0],
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      name: 'Інша точка',
    });
    mocks.get.mockResolvedValue(document);
    await render(<MapWorkspace summary={summary} onClose={() => {}} />);
    await click('Вибрати всі (2)');
    const editor = () => container.querySelector('[data-testid="ai-map-symbol-editor"]')!;
    expect(editor().textContent).toContain('2 точок');
    expect(editor().textContent).not.toContain('Нейтральний');
    expect(editor().textContent).not.toContain('Ешелон');
    expect(
      (editor().querySelector('input[role="combobox"]') as HTMLInputElement | null)?.value,
    ).toBeTruthy();
    await click('Інша приналежність');
    await click('Нейтральний');
    expect(editor().textContent).toContain('Нейтральний');
    await click('Більше');
    expect(editor().textContent).toContain('Ешелон');
    await click('Застосувати до 2');
    expect(mocks.edit).toHaveBeenCalledWith(
      expect.objectContaining({
        operations: [
          expect.objectContaining({
            selector: expect.objectContaining({
              ids: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'],
            }),
            components: expect.objectContaining({ identity: '4' }),
          }),
        ],
      }),
    );
  });
  it('renames the map and undoes with the keyboard on a narrow viewport', async () => {
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    }));
    mocks.edit.mockResolvedValue({ revision: 2 });
    mocks.undo.mockResolvedValue(mocks.workspaceFrom(mapDocument()));
    const original = mocks.workspaceFrom;
    mocks.workspaceFrom = (document: object) =>
      original(document, mocks.edit.mock.calls.length ? 2 : 1);
    try {
      await render(<MapWorkspace summary={summary} onClose={() => {}} />);
      const title = window.document.querySelector<HTMLInputElement>(
        'input[aria-label="Назва мапи"]',
      )!;
      await act(async () => {
        title.focus();
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setter?.call(title, 'Нова назва');
        title.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await act(async () => title.blur());
      await flush();
      expect(mocks.edit).toHaveBeenCalledWith(
        expect.objectContaining({
          operations: [expect.objectContaining({ op: 'setTitle', title: 'Нова назва' })],
        }),
      );
      await keydown({ key: 'z', ctrlKey: true });
      expect(mocks.undo).toHaveBeenCalledWith({
        requestId: summary.requestId,
        mapId: summary.id,
        expectedRevision: 2,
      });
    } finally {
      mocks.workspaceFrom = original;
    }
  });
});
