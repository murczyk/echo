import React from 'react';

import { AnalyzeKmzResponse, AreaOfResponsibility, MyScope, Organism, Palitra, User } from '../../../../Bindings';
import { isUnauthorizedError } from '../../services/api/client';
import {
  analyzePalitraKmz,
  createPalitraBasicWithKmz,
  createPalitraWithKmz,
  deletePalitra,
  fetchPalitraBootstrapData,
  listPalitras,
  updatePalitra,
  uploadPalitraPoints,
} from '../../services/api/palitra';
import {
  applyRestrictedAccess,
  buildPalitraNameWithSuffix,
  compareStrings,
  DEFAULT_COLOR_HEX,
  formatErrorMessage,
  getAvailableAccessTypes,
  getInitialCreateForm,
  isFormValid,
  kmzColorOptionsFromAnalysis,
  normalizeSortableValue,
  palitraToForm,
  isAdmin,
  toCreateReq,
} from './helpers';
import { readDenseTableFromUrl, setDenseTableQueryParam } from '../../utils/denseTableQuery';
import { KmzColorOption, PalitraCreateMode, PalitraFormState, SortColumn, SortDirection, UiError } from './types';

function updateUrlSearchParams(mutator: (params: URLSearchParams) => void) {
  const url = new URL(window.location.href);
  const params = new URLSearchParams(url.search);
  mutator(params);
  const nextSearch = params.toString();
  const nextUrl = `${url.pathname}${nextSearch ? `?${nextSearch}` : ''}${url.hash}`;
  window.history.replaceState({}, '', nextUrl);
}

function readInitialPalitraSortFromUrl(): { sortColumn: SortColumn; sortDirection: SortDirection } {
  const params = new URLSearchParams(window.location.search);
  const sortColumnRaw = params.get('pal_sort_col');
  const sortDirectionRaw = params.get('pal_sort_dir');

  const sortColumn: SortColumn =
    sortColumnRaw === 'name' ||
    sortColumnRaw === 'colorHex' ||
    sortColumnRaw === 'sourceFileName' ||
    sortColumnRaw === 'author' ||
    sortColumnRaw === 'lastUploadedAtTs'
      ? sortColumnRaw
      : 'lastUploadedAtTs';
  const sortDirection: SortDirection = sortDirectionRaw === 'asc' || sortDirectionRaw === 'desc' ? sortDirectionRaw : 'desc';

  return { sortColumn, sortDirection };
}

function syncPalitraSortToUrl(sortColumn: SortColumn, sortDirection: SortDirection, denseTable: boolean) {
  updateUrlSearchParams((params) => {
    if (sortColumn === 'lastUploadedAtTs') {
      params.delete('pal_sort_col');
    } else {
      params.set('pal_sort_col', sortColumn);
    }

    if (sortDirection === 'desc') {
      params.delete('pal_sort_dir');
    } else {
      params.set('pal_sort_dir', sortDirection);
    }

    setDenseTableQueryParam(params, denseTable);
  });
}

function canModifyPalitra(user: User | null, palitra: Palitra): boolean {
  return isAdmin(user) || palitra.author === user?.name;
}

