import type { ChangeEvent, Dispatch, MutableRefObject, SetStateAction } from 'react';

import type { AnalyzeKmzResponse, MyScope, Palitra, User } from '../../../../Bindings';
import {
  analyzePalitraKmz,
  archivePalitra,
  createPalitraBasicWithKmz,
  createPalitraWithKmz,
  deletePalitra,
  downloadPalitras,
  retryPalitraConversion,
  retryGoiSourceConversion,
  unarchivePalitra,
  updatePalitra,
  uploadPalitraPoints,
} from '../../services/api/palitra';
import { downloadBlob } from '../../utils/download-blob';
import {
  applyRestrictedAccess,
  buildPalitraNameWithSuffix,
  DEFAULT_COLOR_HEX,
  formatErrorMessage,
  getInitialCreateForm,
  getSelectedDownloadablePalitras,
  getSelectedModifiablePalitras,
  isFormValid,
  kmzColorOptionsFromAnalysis,
  palitraToForm,
  toCreateReq,
} from './helpers';
import type {
  KmzColorOption,
  PalitraCreateMode,
  PalitraFormState,
  PalitraRowView,
  UiStatus,
} from './types';

type SetState<T> = Dispatch<SetStateAction<T>>;
type Props = {
  user: User | null;
  myScope: MyScope | null;
  allLogins: string[];
  palitraRows: PalitraRowView[];
  selectedPalitraIds: number[];
  folderActionsBlocked: boolean;
  createOpen: boolean;
  createInFlight: boolean;
  createForm: PalitraFormState;
  editPalitraId: number | null;
  editForm: PalitraFormState | null;
  editInFlight: boolean;
  kmzFile: File | null;
  kmzColorOptions: KmzColorOption[];
  selectedColorFromKmz: string;
  archiveDialogPalitra: Palitra | null;
  archiveDialogOpen: boolean;
  downloadDialogPalitra: Palitra | null;
  downloadDialogOpen: boolean;
  downloadSplitForDelta: boolean;
  deleteDialogPalitra: Palitra | null;
  deleteDialogOpen: boolean;
  bulkDeleteDialogPalitras: Palitra[];
  bulkDeleteDialogOpen: boolean;
  bulkDeleteInFlight: boolean;
  bulkDownloadInFlight: boolean;
  inFlightArchiveId: number | null;
  inFlightDeleteId: number | null;
  inFlightDownloadId: number | null;
  inFlightRetryId: number | null;
  uploadPointsInputRef: MutableRefObject<HTMLInputElement | null>;
  uploadKmzInputRef: MutableRefObject<HTMLInputElement | null>;
  pendingUploadPalitraIdRef: MutableRefObject<number | null>;
  createCloseClearErrorRef: MutableRefObject<boolean>;
  setStatus: SetState<UiStatus>;
  setCreateMode: SetState<PalitraCreateMode>;
  setCreateOpen: SetState<boolean>;
  setCreateForm: SetState<PalitraFormState>;
  setCreateInFlight: SetState<boolean>;
  setKmzFile: SetState<File | null>;
  setKmzAnalysis: SetState<AnalyzeKmzResponse | null>;
  setKmzAnalyzing: SetState<boolean>;
  setKmzColorOptions: SetState<KmzColorOption[]>;
  setSelectedColorFromKmz: SetState<string>;
  setEditPalitraId: SetState<number | null>;
  setEditForm: SetState<PalitraFormState | null>;
  setEditInFlight: SetState<boolean>;
  setPalitras: SetState<Palitra[]>;
  setSelectedPalitraIds: SetState<number[]>;
  setInFlightArchiveId: SetState<number | null>;
  setInFlightDeleteId: SetState<number | null>;
  setInFlightDownloadId: SetState<number | null>;
  setInFlightUploadId: SetState<number | null>;
  setInFlightRetryId: SetState<number | null>;
  setArchiveDialogPalitra: SetState<Palitra | null>;
  setArchiveDialogOpen: SetState<boolean>;
  setDownloadDialogPalitra: SetState<Palitra | null>;
  setDownloadDialogOpen: SetState<boolean>;
  setDownloadSplitForDelta: SetState<boolean>;
  setDeleteDialogPalitra: SetState<Palitra | null>;
  setDeleteDialogOpen: SetState<boolean>;
  setBulkDeleteDialogPalitras: SetState<Palitra[]>;
  setBulkDeleteDialogOpen: SetState<boolean>;
  setBulkDeleteInFlight: SetState<boolean>;
  setBulkDownloadInFlight: SetState<boolean>;
  reloadPalitras: () => Promise<void>;
};

