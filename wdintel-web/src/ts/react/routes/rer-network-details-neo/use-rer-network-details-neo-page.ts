import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AreaOfResponsibility, ModulationRec, Network, NetworkStatus, Post, Unit, User } from '../../../../Bindings';
import { listAors } from '../../services/api/aor';
import {
  deleteNetwork,
  getNetworkById,
  getNetworkCallsignsList,
  updateNetwork,
  updateNetworkPosts,
  updateNetworkUnits,
} from '../../services/api/networks';
import { getModulations } from '../../services/api/modulations';
import { getUnitsList } from '../../services/api/units';
import { listPosts } from '../../services/api/posts';
import { fetchCurrentUser } from '../../services/api/user';
import { navigateWithinSpa } from '../../utils/browser';

export type NetworkEditForm = {
  id: number;
  name: string;
  location: string;
  radioStation: string;
  purpose: string;
  operationMode: string;
  operationType: string;
  operationPeriod: string;
  status: NetworkStatus;
  aorIds: number[];
  unitIds: number[];
  postIds: number[];
};

type NetworkOption = {
  id: number;
  label: string;
};

type NetworkDetailsNeoPageState = {
  network: Network | null;
  callsignCount: number | null;
  currentUser: User | null;
  units: Unit[];
  posts: Post[];
  aors: AreaOfResponsibility[];
  modulations: ModulationRec[];
  loading: boolean;
  referenceLoading: boolean;
  error: string | null;
  referenceWarning: string | null;
  callsignWarning: string | null;
  deleteDialogOpen: boolean;
  deleteInProgress: boolean;
  menuAnchorEl: HTMLElement | null;
  copyStatus: string | null;
  editDrawerOpen: boolean;
  editForm: NetworkEditForm | null;
  editInProgress: boolean;
  editError: string | null;
};

type DisplayNetworkStatus = {
  label: string;
  tone: 'success' | 'warning';
};

const EMPTY_STATE: NetworkDetailsNeoPageState = {
  network: null,
  callsignCount: null,
  currentUser: null,
  units: [],
  posts: [],
  aors: [],
  modulations: [],
  loading: true,
  referenceLoading: true,
  error: null,
  referenceWarning: null,
  callsignWarning: null,
  deleteDialogOpen: false,
  deleteInProgress: false,
  menuAnchorEl: null,
  copyStatus: null,
  editDrawerOpen: false,
  editForm: null,
  editInProgress: false,
  editError: null,
};

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== '') return error.message;
  if (typeof error === 'string' && error.trim() !== '') return error;
  try {
    return JSON.stringify(error);
  } catch (_) {
    return 'Невідома помилка';
  }
}

function normalizeLookupName(value: string | null | undefined, fallback: string): string {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? fallback : trimmed;
}

function formatClassicNetworkHeaderName(networkName: string | null | undefined, unitNames: string[]): string {
  const name = networkName?.trim() ?? '';
  const units = unitNames.map((unitName) => unitName.trim()).filter((unitName) => unitName !== '');

  if (name === '' && units.length === 0) {
    return '—';
  }

  return ['р/м', name, units.join(', ')].filter((part) => part !== '').join(' ');
}

function networkStatusDisplay(network: Network | null): DisplayNetworkStatus {
  if (!network) {
    return { label: 'Завантаження', tone: 'warning' };
  }

  if (network.deleted) {
    return { label: 'Видалена', tone: 'warning' };
  }

  return network.status === 'NetworkActive'
    ? { label: 'Активна', tone: 'success' }
    : { label: 'Неактивна', tone: 'warning' };
}

function displayNetworkType(kind: string | null | undefined): string {
  switch (kind) {
    case 'VHF':
      return 'УКХ';
    case 'DMR':
      return 'DMR';
    case 'DMRe':
      return 'DMRe';
    default:
      return normalizeLookupName(kind, '—');
  }
}

