import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';

import { AnalyzeKmzResponse, AreaOfResponsibility, MyScope, Organism, Palitra, User } from '../../../../Bindings';
import { isUnauthorizedError } from '../../services/api/client';
import {
  analyzePalitraKmz,
  archivePalitra,
  archivePalitraFolder,
  assignPalitraFolder,
  createPalitraBasicWithKmz,
  createPalitraWithKmz,
  deletePalitra,
  deletePalitraFolder,
  downloadPalitras,
  fetchPalitraReferenceData,
  listPalitras,
  renamePalitraFolder,
  unarchivePalitra,
  updatePalitra,
  uploadPalitraPoints,
} from '../../services/api/palitra';
import { fetchCurrentUser } from '../../services/api/user';
import { downloadBlob } from '../../utils/download-blob';
import {
  applyRestrictedAccess,
  buildAssignFolderPreview,
  buildBulkActionResultSummary,
  buildFolderSubtreePreview,
  buildFolderTree,
  buildPalitraNameWithSuffix,
  buildTableRows,
  DEFAULT_COLOR_HEX,
  formatErrorMessage,
  formatFolderActionSuccessMessage,
  normalizeFolderPathForUi,
  validateFolderPath,
  getAvailableAccessTypes,
  getExistingFolderOptions,
  getFolderNodeByPath,
  getInitialCreateForm,
  isFormValid,
  kmzColorOptionsFromAnalysis,
  palitraToForm,
  toCreateReq,
} from './helpers';
import type { FolderActionDialogState, KmzColorOption, PalitraCreateMode, PalitraFormState, TableRowView, UiStatus } from './types';

type ArchiveView = 'active' | 'all' | 'archived';

const VIEW_MODE_QUERY_PARAM = 'viewMode';

function readInitialArchiveViewFromUrl(): ArchiveView {
  const params = new URLSearchParams(window.location.search);
  const value = params.get(VIEW_MODE_QUERY_PARAM);
  if (value === 'all' || value === 'archived' || value === 'active') {
    return value;
  }
  return 'active';
}

function updateUrlSearchParams(mutator: (params: URLSearchParams) => void) {
  const url = new URL(window.location.href);
  const params = new URLSearchParams(url.search);
  mutator(params);
  const nextSearch = params.toString();
  const nextUrl = url.pathname + (nextSearch ? '?' + nextSearch : '') + url.hash;
  window.history.replaceState({}, '', nextUrl);
}

function buildFolderActionStatus(state: FolderActionDialogState, changedIds: number[]): UiStatus {
  const summary = buildBulkActionResultSummary(state.targetPalitraIds, changedIds);
  const text = formatFolderActionSuccessMessage(state.kind, summary);

  if (summary.changedCount === 0) {
    return { kind: 'warning', text };
  }

  if (state.preview.skippedCount > 0 || state.preview.unchangedCount > 0 || summary.skippedCount > 0) {
    return { kind: 'warning', text };
  }

  return { kind: 'success', text };
}

