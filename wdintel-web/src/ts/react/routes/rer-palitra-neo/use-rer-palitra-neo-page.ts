import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { AnalyzeKmzResponse, AreaOfResponsibility, MyScope, Organism, Palitra, User } from '../../../../Bindings';
import { isUnauthorizedError } from '../../services/api/client';
import {
  archivePalitraFolder,
  assignPalitraFolder,
  deletePalitraFolder,
  fetchPalitraReferenceData,
  listPalitras,
  renamePalitraFolder,
} from '../../services/api/palitra';
import { fetchCurrentUser } from '../../services/api/user';
import {
  buildFolderTree,
  buildTableRows,
  DEFAULT_COLOR_HEX,
  formatErrorMessage,
  normalizeFolderPathForUi,
  getAvailableAccessTypes,
  getExistingFolderOptions,
  getInitialCreateForm,
} from './helpers';
import type { FolderActionDialogState, KmzColorOption, PalitraCreateMode, PalitraFormState, TableRowView, UiStatus } from './types';
import { createPalitraFolderActionHandlers } from './use-rer-palitra-neo-page.folder-actions';
import { createPalitraPageActionHandlers } from './use-rer-palitra-neo-page.palitra-actions';
import { ArchiveView, buildFolderActionStatus, readInitialArchiveViewFromUrl, updateArchiveViewInUrl } from './use-rer-palitra-neo-page.shared';

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
  const folderTree = useMemo(() => buildFolderTree(visiblePalitras, user), [visiblePalitras, user]);
  const folderOptions = useMemo(() => getExistingFolderOptions(folderTree), [folderTree]);
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
    updateArchiveViewInUrl(archiveView);
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

  const {
    openCreate,
    resetCreateFlow,
    onCreateDrawerExited,
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
    handleCreate,
    handleEditSave,
    handleUploadPointsSelected,
    handleKmzSelected,
  } = createPalitraPageActionHandlers({
    user,
    myScope,
    allLogins,
    palitraRows,
    selectedPalitraIds,
    folderActionsBlocked,
    createOpen,
    createInFlight,
    createForm,
    editPalitraId,
    editForm,
    editInFlight,
    kmzFile,
    kmzColorOptions,
    selectedColorFromKmz,
    archiveDialogPalitra,
    archiveDialogOpen,
    deleteDialogPalitra,
    deleteDialogOpen,
    bulkDeleteDialogPalitras,
    bulkDeleteDialogOpen,
    bulkDeleteInFlight,
    inFlightArchiveId,
    inFlightDeleteId,
    inFlightDownloadId,
    uploadPointsInputRef,
    uploadKmzInputRef,
    pendingUploadPalitraIdRef,
    createCloseClearErrorRef,
    setStatus,
    setCreateMode,
    setCreateOpen,
    setCreateForm,
    setCreateInFlight,
    setKmzFile,
    setKmzAnalysis,
    setKmzAnalyzing,
    setKmzColorOptions,
    setSelectedColorFromKmz,
    setEditPalitraId,
    setEditForm,
    setEditInFlight,
    setPalitras,
    setSelectedPalitraIds,
    setInFlightArchiveId,
    setInFlightDeleteId,
    setInFlightDownloadId,
    setInFlightUploadId,
    setArchiveDialogPalitra,
    setArchiveDialogOpen,
    setDeleteDialogPalitra,
    setDeleteDialogOpen,
    setBulkDeleteDialogPalitras,
    setBulkDeleteDialogOpen,
    setBulkDeleteInFlight,
    reloadPalitras,
  });

  const {
    requestAssignFolder,
    requestAssignFolderForPalitra,
    requestRenameFolder,
    requestArchiveFolder,
    requestDeleteFolder,
    cancelFolderAction,
    confirmFolderAction,
    setFolderDialogNextFolderPath,
    toggleFolderExpanded,
  } = createPalitraFolderActionHandlers({
    selectedPalitraIds,
    palitraRows,
    folderTree,
    folderDialogState,
    folderActionInFlight,
    folderActionsBlocked,
    bulkDeleteInFlight,
    inFlightArchiveId,
    inFlightDeleteId,
    setStatus,
    setFolderDialogState,
    setFolderActionInFlight,
    setExpandedFolderPaths,
    setSelectedPalitraIds,
    setPalitraFolderLocally,
    renameFolderLocally,
    archiveFolderLocally,
    deleteFolderLocally,
    buildFolderActionStatus,
  });

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