function formatNetworkFreqRange(freqs: Array<Network['freqs'][number]>): string {
  const kinds = [...new Set(freqs.map((freq) => displayNetworkType(freq.kind)).filter((kind) => kind !== '—'))];
  return kinds.length === 0 ? '—' : kinds.join(', ');
}

function formatTransferTypeLabel(freqs: Array<Network['freqs'][number]>, modulationsById: Map<number, string>): string {
  const labels = freqs
    .map((freq) => freq.modulationId)
    .filter((modulationId): modulationId is number => modulationId !== null && modulationId !== undefined)
    .map((modulationId) => modulationsById.get(modulationId) ?? `#${modulationId}`)
    .filter((label) => label.trim() !== '');

  const uniqueLabels = [...new Set(labels)];
  return uniqueLabels.length === 0 ? '—' : uniqueLabels.join(', ');
}

function buildLookupMap<T extends { id: number; name: string }>(items: T[]): Map<number, string> {
  return new Map(items.map((item) => [item.id, item.name]));
}

function canDeleteNetwork(user: User | null): boolean {
  const roles = new Set(user?.roles ?? []);
  return roles.has('Admin') || roles.has('UnitsEditor');
}

function canEditNetwork(user: User | null): boolean {
  const roles = new Set(user?.roles ?? []);
  return roles.has('Admin') || roles.has('UnitsEditor');
}

function toNetworkEditForm(network: Network): NetworkEditForm {
  return {
    id: network.id,
    name: network.name,
    location: network.location,
    radioStation: network.radioStation ?? '',
    purpose: network.purpose ?? '',
    operationMode: network.operationMode ?? '',
    operationType: network.operationType ?? '',
    operationPeriod: network.operationPeriod ?? '',
    status: network.status,
    aorIds: [...network.aorIds],
    unitIds: [...(network.unitIds ?? [])],
    postIds: [...network.postIds],
  };
}

