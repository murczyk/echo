/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiAgentMapDocument, AiAgentMapSummary } from '../../../../../Bindings';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  download: vi.fn(),
  notify: vi.fn(),
  select: vi.fn(),
}));
vi.mock('../../../services/api/ai-agent', () => ({
  getAiAgentMap: mocks.get,
  downloadAiAgentMap: mocks.download,
}));
vi.mock('../../../components/PowerSnackbar', () => ({
  usePowerSnackbar: () => ({ notify: mocks.notify }),
}));
vi.mock('../MapCanvas', () => ({
  default: ({
    document,
    onSelect,
  }: {
    document: AiAgentMapDocument;
    onSelect: (index: number) => void;
  }) => <button onClick={() => onSelect(0)}>{document.records[0]?.name}</button>,
}));
vi.mock('../../shared/message-card/CoordinatePreviewMapSurface', () => ({
  CoordinatePreviewMapSurface: () => <span>Точки</span>,
}));
import { CitationMarkdown } from '../CitationMarkdown';
import { MapPanel } from '../MapPanel';
import { MapSelectionContext } from '../map-documents';

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
    await render(<MapPanel key={summary.id} summary={summary} onClose={() => {}} />);
    await render(<MapPanel key={next.id} summary={next} onClose={() => {}} />);
    expect(obsoleteSignal?.aborted).toBe(true);
    await act(async () => finish(mapDocument()));
    expect(container.textContent).toContain('Підмапа подія');
    expect(container.textContent).not.toContain('Головна мапа подія');
    expect(mocks.notify).not.toHaveBeenCalled();
    await click('Підмапа подія');
    expect(container.querySelector('[data-testid="ai-map-record-details"]')?.textContent).toContain(
      'Вантаж А',
    );
  });
  it('explains unavailable KMZ, permits CSV, and displays download errors', async () => {
    const empty = { ...summary, validCount: 0, invalidCount: 1, warnings: ['Рядок 1: INVALID'] };
    mocks.get.mockResolvedValue(mapDocument(empty));
    mocks.download.mockRejectedValue(new Error('HTTP 403'));
    await render(<MapPanel summary={empty} onClose={() => {}} />);
    expect(container.textContent).toContain('KMZ недоступний');
    await click('Завантажити мапу');
    const kmz = [...document.querySelectorAll('[role="menuitem"]')].find(
      (item) => item.textContent === 'KMZ',
    );
    expect(kmz?.getAttribute('aria-disabled')).toBe('true');
    await click('CSV');
    expect(mocks.download).toHaveBeenCalledWith(empty, 'csv');
    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ severity: 'error' }));
  });
  it('toasts retrieval failures and retries the selected document', async () => {
    mocks.get.mockRejectedValueOnce(new Error('HTTP 403'));
    await render(<MapPanel summary={summary} onClose={() => {}} />);
    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ severity: 'error' }));
    await click('Спробувати ще раз');
    expect(container.textContent).toContain('Головна мапа подія');
  });
});