export function useRerPalitraNeoPage() {
  const [archiveView, setArchiveView] = useState<ArchiveView>(() => readInitialArchiveViewFromUrl());
  const [user, setUser] = useState<User | null>(null);
  const [palitras, setPalitras] = useState<Palitra[]>([]);
  const [myScope, setMyScope] = useState<MyScope | null>(null);
  const [organisms, setOrganisms] = useState<Organism[]>([]);
  const [aors, setAors] = useState<AreaOfResponsibility[]>([]);
  const [allLogins, setAllLogins] = useState<string[]>([]);

  const [loading, setLoading] = useState(true);
  const [referenceDataReady, setReferenceDataReady] = useState(false);
  const [inFlightArchiveId, setInFlightArchiveId] = useState<number | null>(null);
  const [inFlightDeleteId, setInFlightDeleteId] = useState<number | null>(null);
  const [inFlightDownloadId, setInFlightDownloadId] = useState<number | null>(null);
  const [inFlightUploadId, setInFlightUploadId] = useState<number | null>(null);
  const [archiveDialogPalitra, setArchiveDialogPalitra] = useState<Palitra | null>(null);
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false);
  const [deleteDialogPalitra, setDeleteDialogPalitra] = useState<Palitra | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [selectedPalitraIds, setSelectedPalitraIds] = useState<number[]>([]);
  const [bulkDeleteDialogPalitras, setBulkDeleteDialogPalitras] = useState<Palitra[]>([]);
  const [bulkDeleteDialogOpen, setBulkDeleteDialogOpen] = useState(false);
  const [bulkDeleteInFlight, setBulkDeleteInFlight] = useState(false);
  const [status, setStatus] = useState<UiStatus>(null);
  const [folderDialogState, setFolderDialogState] = useState<FolderActionDialogState | null>(null);
  const [folderActionInFlight, setFolderActionInFlight] = useState(false);
  const [expandedFolderPaths, setExpandedFolderPaths] = useState<string[]>([]);

  const [createOpen, setCreateOpen] = useState(false);
  const [createMode, setCreateMode] = useState<PalitraCreateMode>('basic');
  const [createForm, setCreateForm] = useState<PalitraFormState>(getInitialCreateForm(null, null));
  const [createInFlight, setCreateInFlight] = useState(false);

  const [kmzFile, setKmzFile] = useState<File | null>(null);
  const [kmzAnalysis, setKmzAnalysis] = useState<AnalyzeKmzResponse | null>(null);
  const [kmzAnalyzing, setKmzAnalyzing] = useState(false);
  const [kmzColorOptions, setKmzColorOptions] = useState<KmzColorOption[]>([]);
  const [selectedColorFromKmz, setSelectedColorFromKmz] = useState<string>(DEFAULT_COLOR_HEX);

  const [editPalitraId, setEditPalitraId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<PalitraFormState | null>(null);
  const [editInFlight, setEditInFlight] = useState(false);
  const createCloseClearErrorRef = useRef(true);

  const uploadPointsInputRef = useRef<HTMLInputElement | null>(null);
  const uploadKmzInputRef = useRef<HTMLInputElement | null>(null);
  const pendingUploadPalitraIdRef = useRef<number | null>(null);

  const availableAccessTypes = useMemo(() => getAvailableAccessTypes(user, myScope), [user, myScope]);
  const folderTree = useMemo(() => buildFolderTree(palitras, user), [palitras, user]);
  const folderOptions = useMemo(() => getExistingFolderOptions(folderTree), [folderTree]);
  const expandedFolderPathSet = useMemo(() => new Set(expandedFolderPaths), [expandedFolderPaths]);
  const visiblePalitras = useMemo(() => {
    switch (archiveView) {
      case 'archived':
        return palitras.filter((palitra) => palitra.isArchived);
      case 'all':
        return palitras;
      case 'active':
      default:
        return palitras.filter((palitra) => !palitra.isArchived);
    }
  }, [archiveView, palitras]);
  const rows = useMemo<TableRowView[]>(() => buildTableRows({
    palitras: visiblePalitras,
    user,
    myScope,
    organisms,
    aors,
    inFlightArchiveId,
    inFlightDeleteId,
    inFlightDownloadId,
    inFlightUploadId,
    expandedFolderPaths: expandedFolderPathSet,
  }), [visiblePalitras, user, myScope, organisms, aors, inFlightArchiveId, inFlightDeleteId, inFlightDownloadId, inFlightUploadId, expandedFolderPathSet]);
  const palitraRows = useMemo(() => rows.filter((row): row is Extract<TableRowView, { kind: 'palitra' }> => row.kind === 'palitra'), [rows]);
  const visibleSelectablePalitraIds = useMemo(() => new Set(palitraRows.filter((row) => row.canSelect).map((row) => row.id)), [palitraRows]);
  const folderActionsBlocked = folderActionInFlight || folderDialogState !== null;
  const updateCreateForm = useCallback((updater: (prev: PalitraFormState) => PalitraFormState) => setCreateForm((prev) => updater(prev)), []);
  const updateKmzColorOptions = useCallback((updater: (prev: KmzColorOption[]) => KmzColorOption[]) => setKmzColorOptions((prev) => updater(prev)), []);
  const updateEditForm = useCallback((updater: (prev: PalitraFormState | null) => PalitraFormState | null) => setEditForm((prev) => updater(prev)), []);

  useEffect(() => {
    function onPopState() {
      setArchiveView(readInitialArchiveViewFromUrl());
    }

    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    updateUrlSearchParams((params) => {
      if (archiveView === 'active') {
        params.delete(VIEW_MODE_QUERY_PARAM);
      } else {
        params.set(VIEW_MODE_QUERY_PARAM, archiveView);
      }
    });
  }, [archiveView]);

  useEffect(() => {
    setSelectedPalitraIds((prev) => {
      const next = prev.filter((id) => visibleSelectablePalitraIds.has(id));
      return next.length === prev.length ? prev : next;
    });
  }, [visibleSelectablePalitraIds]);

  const reloadPalitras = useCallback(async () => {
    const list = await listPalitras();
    setPalitras(list);
    setSelectedPalitraIds((prev) => (prev.length === 0 ? prev : []));
  }, []);

  const setPalitraFolderLocally = useCallback((palitraIds: number[], nextFolderPath: string) => {
    const palitraIdSet = new Set(palitraIds);
    const normalizedFolderPath = normalizeFolderPathForUi(nextFolderPath);

    setPalitras((prev) =>
      prev.map((palitra) =>
        palitraIdSet.has(palitra.id)
          ? {
              ...palitra,
              folder: normalizedFolderPath === '' ? null : normalizedFolderPath,
            }
          : palitra,
      ),
    );
  }, []);

  const renameFolderLocally = useCallback((palitraIds: number[], fromFolderPath: string, nextFolderPath: string) => {
    const palitraIdSet = new Set(palitraIds);
    const normalizedFromPath = normalizeFolderPathForUi(fromFolderPath);
    const normalizedNextPath = normalizeFolderPathForUi(nextFolderPath);
    const fromPrefix = normalizedFromPath + '/';

    setPalitras((prev) =>
      prev.map((palitra) => {
        if (!palitraIdSet.has(palitra.id)) return palitra;

        const normalizedFolderPath = normalizeFolderPathForUi(palitra.folder ?? '');
        if (normalizedFolderPath === normalizedFromPath) {
          return {
            ...palitra,
            folder: normalizedNextPath === '' ? null : normalizedNextPath,
          };
        }

        if (!normalizedFolderPath.startsWith(fromPrefix)) return palitra;

        return {
          ...palitra,
          folder: normalizedNextPath + normalizedFolderPath.slice(normalizedFromPath.length),
        };
      }),
    );
  }, []);

  const archiveFolderLocally = useCallback((palitraIds: number[]) => {
    const palitraIdSet = new Set(palitraIds);

    setPalitras((prev) =>
      prev.map((palitra) => (palitraIdSet.has(palitra.id) ? { ...palitra, isArchived: true } : palitra)),
    );
  }, []);

  const deleteFolderLocally = useCallback((palitraIds: number[]) => {
    const palitraIdSet = new Set(palitraIds);

    setPalitras((prev) => prev.filter((palitra) => !palitraIdSet.has(palitra.id)));
    setSelectedPalitraIds((prev) => prev.filter((id) => !palitraIdSet.has(id)));
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadData() {
      setLoading(true);
      setReferenceDataReady(false);
      setStatus(null);

      try {
        const currentUser = await fetchCurrentUser();
        if (cancelled) return;

        setUser(currentUser);

        const palitrasPromise = listPalitras();
        const referencesPromise = fetchPalitraReferenceData(currentUser);

        try {
          const references = await referencesPromise;
          if (cancelled) return;

          setMyScope(references.myScope);
          setAllLogins(references.logins?.users.map((entry) => entry.login) ?? references.organismLogins ?? []);
          setOrganisms(references.organisms ?? []);
          setAors(references.aors ?? []);
          setReferenceDataReady(true);
          setCreateForm((prevForm) => {
            const initialCreateForm = getInitialCreateForm(currentUser, references.myScope);

            return {
              ...prevForm,
              ...initialCreateForm,
              name: prevForm.name,
              colorHex: prevForm.colorHex,
            };
          });
        } catch (referencesError) {
          if (cancelled) return;

          if (isUnauthorizedError(referencesError)) {
            await palitrasPromise.catch(() => null);
            if (cancelled) return;
            window.location.assign('/login');
            return;
          }

          setStatus({ kind: 'error', text: 'Не вдалося завантажити довідники палітр: ' + formatErrorMessage(referencesError) });
        }

        try {
          const palitrasList = await palitrasPromise;
          if (cancelled) return;

          setPalitras(palitrasList);
        } catch (palitrasError) {
          if (cancelled) return;

          if (isUnauthorizedError(palitrasError)) {
            window.location.assign('/login');
            return;
          }

          setStatus({ kind: 'error', text: 'Не вдалося завантажити палітри: ' + formatErrorMessage(palitrasError) });
        }
      } catch (loadError) {
        if (cancelled) return;

        if (isUnauthorizedError(loadError)) {
          window.location.assign('/login');
          return;
        }

        setStatus({ kind: 'error', text: 'Не вдалося завантажити палітри: ' + formatErrorMessage(loadError) });
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
    if (clearError) setStatus(null);
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
    if (createInFlight || folderActionsBlocked) return;
    setStatus(null);
    clearCreateFlow(false);
    setCreateOpen(true);
  }

  function onCreateDrawerExited() {
    if (createOpen) return;
    clearCreateFlow(createCloseClearErrorRef.current);
  }

  function openEdit(palitra: Palitra) {
    if (folderActionsBlocked) return;
    setEditPalitraId(palitra.id);
    setEditForm(applyRestrictedAccess(palitraToForm(palitra), user, myScope, allLogins));
  }

  function replacePalitra(nextPalitra: Palitra) {
    setPalitras((prev) => prev.map((palitra) => (palitra.id === nextPalitra.id ? nextPalitra : palitra)));
  }

  function closeEdit() {
    setEditPalitraId(null);
    setEditForm(null);
    setEditInFlight(false);
  }

  function requestArchive(palitra: Palitra) {
    if (archiveDialogOpen || inFlightArchiveId !== null || inFlightDeleteId !== null || bulkDeleteInFlight || folderActionsBlocked) return;
    setArchiveDialogPalitra(palitra);
    setArchiveDialogOpen(true);
  }

  function cancelArchive() {
    if (inFlightArchiveId !== null || inFlightDeleteId !== null || bulkDeleteInFlight) return;
    setArchiveDialogOpen(false);
  }

  async function confirmArchive() {
    const palitra = archiveDialogPalitra;
    if (!palitra || inFlightArchiveId !== null || inFlightDeleteId !== null || bulkDeleteInFlight || folderActionsBlocked) return;

    setInFlightArchiveId(palitra.id);
    setStatus(null);

    try {
      const updatedPalitra = await archivePalitra(palitra.id);
      replacePalitra(updatedPalitra);
      setArchiveDialogOpen(false);
    } catch (archiveError) {
      if (isUnauthorizedError(archiveError)) {
        window.location.assign('/login');
        return;
      }

      setStatus({ kind: 'error', text: 'Не вдалося перенести палітру в архів: ' + formatErrorMessage(archiveError) });
    } finally {
      setInFlightArchiveId(null);
    }
  }

  function onArchiveDialogExited() {
    if (archiveDialogOpen || inFlightArchiveId !== null) return;
    setArchiveDialogPalitra(null);
  }

  async function handleUnarchive(palitra: Palitra) {
    if (inFlightArchiveId !== null || inFlightDeleteId !== null || bulkDeleteInFlight || folderActionsBlocked) return;

    setInFlightArchiveId(palitra.id);
    setStatus(null);

    try {
      const updatedPalitra = await unarchivePalitra(palitra.id);
      replacePalitra(updatedPalitra);
    } catch (archiveError) {
      if (isUnauthorizedError(archiveError)) {
        window.location.assign('/login');
        return;
      }

      setStatus({ kind: 'error', text: 'Не вдалося повернути палітру з архіву: ' + formatErrorMessage(archiveError) });
    } finally {
      setInFlightArchiveId(null);
    }
  }

  function requestDelete(palitra: Palitra) {
    if (inFlightArchiveId !== null || inFlightDeleteId !== null || bulkDeleteInFlight || bulkDeleteDialogOpen || folderActionsBlocked) return;
    setDeleteDialogPalitra(palitra);
    setDeleteDialogOpen(true);
  }

  function cancelDelete() {
    if (inFlightArchiveId !== null || inFlightDeleteId !== null || bulkDeleteInFlight) return;
    setDeleteDialogOpen(false);
  }

  async function confirmDelete() {
    const palitra = deleteDialogPalitra;
    if (!palitra || inFlightArchiveId !== null || inFlightDeleteId !== null || bulkDeleteInFlight || folderActionsBlocked) return;

    setInFlightDeleteId(palitra.id);
    setStatus(null);

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

      setStatus({ kind: 'error', text: 'Не вдалося видалити палітру: ' + formatErrorMessage(deleteError) });
    } finally {
      setInFlightDeleteId(null);
    }
  }

  function onDeleteDialogExited() {
    if (deleteDialogOpen || inFlightDeleteId !== null) return;
    setDeleteDialogPalitra(null);
  }

  function requestBulkDelete() {
    if (archiveDialogOpen || bulkDeleteInFlight || inFlightArchiveId !== null || inFlightDeleteId !== null || deleteDialogOpen || folderActionsBlocked) return;

    const selectedSet = new Set(selectedPalitraIds);
    const selected = palitraRows.filter((row) => selectedSet.has(row.id) && row.canSelect).map((row) => row.palitra);
    if (selected.length === 0) return;

    setBulkDeleteDialogPalitras(selected);
    setBulkDeleteDialogOpen(true);
  }

  function cancelBulkDelete() {
    if (bulkDeleteInFlight || inFlightArchiveId !== null || inFlightDeleteId !== null) return;
    setBulkDeleteDialogOpen(false);
  }

  async function confirmBulkDelete() {
    if (bulkDeleteInFlight || inFlightArchiveId !== null || inFlightDeleteId !== null || folderActionsBlocked) return;

    const palitrasToDelete = [...bulkDeleteDialogPalitras];
    if (palitrasToDelete.length === 0) return;

    setBulkDeleteDialogOpen(false);
    setBulkDeleteInFlight(true);
    setStatus(null);

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

          failed.push(palitra.name + ': ' + formatErrorMessage(deleteError));
        } finally {
          setInFlightDeleteId(null);
        }
      }

      if (failed.length > 0) {
        setStatus({ kind: 'error', text: 'Не вдалося видалити деякі палітри: ' + failed[0] });
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
    if (folderActionsBlocked || !uploadPointsInputRef.current) return;
    pendingUploadPalitraIdRef.current = palitraId;
    uploadPointsInputRef.current.value = '';
    uploadPointsInputRef.current.click();
  }

  async function handleDownload(palitra: Palitra) {
    if (inFlightDownloadId !== null || folderActionsBlocked) return;

    setInFlightDownloadId(palitra.id);
    setStatus(null);

    try {
      const blob = await downloadPalitras([palitra.id]);
      downloadBlob(blob, 'palitra-' + String(palitra.id) + '.zip');
    } catch (downloadError) {
      if (isUnauthorizedError(downloadError)) {
        window.location.assign('/login');
        return;
      }

      setStatus({ kind: 'error', text: 'Не вдалося завантажити палітру: ' + formatErrorMessage(downloadError) });
    } finally {
      setInFlightDownloadId(null);
    }
  }

  async function handleUploadPointsSelected(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    const palitraId = pendingUploadPalitraIdRef.current;
    if (!file || palitraId === null) return;

    setInFlightUploadId(palitraId);
    setStatus(null);

    try {
      await uploadPalitraPoints(palitraId, file);
      await reloadPalitras();
    } catch (uploadError) {
      if (isUnauthorizedError(uploadError)) {
        window.location.assign('/login');
        return;
      }

      setStatus({ kind: 'error', text: 'Не вдалося завантажити точки: ' + formatErrorMessage(uploadError) });
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

  async function handleKmzSelected(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    setKmzFile(file);
    setKmzAnalyzing(true);
    setKmzAnalysis(null);
    setKmzColorOptions([]);
    setSelectedColorFromKmz(DEFAULT_COLOR_HEX);
    setStatus(null);

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

      setStatus({ kind: 'error', text: 'Не вдалося проаналізувати KMZ файл: ' + formatErrorMessage(analysisError) });
    } finally {
      setKmzAnalyzing(false);
    }
  }

  async function handleCreate(mode: PalitraCreateMode) {
    if (!kmzFile || createInFlight) return;

    const normalizedForm = applyRestrictedAccess(createForm, user, myScope, allLogins);
    if (!isFormValid(normalizedForm)) return;

    setCreateInFlight(true);
    setStatus(null);

    try {
      if (mode === 'advanced' && kmzColorOptions.length > 0) {
        const selectedOptions = kmzColorOptions.filter((option) => option.selected);
        if (selectedOptions.length === 0) {
          setStatus({ kind: 'error', text: 'Оберіть хоча б один колір з KMZ.' });
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

        const created = results.filter((result): result is PromiseFulfilledResult<Palitra> => result.status === 'fulfilled').map((result) => result.value);
        const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (rejected.some((result) => isUnauthorizedError(result.reason))) {
          window.location.assign('/login');
          return;
        }

        const firstError = rejected[0];
        if (firstError) {
          setStatus({ kind: 'error', text: 'Помилка створення палітри: ' + formatErrorMessage(firstError.reason) });
        }

        if (created.length > 0) {
          setPalitras((prev) => [...created, ...prev]);
          resetCreateFlow(!firstError);
        }

        return;
      }

      const createdPalitra = await createPalitraBasicWithKmz(
        toCreateReq({
          ...normalizedForm,
          colorHex: selectedColorFromKmz,
        }),
        kmzFile,
      );
      setPalitras((prev) => [createdPalitra, ...prev]);
      resetCreateFlow();
    } catch (createError) {
      if (isUnauthorizedError(createError)) {
        window.location.assign('/login');
        return;
      }

      setStatus({ kind: 'error', text: 'Не вдалося створити палітру: ' + formatErrorMessage(createError) });
    } finally {
      setCreateInFlight(false);
    }
  }

  async function handleEditSave() {
    if (!editForm || editPalitraId === null || editInFlight) return;

    const normalizedForm = applyRestrictedAccess(editForm, user, myScope, allLogins);
    if (!isFormValid(normalizedForm)) return;

    setEditInFlight(true);
    setStatus(null);

    try {
      const details = await updatePalitra(editPalitraId, toCreateReq(normalizedForm));
      setPalitras((prev) => prev.map((palitra) => (palitra.id === editPalitraId ? details.palitra : palitra)));
      closeEdit();
    } catch (updateError) {
      if (isUnauthorizedError(updateError)) {
        window.location.assign('/login');
        return;
      }

      setStatus({ kind: 'error', text: 'Не вдалося оновити палітру: ' + formatErrorMessage(updateError) });
    } finally {
      setEditInFlight(false);
    }
  }

  function openAssignFolderDialog(targetPalitraIds: number[], emptySelectionMessage: string, blockedSelectionMessage: string) {
    const preview = buildAssignFolderPreview(palitraRows, targetPalitraIds, '');
    if (preview.requestedCount === 0) {
      setStatus({ kind: 'warning', text: emptySelectionMessage });
      return;
    }

    if (preview.modifiableCount === 0) {
      setStatus({ kind: 'warning', text: blockedSelectionMessage });
      return;
    }

    setFolderDialogState({
      kind: 'assign',
      folderPath: '',
      nextFolderPath: '',
      targetPalitraIds: preview.modifiableIds,
      preview,
    });
  }

  function requestAssignFolder() {
    if (folderActionsBlocked || bulkDeleteInFlight || inFlightArchiveId !== null || inFlightDeleteId !== null) return;

    openAssignFolderDialog(
      selectedPalitraIds,
      'Оберіть хоча б одну палітру для переміщення.',
      'Серед вибраних палітр немає доступних для переміщення.',
    );
  }

  function requestAssignFolderForPalitra(palitra: Palitra) {
    if (folderActionsBlocked || bulkDeleteInFlight || inFlightArchiveId !== null || inFlightDeleteId !== null) return;

    openAssignFolderDialog([palitra.id], 'Не вдалося знайти палітру для переміщення.', 'Цю палітру зараз не можна перемістити.');
  }

  function requestRenameFolder(path: string) {
    if (folderActionsBlocked || bulkDeleteInFlight || inFlightArchiveId !== null || inFlightDeleteId !== null) return;
    const node = getFolderNodeByPath(folderTree, path);
    if (!node) return;

    const preview = buildFolderSubtreePreview(node);
    if (preview.requestedCount === 0) {
      setStatus({ kind: 'warning', text: 'У цій папці немає палітр для перейменування.' });
      return;
    }

    setFolderDialogState({
      kind: 'rename',
      folderPath: node.path,
      nextFolderPath: node.path,
      targetPalitraIds: preview.modifiableIds,
      preview,
    });
  }

  function requestArchiveFolder(path: string) {
    if (folderActionsBlocked || bulkDeleteInFlight || inFlightArchiveId !== null || inFlightDeleteId !== null) return;
    const node = getFolderNodeByPath(folderTree, path);
    if (!node) return;

    const preview = buildFolderSubtreePreview(node);
    if (preview.requestedCount === 0) {
      setStatus({ kind: 'warning', text: 'У цій папці немає палітр для архівації.' });
      return;
    }

    setFolderDialogState({
      kind: 'archive',
      folderPath: node.path,
      nextFolderPath: node.path,
      targetPalitraIds: preview.modifiableIds,
      preview,
    });
  }

  function requestDeleteFolder(path: string) {
    if (folderActionsBlocked || bulkDeleteInFlight || inFlightArchiveId !== null || inFlightDeleteId !== null) return;
    const node = getFolderNodeByPath(folderTree, path);
    if (!node) return;

    const preview = buildFolderSubtreePreview(node);
    if (preview.requestedCount === 0) {
      setStatus({ kind: 'warning', text: 'У цій папці немає палітр для видалення.' });
      return;
    }

    setFolderDialogState({
      kind: 'delete',
      folderPath: node.path,
      nextFolderPath: node.path,
      targetPalitraIds: preview.modifiableIds,
      preview,
    });
  }

  function cancelFolderAction() {
    if (folderActionInFlight) return;
    setFolderDialogState(null);
  }

  function setFolderDialogNextFolderPath(nextFolderPath: string) {
    setFolderDialogState((prev) => {
      if (!prev) return prev;
      if (prev.kind === 'assign') {
        const preview = buildAssignFolderPreview(palitraRows, prev.preview.requestedIds, nextFolderPath);
        return {
          ...prev,
          nextFolderPath,
          targetPalitraIds: preview.modifiableIds,
          preview,
        };
      }

      return {
        ...prev,
        nextFolderPath,
      };
    });
  }

  function toggleFolderExpanded(path: string) {
    setExpandedFolderPaths((prev) => (prev.includes(path) ? prev.filter((item) => item !== path) : [...prev, path]));
  }

  async function handleAssignFolderConfirm(state: FolderActionDialogState) {
    const nextFolderPath = state.nextFolderPath.trim();
    if (nextFolderPath === '') {
      setStatus({ kind: 'warning', text: 'Вкажіть назву папки для переміщення.' });
      return;
    }

    const folderPathError = validateFolderPath(nextFolderPath);
    if (folderPathError) {
      setStatus({ kind: 'warning', text: folderPathError });
      return;
    }

    const changedIds = await assignPalitraFolder(state.targetPalitraIds, nextFolderPath);
    setPalitraFolderLocally(changedIds, nextFolderPath);
    setExpandedFolderPaths((prev) => {
      const normalizedFolderPath = normalizeFolderPathForUi(nextFolderPath);
      if (normalizedFolderPath === '' || prev.includes(normalizedFolderPath)) return prev;
      return [...prev, normalizedFolderPath];
    });
    setFolderDialogState(null);
    setStatus(buildFolderActionStatus(state, changedIds));
  }

  async function handleRenameFolderConfirm(state: FolderActionDialogState) {
    const nextFolderPath = state.nextFolderPath.trim();
    if (nextFolderPath === '') {
      setStatus({ kind: 'warning', text: 'Вкажіть нову назву папки.' });
      return;
    }

    const folderPathError = validateFolderPath(nextFolderPath);
    if (folderPathError) {
      setStatus({ kind: 'warning', text: folderPathError });
      return;
    }

    if (nextFolderPath === state.folderPath) {
      setStatus({ kind: 'warning', text: 'Нова назва папки збігається з поточною.' });
      return;
    }

    const changedIds = await renamePalitraFolder(state.folderPath, nextFolderPath);
    renameFolderLocally(changedIds, state.folderPath, nextFolderPath);
    setExpandedFolderPaths((prev) => {
      const normalizedFromPath = normalizeFolderPathForUi(state.folderPath);
      const normalizedNextPath = normalizeFolderPathForUi(nextFolderPath);
      const fromPrefix = normalizedFromPath + '/';

      return [...new Set(
        prev.map((item) => {
          if (item === normalizedFromPath) return normalizedNextPath;
          if (item.startsWith(fromPrefix)) return normalizedNextPath + item.slice(normalizedFromPath.length);
          return item;
        }),
      )];
    });
    setFolderDialogState(null);
    setStatus(buildFolderActionStatus(state, changedIds));
  }

  async function handleArchiveFolderConfirm(state: FolderActionDialogState) {
    const changedIds = await archivePalitraFolder(state.folderPath);
    archiveFolderLocally(changedIds);
    setFolderDialogState(null);
    setStatus(buildFolderActionStatus(state, changedIds));
  }

  async function handleDeleteFolderConfirm(state: FolderActionDialogState) {
    const changedIds = await deletePalitraFolder(state.folderPath);
    deleteFolderLocally(changedIds);
    setExpandedFolderPaths((prev) => {
      const normalizedFolderPath = normalizeFolderPathForUi(state.folderPath);
      const folderPrefix = normalizedFolderPath + '/';
      return prev.filter((item) => item !== normalizedFolderPath && !item.startsWith(folderPrefix));
    });
    setFolderDialogState(null);
    setStatus(buildFolderActionStatus(state, changedIds));
  }

  async function confirmFolderAction() {
    const state = folderDialogState;
    if (!state || folderActionInFlight) return;

    setFolderActionInFlight(true);
    setStatus(null);

    try {
      if (state.kind === 'assign') {
        await handleAssignFolderConfirm(state);
      } else if (state.kind === 'rename') {
        await handleRenameFolderConfirm(state);
      } else if (state.kind === 'archive') {
        await handleArchiveFolderConfirm(state);
      } else {
        await handleDeleteFolderConfirm(state);
      }
    } catch (folderError) {
      if (isUnauthorizedError(folderError)) {
        window.location.assign('/login');
        return;
      }

      setStatus({ kind: 'error', text: 'Не вдалося виконати операцію з папкою: ' + formatErrorMessage(folderError) });
    } finally {
      setFolderActionInFlight(false);
    }
  }

  return {
    user,
    myScope,
    organisms,
    aors,
    allLogins,
    status,
    archiveView,
    setArchiveView,
    loading,
    rows,
    palitras,
    folderOptions,
    folderDialogState,
    folderActionInFlight,
    folderActionsBlocked,
    inFlightArchiveId,
    inFlightDeleteId,
    inFlightDownloadId,
    inFlightUploadId,
    archiveDialogPalitra,
    archiveDialogOpen,
    deleteDialogPalitra,
    deleteDialogOpen,
    selectedPalitraIds,
    setSelectedPalitraIds,
    bulkDeleteDialogPalitras,
    bulkDeleteDialogOpen,
    bulkDeleteInFlight,
    createOpen,
    createMode,
    createForm,
    createInFlight,
    referenceDataReady,
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
    requestArchive,
    cancelArchive,
    confirmArchive,
    onArchiveDialogExited,
    handleUnarchive,
    requestUploadPoints,
    handleDownload,
    requestDelete,
    cancelDelete,
    confirmDelete,
    onDeleteDialogExited,
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
    requestAssignFolder,
    requestAssignFolderForPalitra,
    requestRenameFolder,
    requestArchiveFolder,
    requestDeleteFolder,
    cancelFolderAction,
    confirmFolderAction,
    setFolderDialogNextFolderPath,
    toggleFolderExpanded,
  };
}
