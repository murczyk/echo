/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  update: vi.fn(),
  notify: vi.fn(),
}));

vi.mock('../../../services/api/goi-settings', () => ({
  fetchGoiReportTabOrder: mocks.fetch,
  updateGoiReportTabOrder: mocks.update,
}));
vi.mock('../../../components/PowerSnackbar', () => ({
  usePowerSnackbar: () => ({ notify: mocks.notify }),
}));
vi.mock('../../../components/PowerAlert', () => ({
  PowerAlert: ({ children, severity }: { children: unknown; severity: string }) => (
    <div role={severity === 'error' ? 'alert' : 'status'}>{children}</div>
  ),
}));
vi.mock('../../../components/PowerButton', () => ({
  PowerButton: ({
    children,
    onClick,
    disabled,
  }: {
    children: unknown;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));
vi.mock('@dnd-kit/core', () => ({
  DndContext: ({
    children,
    onDragEnd,
  }: {
    children: unknown;
    onDragEnd?: (event: unknown) => void;
  }) => (
    <>
      <button
        type="button"
        data-testid="move-item"
        onClick={() => onDragEnd?.({ active: { id: 1 }, over: { id: 2 } })}
      >
        move
      </button>
      {children}
    </>
  ),
  KeyboardSensor: class {},
  PointerSensor: class {},
  closestCenter: vi.fn(),
  useSensor: vi.fn(() => ({})),
  useSensors: vi.fn(() => []),
}));
vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children: unknown }) => <>{children}</>,
  arrayMove: (items: unknown[], from: number, to: number) => {
    const next = [...items];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    return next;
  },
  sortableKeyboardCoordinates: vi.fn(),
  useSortable: () => ({
    attributes: {},
    listeners: {},
    transform: null,
    transition: undefined,
    setNodeRef: vi.fn(),
  }),
  verticalListSortingStrategy: {},
}));
vi.mock('@dnd-kit/utilities', () => ({ CSS: { Transform: { toString: () => undefined } } }));

import { GoiReportTabOrderSection } from '.././GoiReportTabOrderSection';

const integration = {
  id: 7,
  ownerOrganismId: 1,
  ownerOrganismName: 'Організм',
  integrationType: 'full',
  serverLabel: 'Сервер ГОІ',
  goiUrl: 'https://goi.example',
  swappUrl: null,
  hasDataAccess: true,
  pauseWorker: false,
  canChangePauseWorker: true,
  canRestart: true,
  restartUnavailableReason: null,
};

async function renderSection() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(<GoiReportTabOrderSection integrations={[integration]} isAdmin={false} />),
  );
  await act(async () => Promise.resolve());
  return { container, root };
}

// @test-scope safeguard: prevents a GOI report-tab reordering from claiming success before persistence or hiding contextual failures.
describe('GoiReportTabOrderSection notifications', () => {
  beforeEach(() => {
    mocks.fetch.mockReset();
    mocks.update.mockReset();
    mocks.notify.mockReset();
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('keeps an empty result contextual and does not notify', async () => {
    mocks.fetch.mockResolvedValue([]);
    const { container, root } = await renderSection();
    expect(container.textContent).toContain('Смуг для звіту не знайдено.');
    expect(mocks.notify).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it('keeps a load failure contextual and does not notify', async () => {
    mocks.fetch.mockRejectedValue(new Error('load failed'));
    const { container, root } = await renderSection();
    expect(container.textContent).toContain('load failed');
    expect(mocks.notify).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it('saves a real reorder and notifies after the update resolves', async () => {
    const items = [
      { aorId: 1, aorName: 'One', orderForReport: 10 },
      { aorId: 2, aorName: 'Two', orderForReport: 20 },
    ];
    mocks.fetch.mockResolvedValue(items);
    let resolveUpdate!: (value: typeof items) => void;
    mocks.update.mockReturnValue(new Promise((resolve) => (resolveUpdate = resolve)));
    const { container, root } = await renderSection();
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="move-item"]')?.click(),
    );
    const saveButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Зберегти'),
    );
    expect(saveButton).not.toBeUndefined();
    await act(async () => saveButton?.click());
    expect(mocks.update).toHaveBeenCalledWith({
      integrationId: 7,
      items: [
        { ...items[1], orderForReport: 10 },
        { ...items[0], orderForReport: 20 },
      ],
    });
    expect(mocks.notify).not.toHaveBeenCalled();
    resolveUpdate(items);
    await act(async () => Promise.resolve());
    expect(mocks.notify).toHaveBeenCalledWith({
      severity: 'success',
      message: 'Порядок вкладок збережено',
    });
    await act(async () => root.unmount());
  });
});
