/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BattleLineState, BattleLineTestRsp } from '../../../../Bindings';
import { minimalInboxMessage } from '../rer-duty-neo/inbox-message-mocks';
import { AdminBattleLinePage } from './index';

const api = vi.hoisted(() => ({
  fetchBattleLineState: vi.fn(),
  fetchBattleLineUnlinkedInbox: vi.fn(),
  fetchBattleLineUnresolvedLocations: vi.fn(),
  testBattleLine: vi.fn(),
  uploadBattleLine: vi.fn(),
}));

vi.mock('../../services/api/battle-line', () => api);
vi.mock('../shared/message-card/MessageCard', () => ({
  MessageCard: ({ id }: { id: number }) => <div data-testid={`message-${id}`}>message {id}</div>,
}));
vi.mock('./BattleLineMap', () => ({
  BattleLineMap: ({
    selectedSettlements = [],
  }: {
    selectedSettlements?: Array<{ label: string }>;
  }) => (
    <div data-testid="battle-line-map">
      {selectedSettlements.map((settlement) => settlement.label).join(', ')}
    </div>
  ),
}));

function state(id = 2): BattleLineState {
  return {
    activeVersion: {
      id,
      sourceFileName: `active-${id}.kml`,
      uploaderLogin: 'admin',
      uploadedAtTs: 1_723_955_400_000,
      retiredAtTs: null,
    },
    activeFeatures: [],
    aorGeometries: [],
    previousVersions: [
      {
        id: 1,
        sourceFileName: 'previous.kml',
        uploaderLogin: 'operator',
        uploadedAtTs: 1_723_951_800_000,
        retiredAtTs: 1_723_955_400_000,
      },
    ],
  };
}