export function useRerPalitraNeoPage() {
  const initialSort = React.useMemo(() => readInitialPalitraSortFromUrl(), []);
  const [user, setUser] = React.useState<User | null>(null);
  const [palitras, setPalitras] = React.useState<Palitra[]>([]);
  const [myScope, setMyScope] = React.useState<MyScope | null>(null);
  const [organisms, setOrganisms] = React.useState<Organism[]>([]);
  const [aors, setAors] = React.useState<AreaOfResponsibility[]>([]);
  const [allLogins, setAllLogins] = React.useState<string[]>([]);

  const [loading, setLoading] = React.useState(true);
  const [inFlightDeleteId, setInFlightDeleteId] = React.useState<number | null>(null);
  const [inFlightUploadId, setInFlightUploadId] = React.useState<number | null>(null);
  const [deleteDialogPalitra, setDeleteDialogPalitra] = React.useState<Palitra | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = React.useState(false);
  const [selectedPalitraIds, setSelectedPalitraIds] = React.useState<number[]>([]);
  const [bulkDeleteDialogPalitras, setBulkDeleteDialogPalitras] = React.useState<Palitra[]>([]);
  const [bulkDeleteDialogOpen, setBulkDeleteDialogOpen] = React.useState(false);
  const [bulkDeleteInFlight, setBulkDeleteInFlight] = React.useState(false);
  const [error, setError] = React.useState<UiError | null>(null);

  const [sortColumn, setSortColumn] = React.useState<SortColumn>(initialSort.sortColumn);
  const [sortDirection, setSortDirection] = React.useState<SortDirection>(initialSort.sortDirection);
  const [denseTable, setDenseTable] = React.useState<boolean>(() => readDenseTableFromUrl());

  const [createOpen, setCreateOpen] = React.useState(false);
  const [createMode, setCreateMode] = React.useState<PalitraCreateMode>('basic');
  const [createForm, setCreateForm] = React.useState<PalitraFormState>(getInitialCreateForm(null, null));
  const [createInFlight, setCreateInFlight] = React.useState(false);

  const [kmzFile, setKmzFile] = React.useState<File | null>(null);
  const [kmzAnalysis, setKmzAnalysis] = React.useState<AnalyzeKmzResponse | null>(null);
  const [kmzAnalyzing, setKmzAnalyzing] = React.useState(false);
  const [kmzColorOptions, setKmzColorOptions] = React.useState<KmzColorOption[]>([]);
  const [selectedColorFromKmz, setSelectedColorFromKmz] = React.useState<string>(DEFAULT_COLOR_HEX);

  const [editPalitraId, setEditPalitraId] = React.useState<number | null>(null);
  const [editForm, setEditForm] = React.useState<PalitraFormState | null>(null);
  const [editInFlight, setEditInFlight] = React.useState(false);
  const createCloseClearErrorRef = React.useRef(true);

  const uploadPointsInputRef = React.useRef<HTMLInputElement | null>(null);
  const uploadKmzInputRef = React.useRef<HTMLInputElement | null>(null);
  const pendingUploadPalitraIdRef = React.useRef<number | null>(null);

  const availableAccessTypes = React.useMemo(() => getAvailableAccessTypes(user, myScope), [user, myScope]);
  const updateCreateForm = React.useCallback(
    (updater: (prev: PalitraFormState) => PalitraFormState) => setCreateForm((prev) => updater(prev)),
    [],
  );
  const updateKmzColorOptions = React.useCallback(
    (updater: (prev: KmzColorOption[]) => KmzColorOption[]) => setKmzColorOptions((prev) => updater(prev)),
    [],
  );
  const updateEditForm = React.useCallback(
    (updater: (prev: PalitraFormState | null) => PalitraFormState | null) => setEditForm((prev) => updater(prev)),
    [],
  );

  const sortedPalitras = React.useMemo(() => {
    const sorted = [...palitras];

    sorted.sort((a, b) => {
      let result = 0;
      if (sortColumn === 'name') {
        result = compareStrings(normalizeSortableValue(a.name), normalizeSortableValue(b.name));
      } else if (sortColumn === 'colorHex') {
        result = compareStrings(normalizeSortableValue(a.colorHex), normalizeSortableValue(b.colorHex));
      } else if (sortColumn === 'sourceFileName') {
        result = compareStrings(normalizeSortableValue(a.sourceFileName), normalizeSortableValue(b.sourceFileName));
      } else if (sortColumn === 'author') {
        result = compareStrings(normalizeSortableValue(a.author), normalizeSortableValue(b.author));
      } else {
        const left = a.lastUploadedAtTs ?? Number.NEGATIVE_INFINITY;
        const right = b.lastUploadedAtTs ?? Number.NEGATIVE_INFINITY;
        result = left - right;
      }

      return sortDirection === 'asc' ? result : -result;
    });

    return sorted;
  }, [palitras, sortColumn, sortDirection]);

  React.useEffect(() => {
    syncPalitraSortToUrl(sortColumn, sortDirection, denseTable);
  }, [sortColumn, sortDirection, denseTable]);

  const reloadPalitras = React.useCallback(async () => {
    const list = await listPalitras();
    setPalitras(list);
    setSelectedPalitraIds((prev) => (prev.length === 0 ? prev : []));
  }, []);

  React.useEffect(() => {
    let cancelled = false;

    async function loadData() {
      setLoading(true);
      setError(null);

      try {
        const data = await fetchPalitraBootstrapData();
        if (cancelled) return;

        setUser(data.user);
        setPalitras(data.palitras);
        setMyScope(data.myScope);
        setAllLogins(data.logins?.users.map((entry) => entry.login) ?? []);
        setOrganisms(data.organisms ?? []);
        setAors(data.aors ?? []);
        setCreateForm(getInitialCreateForm(data.user, data.myScope));
      } catch (loadError) {
        if (cancelled) return;

        if (isUnauthorizedError(loadError)) {
          window.location.assign('/login');
          return;
        }

        setError({ text: `Не вдалося завантажити палітри: ${formatErrorMessage(loadError)}` });
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadData();

    return () => {
      cancelled = true;
    };
  }, []);

  function clearCreateFlow(clearError: boolean) {
    if (clearError) setError(null);
    setCreateMode('basic');
    setCreateForm(getInitialCreateForm(user, myScope));
    setCreateInFlight(false);
    setKmzFile(null);
    setKmzAnalysis(null);
    setKmzAnalyzing(false);
    setKmzColorOptions([]);
    setSelectedColorFromKmz(DEFAULT_COLOR_HEX);
  }

  function resetCreateFlow(clearError = true) {
    createCloseClearErrorRef.current = clearError;
    setCreateOpen(false);
  }

  function openCreate() {
    if (createInFlight) return;
    setError(null);
    clearCreateFlow(false);
    setCreateOpen(true);
  }

  function onCreateDrawerExited() {
    if (createOpen) return;
    clearCreateFlow(createCloseClearErrorRef.current);
  }

  function openEdit(palitra: Palitra) {
    setEditPalitraId(palitra.id);
    setEditForm(applyRestrictedAccess(palitraToForm(palitra), user, myScope));
  }

  function closeEdit() {
    setEditPalitraId(null);
    setEditForm(null);
    setEditInFlight(false);
  }

  function onSortColumn(column: SortColumn) {
    if (sortColumn === column) {
      setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
      return;
    }

    setSortColumn(column);
    setSortDirection(column === 'lastUploadedAtTs' ? 'desc' : 'asc');
  }

  function requestDelete(palitra: Palitra) {
    if (inFlightDeleteId !== null || bulkDeleteInFlight || bulkDeleteDialogOpen) return;
    setDeleteDialogPalitra(palitra);
    setDeleteDialogOpen(true);
  }

  function cancelDelete() {
    if (inFlightDeleteId !== null || bulkDeleteInFlight) return;
    setDeleteDialogOpen(false);
  }

  async function confirmDelete() {
    const palitra = deleteDialogPalitra;
    if (!palitra || inFlightDeleteId !== null || bulkDeleteInFlight) return;

    setInFlightDeleteId(palitra.id);
    setError(null);

    try {
      await deletePalitra(palitra.id);
      setPalitras((prev) => prev.filter((item) => item.id !== palitra.id));
      setSelectedPalitraIds((prev) => prev.filter((id) => id !== palitra.id));
      setDeleteDialogOpen(false);
    } catch (deleteError) {
      if (isUnauthorizedError(deleteError)) {
        window.location.assign('/login');
        return;
      }

      setError({ text: `Не вдалося видалити палітру: ${formatErrorMessage(deleteError)}` });
    } finally {
      setInFlightDeleteId(null);
    }
  }

  function onDeleteDialogExited() {
    if (deleteDialogOpen || inFlightDeleteId !== null) return;
    setDeleteDialogPalitra(null);
  }

  function setPalitraSelected(palitraId: number, checked: boolean) {
    setSelectedPalitraIds((prev) => {
      if (checked) {
        if (prev.includes(palitraId)) return prev;
        return [...prev, palitraId];
      }

      return prev.filter((id) => id !== palitraId);
    });
  }

  function setAllPalitrasSelected(palitraIds: number[], checked: boolean) {
    if (palitraIds.length === 0) return;

    setSelectedPalitraIds((prev) => {
      if (checked) {
        const selected = new Set(prev);
        for (const palitraId of palitraIds) {
          selected.add(palitraId);
        }
        return Array.from(selected);
      }

      const toRemove = new Set(palitraIds);
      return prev.filter((id) => !toRemove.has(id));
    });
  }

  const clearSelectedPalitras = React.useCallback(() => {
    setSelectedPalitraIds((prev) => (prev.length === 0 ? prev : []));
  }, []);

  function requestBulkDelete() {
    if (bulkDeleteInFlight || inFlightDeleteId !== null || deleteDialogOpen) return;

    const selectedSet = new Set(selectedPalitraIds);
    const selected = palitras.filter(
      (palitra) =>
        selectedSet.has(palitra.id) &&
        canModifyPalitra(user, palitra) &&
        inFlightDeleteId !== palitra.id &&
        inFlightUploadId !== palitra.id,
    );
    if (selected.length === 0) return;

    setBulkDeleteDialogPalitras(selected);
    setBulkDeleteDialogOpen(true);
  }

  function cancelBulkDelete() {
    if (bulkDeleteInFlight || inFlightDeleteId !== null) return;
    setBulkDeleteDialogOpen(false);
  }

  async function confirmBulkDelete() {
    if (bulkDeleteInFlight || inFlightDeleteId !== null) return;

    const palitrasToDelete = [...bulkDeleteDialogPalitras];
    if (palitrasToDelete.length === 0) return;

    setBulkDeleteDialogOpen(false);
    setBulkDeleteInFlight(true);
    setError(null);

    const failed: string[] = [];

    try {
      for (const palitra of palitrasToDelete) {
        setInFlightDeleteId(palitra.id);

        try {
          await deletePalitra(palitra.id);
          setPalitras((prev) => prev.filter((item) => item.id !== palitra.id));
          setSelectedPalitraIds((prev) => prev.filter((id) => id !== palitra.id));
        } catch (deleteError) {
          if (isUnauthorizedError(deleteError)) {
            window.location.assign('/login');
            return;
          }

          failed.push(`${palitra.name}: ${formatErrorMessage(deleteError)}`);
        } finally {
          setInFlightDeleteId(null);
        }
      }

      if (failed.length > 0) {
        setError({ text: `Не вдалося видалити деякі палітри: ${failed[0]}` });
      }
    } finally {
      setBulkDeleteInFlight(false);
      setBulkDeleteDialogPalitras([]);
    }
  }

  function onBulkDeleteDialogExited() {
    if (bulkDeleteDialogOpen || bulkDeleteInFlight) return;
    setBulkDeleteDialogPalitras([]);
  }

  function requestUploadPoints(palitraId: number) {
    if (!uploadPointsInputRef.current) return;
    pendingUploadPalitraIdRef.current = palitraId;
    uploadPointsInputRef.current.value = '';
    uploadPointsInputRef.current.click();
  }

  async function handleUploadPointsSelected(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    const palitraId = pendingUploadPalitraIdRef.current;
    if (!file || palitraId === null) return;

    setInFlightUploadId(palitraId);
    setError(null);

    try {
      await uploadPalitraPoints(palitraId, file);
      await reloadPalitras();
    } catch (uploadError) {
      if (isUnauthorizedError(uploadError)) {
        window.location.assign('/login');
        return;
      }

      setError({ text: `Не вдалося завантажити точки: ${formatErrorMessage(uploadError)}` });
    } finally {
      setInFlightUploadId(null);
      pendingUploadPalitraIdRef.current = null;
    }
  }

  function requestAnalyzeKmz() {
    if (!uploadKmzInputRef.current) return;
    uploadKmzInputRef.current.value = '';
    uploadKmzInputRef.current.click();
  }

  async function handleKmzSelected(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    setKmzFile(file);
    setKmzAnalyzing(true);
    setKmzAnalysis(null);
    setKmzColorOptions([]);
    setSelectedColorFromKmz(DEFAULT_COLOR_HEX);
    setError(null);

    try {
      const analysis = await analyzePalitraKmz(file);
      const colorOptions = kmzColorOptionsFromAnalysis(analysis);
      const firstColor = colorOptions[0]?.colorHex ?? DEFAULT_COLOR_HEX;

      setKmzAnalysis(analysis);
      setKmzColorOptions(colorOptions);
      setSelectedColorFromKmz(firstColor);
      setCreateForm((prev) => ({
        ...prev,
        colorHex: firstColor,
        name: analysis.filename || prev.name,
      }));
    } catch (analysisError) {
      if (isUnauthorizedError(analysisError)) {
        window.location.assign('/login');
        return;
      }

      setError({ text: `Не вдалося проаналізувати KMZ файл: ${formatErrorMessage(analysisError)}` });
    } finally {
      setKmzAnalyzing(false);
    }
  }

  async function handleCreate(mode: PalitraCreateMode) {
    if (!kmzFile || createInFlight) return;

    const normalizedForm = applyRestrictedAccess(createForm, user, myScope);
    if (!isFormValid(normalizedForm)) return;

    setCreateInFlight(true);
    setError(null);

    try {
      if (mode === 'advanced' && kmzColorOptions.length > 0) {
        const selectedOptions = kmzColorOptions.filter((option) => option.selected);
        if (selectedOptions.length === 0) {
          setError({ text: 'Оберіть хоча б один колір з KMZ.' });
          return;
        }

        const results = await Promise.allSettled(
          selectedOptions.map((option) => {
            const req = toCreateReq({
              ...normalizedForm,
              colorHex: option.colorHex,
              name: buildPalitraNameWithSuffix(normalizedForm.name, option.suffix),
            });
            return createPalitraWithKmz(req, kmzFile);
          }),
        );

        const created = results
          .filter((result): result is PromiseFulfilledResult<Palitra> => result.status === 'fulfilled')
          .map((result) => result.value);

        const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (rejected.some((result) => isUnauthorizedError(result.reason))) {
          window.location.assign('/login');
          return;
        }

        const firstError = rejected[0];
        if (firstError) {
          setError({ text: `Помилка створення палітри: ${formatErrorMessage(firstError.reason)}` });
        }

        if (created.length > 0) {
          setPalitras((prev) => [...created, ...prev]);
          resetCreateFlow(!firstError);
        }

        return;
      }

      await createPalitraBasicWithKmz(
        toCreateReq({
          ...normalizedForm,
          colorHex: selectedColorFromKmz,
        }),
        kmzFile,
      );
      await reloadPalitras();
      resetCreateFlow();
    } catch (createError) {
      if (isUnauthorizedError(createError)) {
        window.location.assign('/login');
        return;
      }

      setError({ text: `Не вдалося створити палітру: ${formatErrorMessage(createError)}` });
    } finally {
      setCreateInFlight(false);
    }
  }

  async function handleEditSave() {
    if (!editForm || editPalitraId === null || editInFlight) return;

    const normalizedForm = applyRestrictedAccess(editForm, user, myScope);
    if (!isFormValid(normalizedForm)) return;

    setEditInFlight(true);
    setError(null);

    try {
      const details = await updatePalitra(editPalitraId, toCreateReq(normalizedForm));
      setPalitras((prev) => prev.map((palitra) => (palitra.id === editPalitraId ? details.palitra : palitra)));
      closeEdit();
    } catch (updateError) {
      if (isUnauthorizedError(updateError)) {
        window.location.assign('/login');
        return;
      }

      setError({ text: `Не вдалося оновити палітру: ${formatErrorMessage(updateError)}` });
    } finally {
      setEditInFlight(false);
    }
  }

  return {
    user,
    myScope,
    organisms,
    aors,
    allLogins,
    error,
    loading,
    sortedPalitras,
    sortColumn,
    sortDirection,
    denseTable,
    inFlightDeleteId,
    inFlightUploadId,
    deleteDialogPalitra,
    deleteDialogOpen,
    selectedPalitraIds,
    bulkDeleteDialogPalitras,
    bulkDeleteDialogOpen,
    bulkDeleteInFlight,
    createOpen,
    createMode,
    createForm,
    createInFlight,
    kmzFile,
    kmzAnalysis,
    kmzAnalyzing,
    kmzColorOptions,
    selectedColorFromKmz,
    editPalitraId,
    editForm,
    editInFlight,
    availableAccessTypes,
    uploadPointsInputRef,
    uploadKmzInputRef,
    setCreateForm,
    setEditForm,
    setKmzColorOptions,
    setSelectedColorFromKmz,
    updateCreateForm,
    setCreateMode,
    updateKmzColorOptions,
    updateEditForm,
    openCreate,
    resetCreateFlow,
    openEdit,
    closeEdit,
    onSortColumn,
    setDenseTable,
    requestUploadPoints,
    requestDelete,
    cancelDelete,
    confirmDelete,
    onDeleteDialogExited,
    setPalitraSelected,
    setAllPalitrasSelected,
    clearSelectedPalitras,
    requestBulkDelete,
    cancelBulkDelete,
    confirmBulkDelete,
    onBulkDeleteDialogExited,
    requestAnalyzeKmz,
    onCreateDrawerExited,
    handleCreate,
    handleEditSave,
    handleUploadPointsSelected,
    handleKmzSelected,
  };
}
