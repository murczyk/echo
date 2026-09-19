/**
 * @vitest-environment happy-dom
 */
import { act, createElement, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Network, NetworkFreqsRes } from '../../../../../Bindings';
import {
  EMPTY_STATE,
  type NetworkDetailsNeoPageState,
  type NetworkFreqCreateWizardForm,
  type NetworkFreqEditForm,
} from '../use-rer-network-details-neo-page.types';
import { NETWORK_STATUS_ACTIVE } from '../network-status';

const apiMock = vi.hoisted(() => ({
  addFreqToNetworkV2: vi.fn(),
  updateNetworkFreqV2: vi.fn(),
  deleteNetworkFreq: vi.fn(),
  getSingleNetworkFreqs: vi.fn(),
  getNetworkFreqsActivity: vi.fn(),
  getNetworkFreqCallsignsBatch: vi.fn(),
  getNetworkFreqCallsigns: vi.fn(),
}));

vi.mock('../../../services/api/networks', () => ({
  addFreqToNetworkV2: apiMock.addFreqToNetworkV2,
  updateNetworkFreqV2: apiMock.updateNetworkFreqV2,
  deleteNetworkFreq: apiMock.deleteNetworkFreq,
  getSingleNetworkFreqs: apiMock.getSingleNetworkFreqs,
  getNetworkFreqsActivity: apiMock.getNetworkFreqsActivity,
  getNetworkFreqCallsignsBatch: apiMock.getNetworkFreqCallsignsBatch,
  getNetworkFreqCallsigns: apiMock.getNetworkFreqCallsigns,
}));

import { useRerNetworkDetailsNeoPageFrequencyActions } from '../use-rer-network-details-neo-page.frequency-actions';

type HookResult = ReturnType<typeof useRerNetworkDetailsNeoPageFrequencyActions>;

let root: Root | null = null;
let latestActions: HookResult | null = null;
let latestState: NetworkDetailsNeoPageState | null = null;
let latestSetState: Dispatch<SetStateAction<NetworkDetailsNeoPageState>> | null = null;

function buildNetwork(overrides: Partial<Network> = {}): Network {
  return {
    id: 1,
    freqs: [],
    unitIds: [],
    aorIds: [],
    name: 'Network 1',
    location: 'Location 1',
    radioStation: null,
    createdAt: 1,
    purpose: null,
    operationMode: null,
    operationType: null,
    operationPeriod: null,
    lastUpdatedAt: 1,
    lastUpdatedBy: null,
    activeFrom: null,
    activeTo: null,
    postIds: [],
    descriptions: [],
    deleted: false,
    status: NETWORK_STATUS_ACTIVE,
    ...overrides,
  };
}

function buildFreq(overrides: Partial<NetworkFreqsRes>): NetworkFreqsRes {
  return {
    networkFreqId: 7,
    freq: '20.0000',
    modulationId: null,
    modulation: null,
    encryptionKeyIds: [],
    encryptionKeys: [],
    messageCount: 5,
    callsigns: null,
    lastDatetime: null,
    lastDatetimeInAor: null,
    createdAt: 1,
    isActive: true,
    activeFrom: 1,
    activeTo: null,
    kind: 'VHF',
    ...overrides,
  };
}

function buildCreateForm(): NetworkFreqCreateWizardForm {
  return {
    freq: '10.0000',
    kind: 'VHF',
    modulationId: null,
    activeFrom: '',
    activeTo: '',
    encryptionKeyIds: [],
  };
}

