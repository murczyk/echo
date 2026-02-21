import React from 'react';

import { AnalyzeKmzResponse, AreaOfResponsibility, MyScope, Organism, Palitra, User } from '../../../../Bindings';
import { isUnauthorizedError } from '../../services/api/client';
import {
  analyzePalitraKmz,
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
  toCreateReq,
} from './helpers';
import { KmzColorOption, PalitraFormState, SortColumn, SortDirection, UiError } from './types';

function fileNameToBaseName(fileName: string): string {
  const dotIndex = fileName.lastIndexOf('.');
  if (dotIndex <= 0) return fileName;
  return fileName.slice(0, dotIndex);
}

export function useRerPalitraNeoPage() {
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
  const [error, setError] = React.useState<UiError | null>(null);

  const [sortColumn, setSortColumn] = React.useState<SortColumn>('lastUploadedAtTs');
  const [sortDirection, setSortDirection] = React.useState<SortDirection>('desc');

  const [createOpen, setCreateOpen] = React.useState(false);
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

  const reloadPalitras = React.useCallback(async () => {
    const list = await listPalitras();
    setPalitras(list);
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
    if (inFlightDeleteId !== null) return;
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement) {
      activeElement.blur();
    }
    setDeleteDialogPalitra(palitra);
    setDeleteDialogOpen(true);
  }

  function cancelDelete() {
    if (inFlightDeleteId !== null) return;
    setDeleteDialogOpen(false);
  }

  async function confirmDelete() {
    const palitra = deleteDialogPalitra;
    if (!palitra || inFlightDeleteId !== null) return;

    setInFlightDeleteId(palitra.id);
    setError(null);

    try {
      await deletePalitra(palitra.id);
      setPalitras((prev) => prev.filter((item) => item.id !== palitra.id));
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
        name: fileNameToBaseName(analysis.filename) || prev.name,
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

  async function handleCreate() {
    if (!kmzFile || createInFlight) return;

    const normalizedForm = applyRestrictedAccess(createForm, user, myScope);
    if (!isFormValid(normalizedForm)) return;

    setCreateInFlight(true);
    setError(null);

    try {
      if (kmzColorOptions.length > 0) {
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

      const created = await createPalitraWithKmz(
        toCreateReq({
          ...normalizedForm,
          colorHex: selectedColorFromKmz,
        }),
        kmzFile,
      );
      setPalitras((prev) => [created, ...prev]);
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
    inFlightDeleteId,
    inFlightUploadId,
    deleteDialogPalitra,
    deleteDialogOpen,
    createOpen,
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
    updateKmzColorOptions,
    updateEditForm,
    openCreate,
    resetCreateFlow,
    openEdit,
    closeEdit,
    onSortColumn,
    requestUploadPoints,
    requestDelete,
    cancelDelete,
    confirmDelete,
    onDeleteDialogExited,
    requestAnalyzeKmz,
    onCreateDrawerExited,
    handleCreate,
    handleEditSave,
    handleUploadPointsSelected,
    handleKmzSelected,
  };
}
