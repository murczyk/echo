import { Stack } from '@mui/material';
import { useCallback, useEffect, useState } from 'react';

import type { UnitAttachment } from '../../../../Bindings';
import { ConfirmDangerDialog } from '../../components/ConfirmDangerDialog';
import { PowerAlert } from '../../components/PowerAlert';
import { TableStateProvider } from '../../components/mui-customized/table/table-state-provider';
import {
  deleteUnitAttachment,
  downloadUnitAttachment,
  getUnitDetails,
} from '../../services/api/units';
import { downloadBlob } from '../../utils/download-blob';
import { UnitAttachmentEditCard } from './UnitAttachmentEditCard';
import { UnitAttachmentUploader } from './UnitAttachmentUploader';
import { UnitAttachmentsTable } from './UnitAttachmentsTable';

const DEFAULT_COLUMN_ORDER = [
  'mrt-row-actions',
  'fileName',
  'shortDescription',
  'fullDescription',
  'aors',
  'createdAt',
];
const DEFAULT_COLUMN_VISIBILITY = {
  fileName: true,
  shortDescription: true,
  fullDescription: true,
  aors: true,
  createdAt: true,
};

function formatError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return 'Невідома помилка';
}

function attachmentFileName(attachment: UnitAttachment): string {
  return attachment.fileName.trim() || `attachment-${attachment.id}`;
}

function UnitAttachmentsAdminBody({
  unitId,
  onChanged,
}: {
  unitId: number;
  onChanged: (uploadedCount: number) => void;
}) {
  const [attachments, setAttachments] = useState<UnitAttachment[]>([]);
  const [reloadVersion, setReloadVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [editing, setEditing] = useState<UnitAttachment | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<UnitAttachment | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError(null);
    void getUnitDetails(unitId)
      .then((details) => {
        if (!active) return;
        setAttachments(details.attachments);
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setLoadError(formatError(error));
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [reloadVersion, unitId]);

  const download = useCallback(async (attachment: UnitAttachment) => {
    setDownloadingId(attachment.id);
    setActionError(null);
    try {
      const blob = await downloadUnitAttachment(attachment.id);
      downloadBlob(blob, attachmentFileName(attachment));
    } catch (error) {
      setActionError(`Не вдалося завантажити файл: ${formatError(error)}`);
    } finally {
      setDownloadingId(null);
    }
  }, []);

  function uploaded(count: number) {
    setReloadVersion((version) => version + 1);
    onChanged(count);
  }

  function saved(updated: UnitAttachment) {
    setAttachments((current) =>
      current.map((attachment) => (attachment.id === updated.id ? updated : attachment)),
    );
    setEditing(null);
    setActionError(null);
    onChanged(0);
  }

  async function confirmDelete() {
    if (deleteTarget === null) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const deletedId = await deleteUnitAttachment(deleteTarget.id);
      setAttachments((current) => current.filter(({ id }) => id !== deletedId));
      setDeleteTarget(null);
      setActionError(null);
      onChanged(0);
    } catch (error) {
      setDeleteError(formatError(error));
    } finally {
      setDeleting(false);
    }
  }

  if (editing !== null) {
    return (
      <UnitAttachmentEditCard
        key={editing.id}
        attachment={editing}
        onCancel={() => setEditing(null)}
        onSaved={saved}
      />
    );
  }

  return (
    <Stack spacing={2}>
      <UnitAttachmentUploader unitId={unitId} onUploaded={uploaded} />

      {loadError ? (
        <PowerAlert severity="error" autoHideDuration={null}>
          Не вдалося завантажити таблицю файлів: {loadError}
        </PowerAlert>
      ) : null}
      {actionError ? (
        <PowerAlert severity="error" autoHideDuration={null}>
          {actionError}
        </PowerAlert>
      ) : null}

      <UnitAttachmentsTable
        attachments={attachments}
        loading={loading}
        actionInFlight={deleting}
        downloadingId={downloadingId}
        onDownload={(attachment) => void download(attachment)}
        onEdit={setEditing}
        onDelete={(attachment) => {
          setDeleteError(null);
          setDeleteTarget(attachment);
        }}
      />

      <ConfirmDangerDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void confirmDelete()}
        title="Видалити файл?"
        description={
          deleteTarget
            ? `Файл «${attachmentFileName(deleteTarget)}» буде видалено. Цю дію неможливо скасувати.`
            : undefined
        }
        submitting={deleting}
      >
        {deleteError ? (
          <PowerAlert severity="error" autoHideDuration={null}>
            {deleteError}
          </PowerAlert>
        ) : null}
      </ConfirmDangerDialog>
    </Stack>
  );
}

export function UnitAttachmentsAdmin({
  unitId,
  onChanged,
}: {
  unitId: number;
  onChanged: (uploadedCount: number) => void;
}) {
  return (
    <TableStateProvider
      tableId="rer-unit-attachments"
      defaultColumnOrder={DEFAULT_COLUMN_ORDER}
      defaultColumnVisibility={DEFAULT_COLUMN_VISIBILITY}
      defaultEnableColumnOrdering={false}
    >
      <UnitAttachmentsAdminBody unitId={unitId} onChanged={onChanged} />
    </TableStateProvider>
  );
}