export function createPalitraPageActionHandlers(props: Props) {
  function clearCreateFlow(clearError: boolean) {
    if (clearError) props.setStatus(null);
    props.setCreateMode('basic');
    props.setCreateForm(getInitialCreateForm(props.user, props.myScope));
    props.setCreateInFlight(false);
    props.setKmzFile(null);
    props.setKmzAnalysis(null);
    props.setKmzAnalyzing(false);
    props.setKmzColorOptions([]);
    props.setSelectedColorFromKmz(DEFAULT_COLOR_HEX);
  }

  function resetCreateFlow(clearError = true) {
    props.createCloseClearErrorRef.current = clearError;
    props.setCreateOpen(false);
  }

  function openCreate() {
    if (props.createInFlight || props.folderActionsBlocked) return;
    props.setStatus(null);
    clearCreateFlow(false);
    props.setCreateOpen(true);
  }

  function onCreateDrawerExited() {
    if (props.createOpen) return;
    clearCreateFlow(props.createCloseClearErrorRef.current);
  }

  function openEdit(palitra: Palitra) {
    if (props.folderActionsBlocked) return;
    if (palitra.goiOwned) {
      props.setStatus({ kind: 'warning', text: 'Редагуйте цю палітру в ГОІ.' });
      return;
    }
    props.setEditPalitraId(palitra.id);
    props.setEditForm(
      applyRestrictedAccess(palitraToForm(palitra), props.user, props.myScope, props.allLogins),
    );
  }

  function replacePalitra(nextPalitra: Palitra) {
    props.setPalitras((prev) =>
      prev.map((palitra) => (palitra.id === nextPalitra.id ? nextPalitra : palitra)),
    );
  }

  function closeEdit() {
    props.setEditPalitraId(null);
    props.setEditForm(null);
    props.setEditInFlight(false);
  }

  function requestArchive(palitra: Palitra) {
    if (
      props.archiveDialogOpen ||
      props.inFlightArchiveId !== null ||
      props.inFlightDeleteId !== null ||
      props.bulkDeleteInFlight ||
      props.folderActionsBlocked
    )
      return;
    props.setArchiveDialogPalitra(palitra);
    props.setArchiveDialogOpen(true);
  }

  function cancelArchive() {
    if (
      props.inFlightArchiveId !== null ||
      props.inFlightDeleteId !== null ||
      props.bulkDeleteInFlight
    )
      return;
    props.setArchiveDialogOpen(false);
  }

  async function confirmArchive() {
    const palitra = props.archiveDialogPalitra;
    if (
      !palitra ||
      props.inFlightArchiveId !== null ||
      props.inFlightDeleteId !== null ||
      props.bulkDeleteInFlight ||
      props.folderActionsBlocked
    )
      return;

    props.setInFlightArchiveId(palitra.id);
    props.setStatus(null);

    try {
      const updatedPalitra = await archivePalitra(palitra.id);
      replacePalitra(updatedPalitra);
      props.setArchiveDialogOpen(false);
    } catch (archiveError) {
      props.setStatus({
        kind: 'error',
        text: 'Не вдалося перенести палітру в архів: ' + formatErrorMessage(archiveError),
      });
    } finally {
      props.setInFlightArchiveId(null);
    }
  }

  function onArchiveDialogExited() {
    if (props.archiveDialogOpen || props.inFlightArchiveId !== null) return;
    props.setArchiveDialogPalitra(null);
  }

  async function handleUnarchive(palitra: Palitra) {
    if (
      props.inFlightArchiveId !== null ||
      props.inFlightDeleteId !== null ||
      props.bulkDeleteInFlight ||
      props.folderActionsBlocked
    )
      return;

    props.setInFlightArchiveId(palitra.id);
    props.setStatus(null);

    try {
      const updatedPalitra = await unarchivePalitra(palitra.id);
      replacePalitra(updatedPalitra);
    } catch (archiveError) {
      props.setStatus({
        kind: 'error',
        text: 'Не вдалося повернути палітру з архіву: ' + formatErrorMessage(archiveError),
      });
    } finally {
      props.setInFlightArchiveId(null);
    }
  }

  function requestDelete(palitra: Palitra) {
    if (
      props.inFlightArchiveId !== null ||
      props.inFlightDeleteId !== null ||
      props.bulkDeleteInFlight ||
      props.bulkDeleteDialogOpen ||
      props.folderActionsBlocked
    )
      return;
    props.setDeleteDialogPalitra(palitra);
    props.setDeleteDialogOpen(true);
  }

  function cancelDelete() {
    if (
      props.inFlightArchiveId !== null ||
      props.inFlightDeleteId !== null ||
      props.bulkDeleteInFlight
    )
      return;
    props.setDeleteDialogOpen(false);
  }

  async function confirmDelete() {
    const palitra = props.deleteDialogPalitra;
    if (
      !palitra ||
      props.inFlightArchiveId !== null ||
      props.inFlightDeleteId !== null ||
      props.bulkDeleteInFlight ||
      props.folderActionsBlocked
    )
      return;

    props.setInFlightDeleteId(palitra.id);
    props.setStatus(null);

    try {
      await deletePalitra(palitra.id);
      props.setPalitras((prev) => prev.filter((item) => item.id !== palitra.id));
      props.setSelectedPalitraIds((prev) => prev.filter((id) => id !== palitra.id));
      props.setDeleteDialogOpen(false);
    } catch (deleteError) {
      props.setStatus({
        kind: 'error',
        text: 'Не вдалося видалити палітру: ' + formatErrorMessage(deleteError),
      });
    } finally {
      props.setInFlightDeleteId(null);
    }
  }

  function onDeleteDialogExited() {
    if (props.deleteDialogOpen || props.inFlightDeleteId !== null) return;
    props.setDeleteDialogPalitra(null);
  }

  function requestBulkDelete() {
    if (
      props.archiveDialogOpen ||
      props.bulkDeleteInFlight ||
      props.bulkDownloadInFlight ||
      props.inFlightArchiveId !== null ||
      props.inFlightDeleteId !== null ||
      props.deleteDialogOpen ||
      props.folderActionsBlocked
    )
      return;

    const selected = getSelectedModifiablePalitras(props.palitraRows, props.selectedPalitraIds);
    if (selected.length === 0) return;

    props.setBulkDeleteDialogPalitras(selected);
    props.setBulkDeleteDialogOpen(true);
  }

  function cancelBulkDelete() {
    if (
      props.bulkDeleteInFlight ||
      props.bulkDownloadInFlight ||
      props.inFlightArchiveId !== null ||
      props.inFlightDeleteId !== null
    )
      return;
    props.setBulkDeleteDialogOpen(false);
  }

  async function confirmBulkDelete() {
    if (
      props.bulkDeleteInFlight ||
      props.bulkDownloadInFlight ||
      props.inFlightArchiveId !== null ||
      props.inFlightDeleteId !== null ||
      props.folderActionsBlocked
    )
      return;

    const palitrasToDelete = [...props.bulkDeleteDialogPalitras];
    if (palitrasToDelete.length === 0) return;

    props.setBulkDeleteDialogOpen(false);
    props.setBulkDeleteInFlight(true);
    props.setStatus(null);

    const failed: string[] = [];

    try {
      for (const palitra of palitrasToDelete) {
        props.setInFlightDeleteId(palitra.id);

        try {
          await deletePalitra(palitra.id);
          props.setPalitras((prev) => prev.filter((item) => item.id !== palitra.id));
          props.setSelectedPalitraIds((prev) => prev.filter((id) => id !== palitra.id));
        } catch (deleteError) {
          failed.push(palitra.name + ': ' + formatErrorMessage(deleteError));
        } finally {
          props.setInFlightDeleteId(null);
        }
      }

      if (failed.length > 0) {
        props.setStatus({ kind: 'error', text: 'Не вдалося видалити деякі палітри: ' + failed[0] });
      }
    } finally {
      props.setBulkDeleteInFlight(false);
      props.setBulkDeleteDialogPalitras([]);
    }
  }

  function onBulkDeleteDialogExited() {
    if (props.bulkDeleteDialogOpen || props.bulkDeleteInFlight) return;
    props.setBulkDeleteDialogPalitras([]);
  }

  function requestUploadPoints(palitraId: number) {
    if (props.folderActionsBlocked || !props.uploadPointsInputRef.current) return;
    props.pendingUploadPalitraIdRef.current = palitraId;
    props.uploadPointsInputRef.current.value = '';
    props.uploadPointsInputRef.current.click();
  }

  function handleDownload(palitra: Palitra) {
    if (
      props.inFlightDownloadId !== null ||
      props.bulkDownloadInFlight ||
      props.downloadDialogOpen ||
      props.folderActionsBlocked
    )
      return;
    props.setStatus(null);
    props.setDownloadDialogPalitra(palitra);
    props.setDownloadSplitForDelta(false);
    props.setDownloadDialogOpen(true);
  }

  async function handleBulkDownload() {
    if (
      props.bulkDownloadInFlight ||
      props.inFlightDownloadId !== null ||
      props.bulkDeleteInFlight ||
      props.inFlightArchiveId !== null ||
      props.inFlightDeleteId !== null ||
      props.folderActionsBlocked
    )
      return;

    const selected = getSelectedDownloadablePalitras(props.palitraRows, props.selectedPalitraIds);
    if (selected.length === 0) return;

    props.setBulkDownloadInFlight(true);
    props.setStatus(null);

    try {
      const blob = await downloadPalitras(selected.map((palitra) => palitra.id));
      downloadBlob(blob, 'palitras-selected.zip');
    } catch (downloadError) {
      props.setStatus({
        kind: 'error',
        text: 'Не вдалося завантажити обрані палітри: ' + formatErrorMessage(downloadError),
      });
    } finally {
      props.setBulkDownloadInFlight(false);
    }
  }

  function cancelDownload() {
    if (props.inFlightDownloadId !== null) return;
    props.setDownloadDialogOpen(false);
  }

  async function confirmDownload() {
    const palitra = props.downloadDialogPalitra;
    if (!palitra || props.inFlightDownloadId !== null || props.folderActionsBlocked) return;

    props.setInFlightDownloadId(palitra.id);
    props.setStatus(null);

    try {
      const blob = await downloadPalitras([palitra.id], {
        splitForDelta: props.downloadSplitForDelta,
      });
      downloadBlob(
        blob,
        'palitra-' + String(palitra.id) + (props.downloadSplitForDelta ? '-delta' : '') + '.zip',
      );
      props.setDownloadDialogOpen(false);
    } catch (downloadError) {
      props.setDownloadDialogOpen(false);
      props.setStatus({
        kind: 'error',
        text: 'Не вдалося завантажити палітру: ' + formatErrorMessage(downloadError),
      });
    } finally {
      props.setInFlightDownloadId(null);
    }
  }

  function onDownloadDialogExited() {
    if (props.downloadDialogOpen || props.inFlightDownloadId !== null) return;
    props.setDownloadDialogPalitra(null);
    props.setDownloadSplitForDelta(false);
  }

  async function handleUploadPointsSelected(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    const palitraId = props.pendingUploadPalitraIdRef.current;
    if (!file || palitraId === null) return;

    props.setInFlightUploadId(palitraId);
    props.setStatus(null);

    try {
      await uploadPalitraPoints(palitraId, file);
      await props.reloadPalitras();
    } catch (uploadError) {
      props.setStatus({
        kind: 'error',
        text: 'Не вдалося завантажити точки: ' + formatErrorMessage(uploadError),
      });
    } finally {
      props.setInFlightUploadId(null);
      props.pendingUploadPalitraIdRef.current = null;
    }
  }

  async function handleRetryConversion(palitra: Palitra) {
    if (
      props.inFlightRetryId !== null ||
      props.folderActionsBlocked ||
      palitra.conversionStatus !== 'error'
    )
      return;

    props.setInFlightRetryId(palitra.id);
    props.setStatus(null);

    try {
      const updatedPalitra = await retryPalitraConversion(palitra.id);
      replacePalitra(updatedPalitra);
      props.setStatus({ kind: 'success', text: 'Конвертацію палітри поставлено в чергу.' });
    } catch (retryError) {
      props.setStatus({
        kind: 'error',
        text: 'Не вдалося повторити конвертацію: ' + formatErrorMessage(retryError),
      });
    } finally {
      props.setInFlightRetryId(null);
    }
  }

  async function handleRetryGoiSourceConversion(palitra: Palitra) {
    if (
      props.inFlightRetryId !== null ||
      props.folderActionsBlocked ||
      !palitra.goiSourceRefreshRetryAvailable
    )
      return;

    props.setInFlightRetryId(palitra.id);
    props.setStatus(null);

    try {
      const updatedPalitra = await retryGoiSourceConversion(palitra.id);
      replacePalitra(updatedPalitra);
      props.setStatus({ kind: 'success', text: 'Оновлення з ГОІ поставлено в чергу.' });
    } catch (retryError) {
      props.setStatus({
        kind: 'error',
        text: 'Не вдалося повторити оновлення з ГОІ: ' + formatErrorMessage(retryError),
      });
    } finally {
      props.setInFlightRetryId(null);
    }
  }

  function requestAnalyzeKmz() {
    if (!props.uploadKmzInputRef.current) return;
    props.uploadKmzInputRef.current.value = '';
    props.uploadKmzInputRef.current.click();
  }

  async function handleKmzSelected(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    props.setKmzFile(file);
    props.setKmzAnalyzing(true);
    props.setKmzAnalysis(null);
    props.setKmzColorOptions([]);
    props.setSelectedColorFromKmz(DEFAULT_COLOR_HEX);
    props.setStatus(null);

    try {
      const analysis = await analyzePalitraKmz(file);
      const colorOptions = kmzColorOptionsFromAnalysis(analysis);
      const firstColor = colorOptions[0]?.colorHex ?? DEFAULT_COLOR_HEX;

      props.setKmzAnalysis(analysis);
      props.setKmzColorOptions(colorOptions);
      props.setSelectedColorFromKmz(firstColor);
      props.setCreateForm((prev) => ({
        ...prev,
        colorHex: firstColor,
        name: analysis.filename || prev.name,
      }));
    } catch (analysisError) {
      props.setStatus({
        kind: 'error',
        text: 'Не вдалося проаналізувати файл: ' + formatErrorMessage(analysisError),
      });
    } finally {
      props.setKmzAnalyzing(false);
    }
  }

  async function handleCreate(mode: PalitraCreateMode) {
    if (!props.kmzFile || props.createInFlight) return;

    const normalizedForm = applyRestrictedAccess(
      props.createForm,
      props.user,
      props.myScope,
      props.allLogins,
    );
    if (!isFormValid(normalizedForm)) return;

    props.setCreateInFlight(true);
    props.setStatus(null);

    try {
      if (mode === 'advanced' && props.kmzColorOptions.length > 0) {
        const selectedOptions = props.kmzColorOptions.filter((option) => option.selected);
        if (selectedOptions.length === 0) {
          props.setStatus({ kind: 'error', text: 'Оберіть хоча б один колір з KMZ.' });
          return;
        }

        const results = await Promise.allSettled(
          selectedOptions.map((option) => {
            const req = toCreateReq({
              ...normalizedForm,
              colorHex: option.colorHex,
              name: buildPalitraNameWithSuffix(normalizedForm.name, option.suffix),
            });
            return createPalitraWithKmz(req, props.kmzFile!);
          }),
        );

        const created = results
          .filter(
            (result): result is PromiseFulfilledResult<Palitra> => result.status === 'fulfilled',
          )
          .map((result) => result.value);
        const rejected = results.filter(
          (result): result is PromiseRejectedResult => result.status === 'rejected',
        );
        const firstError = rejected[0];
        if (firstError) {
          props.setStatus({
            kind: 'error',
            text: 'Помилка створення палітри: ' + formatErrorMessage(firstError.reason),
          });
        }

        if (created.length > 0) {
          props.setPalitras((prev) => [...created, ...prev]);
          resetCreateFlow(!firstError);
        }

        return;
      }

      const createdPalitra = await createPalitraBasicWithKmz(
        toCreateReq({
          ...normalizedForm,
          colorHex: props.selectedColorFromKmz,
        }),
        props.kmzFile,
      );
      props.setPalitras((prev) => [createdPalitra, ...prev]);
      resetCreateFlow();
    } catch (createError) {
      props.setStatus({
        kind: 'error',
        text: 'Не вдалося створити палітру: ' + formatErrorMessage(createError),
      });
    } finally {
      props.setCreateInFlight(false);
    }
  }

  async function handleEditSave() {
    if (!props.editForm || props.editPalitraId === null || props.editInFlight) return;

    const normalizedForm = applyRestrictedAccess(
      props.editForm,
      props.user,
      props.myScope,
      props.allLogins,
    );
    if (!isFormValid(normalizedForm)) return;

    props.setEditInFlight(true);
    props.setStatus(null);

    try {
      const details = await updatePalitra(props.editPalitraId, toCreateReq(normalizedForm));
      props.setPalitras((prev) =>
        prev.map((palitra) => (palitra.id === props.editPalitraId ? details.palitra : palitra)),
      );
      closeEdit();
    } catch (updateError) {
      props.setStatus({
        kind: 'error',
        text: 'Не вдалося оновити палітру: ' + formatErrorMessage(updateError),
      });
    } finally {
      props.setEditInFlight(false);
    }
  }

  return {
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
    handleBulkDownload,
    cancelDownload,
    confirmDownload,
    onDownloadDialogExited,
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
    handleRetryConversion,
    handleRetryGoiSourceConversion,
  };
}