function buildEditForm(freq: NetworkFreqsRes): NetworkFreqEditForm {
  return {
    networkFreqId: freq.networkFreqId,
    freq: freq.freq,
    kind: 'VHF',
    modulationId: freq.modulationId,
    activeFrom: '1970-01-01',
    activeTo: '',
    encryptionKeyIds: [],
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function Harness({ stateSeed }: { stateSeed: NetworkDetailsNeoPageState }) {
  const [state, setState] = useState(stateSeed);

  latestState = state;
  latestSetState = setState;
  latestActions = useRerNetworkDetailsNeoPageFrequencyActions({
    state,
    setState,
    reloadGeneration: { current: 0 },
    currentNetworkIdRef: { current: state.network?.id ?? null },
  });

  return null;
}

function renderHarness(stateSeed: NetworkDetailsNeoPageState) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const mountedRoot = createRoot(container);
  root = mountedRoot;

  act(() => {
    mountedRoot.render(createElement(Harness, { stateSeed }));
  });
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  latestActions = null;
  latestState = null;
  latestSetState = null;
  document.body.innerHTML = '';
  vi.clearAllMocks();
});
describe('useRerNetworkDetailsNeoPageFrequencyActions', () => {
  it('creates a frequency in place without reloading the list when v2 returns a row', async () => {
    apiMock.addFreqToNetworkV2.mockResolvedValueOnce({
      network: buildNetwork(),
      freq: buildFreq({ networkFreqId: 9, freq: '123.4000', isActive: true }),
    });
    apiMock.getNetworkFreqCallsigns.mockResolvedValueOnce(['BRAVO']);

    renderHarness({
      ...EMPTY_STATE,
      network: buildNetwork(),
      freqsLoaded: true,
      freqActivityByFreq: { 7: [{ day: '2026-06-01', messageCount: 3 }] },
      freqs: [buildFreq({ networkFreqId: 7, freq: '30.0000', isActive: false })],
      freqCreateWizardOpen: true,
      freqCreateWizardForm: {
        ...buildCreateForm(),
        freq: '123.4000',
      },
      freqCreateWizardSaving: false,
    });

    await act(async () => {
      await latestActions?.saveFreqCreateWizard();
      await Promise.resolve();
    });

    expect(apiMock.addFreqToNetworkV2).toHaveBeenCalled();
    expect(apiMock.getSingleNetworkFreqs).not.toHaveBeenCalled();
    expect(apiMock.getNetworkFreqsActivity).not.toHaveBeenCalled();
    expect(apiMock.getNetworkFreqCallsignsBatch).not.toHaveBeenCalled();
    expect(apiMock.getNetworkFreqCallsigns).toHaveBeenCalledWith(9, 'Last21Days');
    expect(latestState?.freqs.map((freq) => freq.networkFreqId)).toEqual([9, 7]);
    expect(latestState?.freqActivityByFreq[9]).toEqual([]);
    expect(latestState?.freqCallsignsById.get(9)).toEqual(['BRAVO']);
    expect(latestState?.freqsLoaded).toBe(true);
    expect(latestState?.freqCreateWizardOpen).toBe(false);
  });

  it('keeps concurrent local rows when the create response arrives later', async () => {
    let resolveResponse!: (value: { network: Network; freq: NetworkFreqsRes | null }) => void;
    const responsePromise = new Promise<{ network: Network; freq: NetworkFreqsRes | null }>(
      (resolve) => {
        resolveResponse = resolve;
      },
    );

    apiMock.addFreqToNetworkV2.mockReturnValueOnce(responsePromise);
    apiMock.getNetworkFreqCallsigns.mockResolvedValueOnce(['BRAVO']);

    renderHarness({
      ...EMPTY_STATE,
      network: buildNetwork(),
      freqsLoaded: true,
      freqActivityByFreq: { 7: [] },
      freqs: [buildFreq({ networkFreqId: 7, freq: '30.0000', isActive: false })],
      freqCreateWizardOpen: true,
      freqCreateWizardForm: {
        ...buildCreateForm(),
        freq: '123.4000',
      },
      freqCreateWizardSaving: false,
    });

    const savePromise = latestActions?.saveFreqCreateWizard();

    await act(async () => {
      latestSetState?.((current) => ({
        ...current,
        freqs: [...current.freqs, buildFreq({ networkFreqId: 8, freq: '40.0000' })],
        freqActivityByFreq: {
          ...current.freqActivityByFreq,
          8: [],
        },
      }));
    });

    await act(async () => {
      resolveResponse({
        network: buildNetwork(),
        freq: buildFreq({ networkFreqId: 9, freq: '50.0000' }),
      });
      await savePromise;
    });

    expect(latestState?.freqs.map((freq) => freq.networkFreqId)).toEqual([8, 9, 7]);
  });

  it('falls back to a reload when the create response does not include a row', async () => {
    apiMock.addFreqToNetworkV2.mockResolvedValueOnce({
      network: buildNetwork(),
      freq: null,
    });
    apiMock.getSingleNetworkFreqs.mockResolvedValueOnce({
      freqs: [
        buildFreq({ networkFreqId: 7, freq: '30.0000' }),
        buildFreq({ networkFreqId: 9, freq: '50.0000' }),
      ],
    });
    apiMock.getNetworkFreqsActivity.mockResolvedValueOnce({
      7: { '2026-06-01': 3 },
      9: {},
    });
    apiMock.getNetworkFreqCallsignsBatch.mockResolvedValueOnce(
      new Map([
        [7, ['ALPHA']],
        [9, []],
      ]),
    );

    renderHarness({
      ...EMPTY_STATE,
      network: buildNetwork(),
      freqsLoaded: true,
      freqActivityByFreq: { 7: [] },
      freqs: [buildFreq({ networkFreqId: 7, freq: '30.0000' })],
      freqCreateWizardOpen: true,
      freqCreateWizardForm: {
        ...buildCreateForm(),
        freq: '123.4000',
      },
      freqCreateWizardSaving: false,
    });

    await act(async () => {
      await latestActions?.saveFreqCreateWizard();
    });

    expect(apiMock.getSingleNetworkFreqs).toHaveBeenCalledWith(1, false, false);
    expect(apiMock.getNetworkFreqsActivity).toHaveBeenCalledWith(1);
    expect(apiMock.getNetworkFreqCallsignsBatch).toHaveBeenCalledWith([7, 9], 'Last21Days');
    expect(latestState?.freqs.map((freq) => freq.networkFreqId)).toEqual([7, 9]);
    expect(latestState?.freqsLoaded).toBe(true);
    expect(latestState?.freqCallsignsStatus).toBe('success');
    expect(latestState?.freqCallsignsById.get(7)).toEqual(['ALPHA']);
  });

  it('ignores stale batch callsign hydration after a newer frequency reload starts', async () => {
    const firstBatch = createDeferred<Map<number, string[]>>();
    apiMock.getSingleNetworkFreqs
      .mockResolvedValueOnce({
        freqs: [buildFreq({ networkFreqId: 7, freq: '30.0000' })],
      })
      .mockResolvedValueOnce({
        freqs: [buildFreq({ networkFreqId: 8, freq: '40.0000' })],
      });
    apiMock.getNetworkFreqsActivity
      .mockResolvedValueOnce({ 7: {} })
      .mockResolvedValueOnce({ 8: {} });
    apiMock.getNetworkFreqCallsignsBatch
      .mockReturnValueOnce(firstBatch.promise)
      .mockResolvedValueOnce(new Map([[8, ['BRAVO']]]));

    renderHarness({
      ...EMPTY_STATE,
      network: buildNetwork(),
      freqsLoaded: true,
      freqs: [buildFreq({ networkFreqId: 7, freq: '30.0000' })],
      freqCallsignsById: new Map([[7, ['ALPHA']]]),
      freqCallsignsStatus: 'success',
    });

    await act(async () => {
      void latestActions?.loadFrequencies(1);
    });

    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      void latestActions?.loadFrequencies(1);
    });

    await act(async () => {
      firstBatch.resolve(new Map([[7, ['OLD']]]));
      await Promise.resolve();
    });

    expect(latestState?.freqs.map((freq) => freq.networkFreqId)).toEqual([8]);
    expect(latestState?.freqCallsignsById.get(8)).toEqual(['BRAVO']);
    expect(latestState?.freqCallsignsById.get(7)).toBeUndefined();
  });

  it('reloads only callsigns when their period changes', async () => {
    apiMock.getNetworkFreqCallsignsBatch.mockResolvedValueOnce(
      new Map([
        [7, ['ALPHA']],
        [8, ['BRAVO']],
      ]),
    );

    renderHarness({
      ...EMPTY_STATE,
      network: buildNetwork(),
      freqsLoaded: true,
      freqs: [
        buildFreq({ networkFreqId: 7, freq: '30.0000' }),
        buildFreq({ networkFreqId: 8, freq: '40.0000' }),
      ],
      freqCallsignsById: new Map([[7, ['OLD']]]),
      freqCallsignsStatus: 'success',
    });

    await act(async () => {
      latestActions?.setFreqCallsignsPeriod('Last7Days');
      await Promise.resolve();
    });

    expect(apiMock.getNetworkFreqCallsignsBatch).toHaveBeenCalledWith([7, 8], 'Last7Days');
    expect(apiMock.getSingleNetworkFreqs).not.toHaveBeenCalled();
    expect(apiMock.getNetworkFreqsActivity).not.toHaveBeenCalled();
    expect(latestState?.freqCallsignsPeriod).toBe('Last7Days');
    expect(latestState?.freqCallsignsById).toEqual(
      new Map([
        [7, ['ALPHA']],
        [8, ['BRAVO']],
      ]),
    );
    expect(latestState?.freqCallsignsStatus).toBe('success');
  });

  it('replaces a frequency row in place when editing metadata', async () => {
    apiMock.updateNetworkFreqV2.mockResolvedValueOnce({
      network: buildNetwork(),
      freq: buildFreq({ networkFreqId: 7, modulationId: 12, freq: '20.0000' }),
    });

    renderHarness({
      ...EMPTY_STATE,
      network: buildNetwork(),
      freqsLoaded: true,
      freqActivityByFreq: { 7: [{ day: '2026-06-01', messageCount: 3 }] },
      freqs: [buildFreq()],
      freqEditDrawerOpen: true,
      freqEditDrawerForm: {
        ...buildEditForm(buildFreq()),
        freq: '22.0000',
        encryptionKeyIds: [13],
      },
      freqEditDrawerSaving: false,
    });

    await act(async () => {
      await latestActions?.saveFreqEditDrawer();
      await Promise.resolve();
    });

    expect(apiMock.updateNetworkFreqV2).toHaveBeenCalled();
    expect(apiMock.updateNetworkFreqV2).toHaveBeenCalledWith(
      expect.objectContaining({
        freq: '20.0000',
        encryptionKeyIds: [13],
      }),
    );
    expect(apiMock.getSingleNetworkFreqs).not.toHaveBeenCalled();
    expect(apiMock.getNetworkFreqsActivity).not.toHaveBeenCalled();
    expect(latestState?.freqs[0]?.modulationId).toBe(12);
    expect(latestState?.freqActivityByFreq[7]).toEqual([{ day: '2026-06-01', messageCount: 3 }]);
    expect(latestState?.freqEditDrawerOpen).toBe(false);
  });

  it('refreshes the edited frequency callsigns after a row response', async () => {
    apiMock.updateNetworkFreqV2.mockResolvedValueOnce({
      network: buildNetwork(),
      freq: buildFreq({ networkFreqId: 7, modulationId: 12, freq: '20.0000' }),
    });
    apiMock.getNetworkFreqCallsigns.mockResolvedValueOnce(['CHARLIE']);

    renderHarness({
      ...EMPTY_STATE,
      network: buildNetwork(),
      freqsLoaded: true,
      freqActivityByFreq: { 7: [] },
      freqs: [buildFreq()],
      freqCallsignsById: new Map([[7, ['ALPHA']]]),
      freqCallsignsStatus: 'success',
      freqEditDrawerOpen: true,
      freqEditDrawerForm: {
        ...buildEditForm(buildFreq()),
        freq: '22.0000',
        encryptionKeyIds: [13],
      },
      freqEditDrawerSaving: false,
    });

    await act(async () => {
      await latestActions?.saveFreqEditDrawer();
      await Promise.resolve();
    });

    expect(apiMock.updateNetworkFreqV2).toHaveBeenCalled();
    expect(apiMock.getNetworkFreqCallsigns).toHaveBeenCalledWith(7, 'Last21Days');
    expect(latestState?.freqCallsignsById.get(7)).toEqual(['CHARLIE']);
    expect(latestState?.freqs[0]?.modulationId).toBe(12);
  });

  it('keeps existing callsigns when the edit response omits them and the refresh is still pending', async () => {
    const pendingCallsigns = createDeferred<string[]>();
    apiMock.updateNetworkFreqV2.mockResolvedValueOnce({
      network: buildNetwork(),
      freq: buildFreq({ networkFreqId: 7, modulationId: 12, freq: '20.0000', callsigns: null }),
    });
    apiMock.getNetworkFreqCallsigns.mockReturnValueOnce(pendingCallsigns.promise);

    renderHarness({
      ...EMPTY_STATE,
      network: buildNetwork(),
      freqsLoaded: true,
      freqActivityByFreq: { 7: [] },
      freqs: [buildFreq()],
      freqCallsignsById: new Map([[7, ['ALPHA']]]),
      freqCallsignsStatus: 'success',
      freqEditDrawerOpen: true,
      freqEditDrawerForm: {
        ...buildEditForm(buildFreq()),
        freq: '22.0000',
        encryptionKeyIds: [13],
      },
      freqEditDrawerSaving: false,
    });

    await act(async () => {
      await latestActions?.saveFreqEditDrawer();
      await Promise.resolve();
    });

    expect(apiMock.updateNetworkFreqV2).toHaveBeenCalled();
    expect(apiMock.getNetworkFreqCallsigns).toHaveBeenCalledWith(7, 'Last21Days');
    expect(latestState?.freqCallsignsById.get(7)).toEqual(['ALPHA']);
    expect(latestState?.freqs[0]?.modulationId).toBe(12);
  });

  it('uses response callsigns immediately when the edit response includes them', async () => {
    const pendingCallsigns = createDeferred<string[]>();
    apiMock.updateNetworkFreqV2.mockResolvedValueOnce({
      network: buildNetwork(),
      freq: buildFreq({
        networkFreqId: 7,
        modulationId: 12,
        freq: '20.0000',
        callsigns: ['BRAVO'],
      }),
    });
    apiMock.getNetworkFreqCallsigns.mockReturnValueOnce(pendingCallsigns.promise);

    renderHarness({
      ...EMPTY_STATE,
      network: buildNetwork(),
      freqsLoaded: true,
      freqActivityByFreq: { 7: [] },
      freqs: [buildFreq()],
      freqCallsignsById: new Map([[7, ['ALPHA']]]),
      freqCallsignsStatus: 'success',
      freqEditDrawerOpen: true,
      freqEditDrawerForm: {
        ...buildEditForm(buildFreq()),
        freq: '22.0000',
        encryptionKeyIds: [13],
      },
      freqEditDrawerSaving: false,
    });

    await act(async () => {
      await latestActions?.saveFreqEditDrawer();
      await Promise.resolve();
    });

    expect(apiMock.updateNetworkFreqV2).toHaveBeenCalled();
    expect(latestState?.freqCallsignsById.get(7)).toEqual(['BRAVO']);
  });

  it('keeps fresher single-row callsigns when batch hydration resolves later for the same freq', async () => {
    const singleCallsigns = createDeferred<string[]>();
    const batchCallsigns = createDeferred<Map<number, string[]>>();

    apiMock.getSingleNetworkFreqs.mockResolvedValueOnce({
      freqs: [
        buildFreq({ networkFreqId: 7, freq: '30.0000' }),
        buildFreq({ networkFreqId: 8, freq: '40.0000' }),
      ],
    });
    apiMock.getNetworkFreqsActivity.mockResolvedValueOnce({
      7: {},
      8: {},
    });
    apiMock.getNetworkFreqCallsignsBatch.mockReturnValueOnce(batchCallsigns.promise);
    apiMock.updateNetworkFreqV2.mockResolvedValueOnce({
      network: buildNetwork(),
      freq: buildFreq({ networkFreqId: 7, freq: '30.0000', modulationId: 12 }),
    });
    apiMock.getNetworkFreqCallsigns.mockReturnValueOnce(singleCallsigns.promise);

    renderHarness({
      ...EMPTY_STATE,
      network: buildNetwork(),
      freqsLoaded: false,
      freqs: [],
      freqCallsignsById: new Map(),
      freqCallsignsStatus: 'idle',
      freqEditDrawerOpen: true,
      freqEditDrawerForm: {
        ...buildEditForm(buildFreq({ networkFreqId: 7, freq: '30.0000' })),
        freq: '30.0000',
        encryptionKeyIds: [13],
      },
      freqEditDrawerSaving: false,
    });

    await act(async () => {
      await latestActions?.loadFrequencies(1);
    });

    await act(async () => {
      await latestActions?.saveFreqEditDrawer();
      await Promise.resolve();
    });

    await act(async () => {
      singleCallsigns.resolve(['CHARLIE']);
      await Promise.resolve();
    });

    await act(async () => {
      batchCallsigns.resolve(
        new Map([
          [7, ['ALPHA']],
          [8, ['BRAVO']],
        ]),
      );
      await Promise.resolve();
    });

    expect(latestState?.freqs.map((freq) => freq.networkFreqId)).toEqual([7, 8]);
    expect(latestState?.freqCallsignsById.get(7)).toEqual(['CHARLIE']);
    expect(latestState?.freqCallsignsById.get(8)).toEqual(['BRAVO']);
    expect(latestState?.freqCallsignsStatus).toBe('success');
  });
});