function testResponse(locations: BattleLineTestRsp['locations'] = []): BattleLineTestRsp {
  return {
    inboxItemId: 42,
    message: minimalInboxMessage(),
    groupMasterKeys: ['group'],
    aorIds: [5],
    locations,
    battleLine: state(),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

let container: HTMLDivElement;
let root: Root;

async function renderPage() {
  await act(async () => root.render(<AdminBattleLinePage />));
  await vi.waitFor(() => expect(container.textContent).toContain('active-2.kml'));
}

function button(label: string): HTMLButtonElement {
  const result = [...container.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(result instanceof HTMLButtonElement)) throw new Error(`button not found: ${label}`);
  return result;
}

async function setInputValue(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

beforeEach(() => {
  window.history.replaceState(null, '', '/admin/battle-line');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  Object.values(api).forEach((mock) => mock.mockReset());
  api.fetchBattleLineState.mockResolvedValue(state());
  api.fetchBattleLineUnlinkedInbox.mockResolvedValue({
    items: [[9, minimalInboxMessage()]],
    total: 11,
    pageSize: 10,
  });
  api.fetchBattleLineUnresolvedLocations.mockResolvedValue({
    items: [{ settlementText: 'НЕВІДОМО', itemCount: 4 }],
    total: 11,
    pageSize: 10,
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('AdminBattleLinePage', () => {
  it('pushes explicit tab values and restores them on browser navigation', async () => {
    window.history.replaceState(null, '', '/admin/battle-line?keep=1#map');
    await renderPage();
    expect(window.location.href).toContain('?keep=1&tab=lbz#map');
    const pushState = vi.spyOn(window.history, 'pushState');
    await act(async () => button('ПЕРЕХОПЛЕННЯ БЕЗ НП').click());
    expect(pushState).toHaveBeenCalledOnce();
    expect(window.location.href).toContain('?keep=1&tab=unlinked#map');
    window.history.replaceState(null, '', '/admin/battle-line?keep=1&tab=unresolved#map');
    await act(async () => window.dispatchEvent(new PopStateEvent('popstate')));
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain(
      'НЕВИЗНАЧЕНІ ЛОКАЦІЇ',
    );
  });

  it('renders current/history data and loads both paginated tabs', async () => {
    await renderPage();
    expect(container.textContent).toContain('previous.kml');
    expect(container.querySelector('[data-testid="battle-line-map"]')).not.toBeNull();

    await act(async () => button('ПЕРЕХОПЛЕННЯ БЕЗ НП').click());
    await vi.waitFor(() =>
      expect(container.querySelector('[data-testid="message-9"]')).not.toBeNull(),
    );
    expect(api.fetchBattleLineUnlinkedInbox).toHaveBeenCalledWith(
      { page: 1 },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await act(async () => button('2').click());
    await vi.waitFor(() =>
      expect(api.fetchBattleLineUnlinkedInbox).toHaveBeenLastCalledWith(
        { page: 2 },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );

    await act(async () => button('НЕВИЗНАЧЕНІ ЛОКАЦІЇ').click());
    await vi.waitFor(() => expect(container.textContent).toContain('НЕВІДОМО'));
    expect(container.textContent).toContain('4');
    expect(api.fetchBattleLineUnresolvedLocations).toHaveBeenCalledWith(
      { page: 1 },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await act(async () => button('2').click());
    await vi.waitFor(() =>
      expect(api.fetchBattleLineUnresolvedLocations).toHaveBeenLastCalledWith(
        { page: 2 },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
  });

  it('stops showing loading indicators when paginated requests fail', async () => {
    await renderPage();
    api.fetchBattleLineUnlinkedInbox.mockRejectedValueOnce(new Error('unlinked failed'));

    await act(async () => button('ПЕРЕХОПЛЕННЯ БЕЗ НП').click());
    await vi.waitFor(() => expect(container.textContent).toContain('unlinked failed'));
    expect(container.querySelector('[role="progressbar"]')).toBeNull();

    api.fetchBattleLineUnresolvedLocations.mockRejectedValueOnce(new Error('unresolved failed'));
    await act(async () => button('НЕВИЗНАЧЕНІ ЛОКАЦІЇ').click());
    await vi.waitFor(() => expect(container.textContent).toContain('unresolved failed'));
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
  });

  it('shows the empty test state and clears a superseded result after upload', async () => {
    await renderPage();
    api.testBattleLine.mockResolvedValueOnce(testResponse());
    const idInput = container.querySelector('input:not([type="file"])');
    if (!(idInput instanceof HTMLInputElement)) throw new Error('ID input not found');
    await setInputValue(idInput, '42');
    await act(async () => button('Перевірити').click());
    await vi.waitFor(() => expect(container.textContent).toContain('У location_v2 немає локацій'));
    expect(api.testBattleLine).toHaveBeenCalledWith({ inboxItemId: '42', messageUid: null });

    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );
    api.uploadBattleLine.mockResolvedValueOnce(state(3));
    api.fetchBattleLineState.mockResolvedValueOnce(state(3));
    const fileInput = container.querySelector('input[type="file"]');
    if (!(fileInput instanceof HTMLInputElement)) throw new Error('file input not found');
    Object.defineProperty(fileInput, 'files', {
      configurable: true,
      value: [new File(['x'], 'next.kml')],
    });
    await act(async () => fileInput.dispatchEvent(new Event('change', { bubbles: true })));
    await vi.waitFor(() => expect(container.textContent).toContain('active-3.kml'));

    expect(container.querySelector('[data-testid="message-42"]')).toBeNull();
    expect(container.textContent).not.toContain('У location_v2 немає локацій');
  });

  it('searches for a Battle Line test message by message UID', async () => {
    await renderPage();
    api.testBattleLine.mockResolvedValueOnce(testResponse());
    await act(async () => button('UID').click());
    const idInput = container.querySelector('input:not([type="file"])');
    if (!(idInput instanceof HTMLInputElement)) throw new Error('ID input not found');
    await setInputValue(idInput, 'signal-message-uid');
    await act(async () => button('Перевірити').click());

    await vi.waitFor(() =>
      expect(api.testBattleLine).toHaveBeenCalledWith({
        inboxItemId: null,
        messageUid: 'signal-message-uid',
      }),
    );
  });

  it('ignores a pending test response and reports an upload refresh failure', async () => {
    await renderPage();
    const pendingTest = deferred<BattleLineTestRsp>();
    api.testBattleLine.mockReturnValueOnce(pendingTest.promise);
    const idInput = container.querySelector('input:not([type="file"])');
    if (!(idInput instanceof HTMLInputElement)) throw new Error('ID input not found');
    await setInputValue(idInput, '42');
    await act(async () => button('Перевірити').click());

    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );
    api.uploadBattleLine.mockResolvedValueOnce(state(3));
    api.fetchBattleLineState.mockRejectedValueOnce(new Error('refresh failed'));
    const fileInput = container.querySelector('input[type="file"]');
    if (!(fileInput instanceof HTMLInputElement)) throw new Error('file input not found');
    Object.defineProperty(fileInput, 'files', {
      configurable: true,
      value: [new File(['x'], 'next.kml')],
    });
    await act(async () => fileInput.dispatchEvent(new Event('change', { bubbles: true })));
    await vi.waitFor(() => expect(container.textContent).toContain('refresh failed'));

    pendingTest.resolve(
      testResponse([
        {
          location: 'ХАРКІВ',
          candidates: [],
          chosenSettlementId: null,
          distanceM: null,
          invalidAorIds: [],
        },
      ]),
    );
    await act(async () => pendingTest.promise);
    expect(container.querySelector('[data-testid="message-42"]')).toBeNull();
    expect(container.textContent).not.toContain('ХАРКІВ');
  });

  it('passes the chosen settlement to the map and clears it after a test error', async () => {
    await renderPage();
    api.testBattleLine.mockResolvedValueOnce(
      testResponse([
        {
          location: 'ХАРКІВ',
          candidates: [
            {
              settlementId: 7,
              name: 'Харків',
              district: 'Глушковскій район',
              region: 'Курская область рф',
              coordinate: { lat: 49.99, lon: 36.23 },
            },
          ],
          chosenSettlementId: 7,
          distanceM: 12,
          invalidAorIds: [],
        },
      ]),
    );
    const idInput = container.querySelector('input:not([type="file"])');
    if (!(idInput instanceof HTMLInputElement)) throw new Error('ID input not found');
    await setInputValue(idInput, '42');
    await act(async () => button('Перевірити').click());
    await vi.waitFor(() =>
      expect(container.textContent).toContain(
        'ХАРКІВ: Харків #7 Глушковскій район Курская область рф',
      ),
    );

    api.testBattleLine.mockRejectedValueOnce(new Error('test failed'));
    await act(async () => button('Перевірити').click());
    await vi.waitFor(() => expect(container.textContent).toContain('test failed'));
    expect(container.textContent).not.toContain('ХАРКІВ: Харків #7');
  });
});