export function useRerNetworkDetailsNeoPage(networkId: number) {
  const [state, setState] = useState<NetworkDetailsNeoPageState>(EMPTY_STATE);
  const reloadGeneration = useRef(0);

  const unitsById = useMemo(() => buildLookupMap(state.units), [state.units]);
  const postsById = useMemo(() => buildLookupMap(state.posts), [state.posts]);
  const aorsById = useMemo(() => buildLookupMap(state.aors), [state.aors]);
  const modulationsById = useMemo(() => buildLookupMap(state.modulations), [state.modulations]);
  const canDelete = useMemo(() => canDeleteNetwork(state.currentUser), [state.currentUser]);
  const canEdit = useMemo(() => canEditNetwork(state.currentUser), [state.currentUser]);
  const status = useMemo(() => networkStatusDisplay(state.network), [state.network]);
  const aorOptions = useMemo<NetworkOption[]>(() => state.aors.map((aor) => ({ id: aor.id, label: aor.name })), [state.aors]);
  const unitOptions = useMemo<NetworkOption[]>(() => state.units.map((unit) => ({ id: unit.id, label: unit.name })), [state.units]);
  const postOptions = useMemo<NetworkOption[]>(() => state.posts.map((post) => ({ id: post.id, label: post.name })), [state.posts]);

  const reload = useCallback(() => {
    reloadGeneration.current += 1;
    const generation = reloadGeneration.current;
    setState(EMPTY_STATE);
    reloadGeneration.current = generation;

    const isCurrent = () => reloadGeneration.current === generation;

    const loadCore = async () => {
      if (!Number.isFinite(networkId) || networkId <= 0) {
        setState((current) => ({ ...current, loading: false, error: 'Некоректний ID мережі' }));
        return;
      }

      try {
        const network = await getNetworkById(networkId);
        if (!isCurrent()) return;

        setState((current) => ({
          ...current,
          network,
          loading: false,
          error: null,
        }));

        void getNetworkCallsignsList(networkId, true)
          .then((callsignsRes) => {
            if (!isCurrent()) return;
            setState((current) => ({
              ...current,
              callsignCount: callsignsRes.callsigns.length,
              callsignWarning: null,
            }));
          })
          .catch((error) => {
            if (!isCurrent()) return;
            setState((current) => ({
              ...current,
              callsignCount: null,
              callsignWarning: formatErrorMessage(error),
            }));
          });

        void fetchCurrentUser()
          .then((currentUser) => {
            if (!isCurrent()) return;
            setState((current) => ({
              ...current,
              currentUser,
            }));
          })
          .catch(() => {
            if (!isCurrent()) return;
            setState((current) => ({
              ...current,
              currentUser: null,
            }));
          });
      } catch (error) {
        if (!isCurrent()) return;
        setState((current) => ({
          ...current,
          loading: false,
          error: formatErrorMessage(error),
        }));
      }
    };

    const loadReferences = async () => {
      try {
        const [units, posts, aors, modulations] = await Promise.all([
          getUnitsList(),
          listPosts(),
          listAors({ sortBy: null }),
          getModulations(),
        ]);
        if (!isCurrent()) return;
        setState((current) => ({
          ...current,
          units,
          posts,
          aors,
          modulations,
          referenceLoading: false,
          referenceWarning: null,
        }));
      } catch (error) {
        if (!isCurrent()) return;
        setState((current) => ({
          ...current,
          referenceLoading: false,
          referenceWarning: formatErrorMessage(error),
        }));
      }
    };

    void loadCore();
    void loadReferences();

    return () => {
      if (reloadGeneration.current === generation) {
        reloadGeneration.current += 1;
      }
    };
  }, [networkId]);

  useEffect(() => {
    return reload();
  }, [reload]);

  const openMenu = useCallback((anchorEl: HTMLElement) => {
    setState((current) => ({ ...current, menuAnchorEl: anchorEl }));
  }, []);

  const closeMenu = useCallback(() => {
    setState((current) => ({ ...current, menuAnchorEl: null }));
  }, []);

  const openDeleteDialog = useCallback(() => {
    setState((current) => ({ ...current, deleteDialogOpen: true, menuAnchorEl: null }));
  }, []);

  const closeDeleteDialog = useCallback(() => {
    setState((current) => ({ ...current, deleteDialogOpen: false }));
  }, []);

  const openEditDrawer = useCallback(() => {
    setState((current) => {
      if (!current.network) return current;
      return {
        ...current,
        editDrawerOpen: true,
        editForm: toNetworkEditForm(current.network),
        editInProgress: false,
        editError: null,
        menuAnchorEl: null,
      };
    });
  }, []);

  const closeEditDrawer = useCallback(() => {
    setState((current) => {
      if (current.editInProgress) return current;
      return {
        ...current,
        editDrawerOpen: false,
        editForm: null,
        editError: null,
        menuAnchorEl: null,
      };
    });
  }, []);

  const syncNetworkRelations = useCallback(async (editForm: NetworkEditForm) => {
    await updateNetworkPosts({
      networkId: editForm.id,
      postIds: [...editForm.postIds],
    });

    await updateNetworkUnits({
      networkId: editForm.id,
      unitIds: [...editForm.unitIds],
    });
  }, []);

  const setEditForm = useCallback((editForm: NetworkEditForm | null) => {
    setState((current) => ({ ...current, editForm }));
  }, []);

  const saveNetworkEdit = useCallback(async () => {
    const network = state.network;
    const editForm = state.editForm;

    if (!network || !editForm || state.editInProgress) return;

    setState((current) => ({
      ...current,
      editInProgress: true,
      editError: null,
      menuAnchorEl: null,
    }));

    try {
      const updatedNetwork = await updateNetwork({
        id: editForm.id,
        restoreNetwork: network.deleted && editForm.status === 'NetworkActive' ? true : null,
        areaOfResponsibilityIds: [...editForm.aorIds],
        name: editForm.name,
        location: editForm.location,
        radioStation: editForm.radioStation.trim() === '' ? null : editForm.radioStation,
        purpose: editForm.purpose.trim() === '' ? null : editForm.purpose,
        operationMode: editForm.operationMode.trim() === '' ? null : editForm.operationMode,
        operationType: editForm.operationType.trim() === '' ? null : editForm.operationType,
        operationPeriod: editForm.operationPeriod.trim() === '' ? null : editForm.operationPeriod,
        descriptions: null,
        status: editForm.status,
      });

      await syncNetworkRelations(editForm);

      setState((current) => ({
        ...current,
        network: {
          ...updatedNetwork,
          aorIds: [...editForm.aorIds],
          unitIds: [...editForm.unitIds],
          postIds: [...editForm.postIds],
        },
        editDrawerOpen: false,
        editForm: null,
        editInProgress: false,
        editError: null,
      }));
    } catch (error) {
      setState((current) => ({
        ...current,
        editInProgress: false,
        editError: formatErrorMessage(error),
      }));
    }
  }, [state.editForm, state.editInProgress, state.network, syncNetworkRelations]);

  const handleDelete = useCallback(async () => {
    if (!state.network) return;
    setState((current) => ({ ...current, deleteInProgress: true }));
    try {
      await deleteNetwork(state.network.id);
      navigateWithinSpa('/rer-networks');
    } catch (error) {
      setState((current) => ({
        ...current,
        deleteInProgress: false,
        deleteDialogOpen: false,
        error: formatErrorMessage(error),
      }));
      return;
    }
  }, [state.network]);

  const unitNames = useMemo(() => {
    const unitIds = state.network?.unitIds ?? [];
    return unitIds
      .map((unitId) => unitsById.get(unitId) ?? `#${unitId}`)
      .filter((label) => label.trim() !== '');
  }, [state.network?.unitIds, unitsById]);

  const aorItems = useMemo(() => {
    const aorIds = state.network?.aorIds ?? [];
    return aorIds.map((aorId) => ({ id: aorId, label: aorsById.get(aorId) ?? `#${aorId}` }));
  }, [aorsById, state.network?.aorIds]);

  const postItems = useMemo(() => {
    const postIds = state.network?.postIds ?? [];
    return postIds.map((postId) => ({ id: postId, label: postsById.get(postId) ?? `#${postId}` }));
  }, [postsById, state.network?.postIds]);

  const rangeLabel = useMemo(() => {
    return formatNetworkFreqRange(state.network?.freqs ?? []);
  }, [state.network?.freqs]);

  const transferTypeLabel = useMemo(() => {
    return formatTransferTypeLabel(state.network?.freqs ?? [], modulationsById);
  }, [modulationsById, state.network?.freqs]);

  const handleCopyNetworkInfo = useCallback(async () => {
    const networkName = formatClassicNetworkHeaderName(state.network?.name, unitNames);
    const location = state.network?.location?.trim() ?? '';
    const parts = [networkName, location].filter((value) => value !== '');
    if (parts.length === 0) return;

    try {
      await navigator.clipboard.writeText(parts.join(', '));
      setState((current) => ({ ...current, copyStatus: 'Назву й район скопійовано' }));
      window.setTimeout(() => {
        setState((current) => ({ ...current, copyStatus: null }));
      }, 1800);
    } catch (error) {
      setState((current) => ({ ...current, copyStatus: formatErrorMessage(error) }));
      window.setTimeout(() => {
        setState((current) => ({ ...current, copyStatus: null }));
      }, 2400);
    }
  }, [state.network?.location, state.network?.name, unitNames]);

  return {
    ...state,
    status,
    canDelete,
    canEdit,
    unitNames,
    aorItems,
    postItems,
    rangeLabel,
    transferTypeLabel,
    aorOptions,
    unitOptions,
    postOptions,
    openMenu,
    closeMenu,
    openDeleteDialog,
    closeDeleteDialog,
    openEditDrawer,
    closeEditDrawer,
    setEditForm,
    saveNetworkEdit,
    handleCopyNetworkInfo,
    handleDelete,
    reload,
  };
}
