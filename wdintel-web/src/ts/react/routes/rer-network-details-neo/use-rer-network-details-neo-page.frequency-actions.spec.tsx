/**
 * @vitest-environment happy-dom
 */
import { act, createElement, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Network, NetworkFreqsRes } from '../../../../Bindings';
import { EMPTY_STATE, type NetworkDetailsNeoPageState, type NetworkFreqCreateWizardForm, type NetworkFreqEditForm, type NetworkFreqTechDataForm } from './use-rer-network-details-neo-page.types';
import { NETWORK_STATUS_ACTIVE } from './network-status';

const apiMock = vi.hoisted(() => ({
  addFreqToNetworkV2: vi.fn(),
  updateNetworkFreqV2: vi.fn(),
  deleteNetworkFreq: vi.fn(),
  getSingleNetworkFreqs: vi.fn(),
  getNetworkFreqsActivity: vi.fn(),
}));

vi.mock('../../services/api/networks', () => ({
  addFreqToNetworkV2: apiMock.addFreqToNetworkV2,
  updateNetworkFreqV2: apiMock.updateNetworkFreqV2,
  deleteNetworkFreq: apiMock.deleteNetworkFreq,
  getSingleNetworkFreqs: apiMock.getSingleNetworkFreqs,
  getNetworkFreqsActivity: apiMock.getNetworkFreqsActivity,
}));

import { useRerNetworkDetailsNeoPageFrequencyActions } from './use-rer-network-details-neo-page.frequency-actions';

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
    description: '',
    activeFrom: '',
    activeTo: '',
    encryptionKeyIds: [],
  };
}

function buildEditForm(freq: NetworkFreqsRes): NetworkFreqEditForm {
  return {
    networkFreqId: freq.networkFreqId,
    kind: 'VHF',
    modulationId: freq.modulationId,
    activeFrom: '1970-01-01',
    activeTo: '',
  };
}

function buildTechForm(freq: NetworkFreqsRes): NetworkFreqTechDataForm {
  return {
    networkFreqId: freq.networkFreqId,
    encryptionKeyIds: [13],
  };
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
      freq: buildFreq({ networkFreqId: 9, freq: '123.4000' }),
    });

    renderHarness({
      ...EMPTY_STATE,
      network: buildNetwork(),
      freqsLoaded: true,
      freqActivityByFreq: { 7: [{ day: '2026-06-01', messageCount: 3 }] },
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

    expect(apiMock.addFreqToNetworkV2).toHaveBeenCalled();
    expect(apiMock.getSingleNetworkFreqs).not.toHaveBeenCalled();
    expect(apiMock.getNetworkFreqsActivity).not.toHaveBeenCalled();
    expect(latestState?.freqs.map((freq) => freq.networkFreqId)).toEqual([7, 9]);
    expect(latestState?.freqActivityByFreq[9]).toEqual([]);
    expect(latestState?.freqsLoaded).toBe(true);
    expect(latestState?.freqCreateWizardOpen).toBe(false);
  });

  it('keeps concurrent local rows when the create response arrives later', async () => {
    let resolveResponse!: (value: { network: Network; freq: NetworkFreqsRes | null }) => void;
    const responsePromise = new Promise<{ network: Network; freq: NetworkFreqsRes | null }>((resolve) => {
      resolveResponse = resolve;
    });

    apiMock.addFreqToNetworkV2.mockReturnValueOnce(responsePromise);

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

    expect(latestState?.freqs.map((freq) => freq.networkFreqId)).toEqual([7, 8, 9]);
  });

  it('falls back to a reload when the create response does not include a row', async () => {
    apiMock.addFreqToNetworkV2.mockResolvedValueOnce({
      network: buildNetwork(),
      freq: null,
    });
    apiMock.getSingleNetworkFreqs.mockResolvedValueOnce({
      freqs: [buildFreq({ networkFreqId: 7, freq: '30.0000' }), buildFreq({ networkFreqId: 9, freq: '50.0000' })],
    });
    apiMock.getNetworkFreqsActivity.mockResolvedValueOnce({
      7: { '2026-06-01': 3 },
      9: {},
    });

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

    expect(apiMock.getSingleNetworkFreqs).toHaveBeenCalledWith(1, true);
    expect(apiMock.getNetworkFreqsActivity).toHaveBeenCalledWith(1);
    expect(latestState?.freqs.map((freq) => freq.networkFreqId)).toEqual([7, 9]);
    expect(latestState?.freqsLoaded).toBe(true);
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
      freqEditDrawerForm: buildEditForm(buildFreq()),
      freqEditDrawerSaving: false,
    });

    await act(async () => {
      await latestActions?.saveFreqEditDrawer();
    });

    expect(apiMock.updateNetworkFreqV2).toHaveBeenCalled();
    expect(apiMock.getSingleNetworkFreqs).not.toHaveBeenCalled();
    expect(apiMock.getNetworkFreqsActivity).not.toHaveBeenCalled();
    expect(latestState?.freqs[0]?.modulationId).toBe(12);
    expect(latestState?.freqActivityByFreq[7]).toEqual([{ day: '2026-06-01', messageCount: 3 }]);
    expect(latestState?.freqEditDrawerOpen).toBe(false);
  });

  it('replaces a frequency row in place when editing technical data', async () => {
    apiMock.updateNetworkFreqV2.mockResolvedValueOnce({
      network: buildNetwork(),
      freq: buildFreq({ networkFreqId: 7, encryptionKeyIds: [13] }),
    });

    const freq = buildFreq();
    renderHarness({
      ...EMPTY_STATE,
      network: buildNetwork(),
      freqsLoaded: true,
      freqActivityByFreq: { 7: [{ day: '2026-06-01', messageCount: 3 }] },
      freqs: [freq],
      freqTechDrawerOpen: true,
      freqTechDrawerForm: buildTechForm(freq),
      freqTechDrawerSaving: false,
    });

    await act(async () => {
      await latestActions?.saveFreqTechDrawer();
    });

    expect(apiMock.updateNetworkFreqV2).toHaveBeenCalled();
    expect(apiMock.getSingleNetworkFreqs).not.toHaveBeenCalled();
    expect(apiMock.getNetworkFreqsActivity).not.toHaveBeenCalled();
    expect(latestState?.freqs[0]?.encryptionKeyIds).toEqual([13]);
    expect(latestState?.freqActivityByFreq[7]).toEqual([{ day: '2026-06-01', messageCount: 3 }]);
    expect(latestState?.freqTechDrawerOpen).toBe(false);
  });
});
