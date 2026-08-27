import UploadIcon from '@mui/icons-material/Upload';
import {
  Autocomplete,
  Box,
  Button,
  CircularProgress,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { AreaOfResponsibility } from '../../../../Bindings';
import {
  AttachmentDropzone,
  AttachmentFileRow,
  useLocalMediaPreviewUrls,
  type AttachmentUploadPresentation,
} from '../../components/AttachmentPickerUi';
import { PowerAlert } from '../../components/PowerAlert';
import { listAors } from '../../services/api/aor';
import { uploadUnitAttachment } from '../../services/api/units';

// Keep these limits synchronized with the SIGINT_UNIT_ATTACHMENT_* constants
// in wdintel-rs/src/config.rs.
const MAX_FILES_PER_BATCH = 20;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_FILENAME_CHARS = 255;
export const MAX_SHORT_DESCRIPTION_CHARS = 500;
export const MAX_FULL_DESCRIPTION_CHARS = 20_000;
const MAX_AORS = 100;

type PendingStatus = 'ready' | 'uploading' | 'uploaded' | 'failed';

type PendingAttachment = {
  id: string;
  file: File;
  status: PendingStatus;
  error: string | null;
};

type Props = {
  unitId: number;
  onUploaded: (count: number) => void;
};

let nextFileId = 0;

function formatError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return 'Невідома помилка';
}

function fileIdentity(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

function uploadPresentation(
  attachment: PendingAttachment,
  busy: boolean,
): AttachmentUploadPresentation | null {
  switch (attachment.status) {
    case 'uploading':
      return { label: 'Завантаження…', percentage: null, color: 'primary' };
    case 'uploaded':
      return { label: 'Завантажено', percentage: 100, color: 'success' };
    case 'failed':
      return { label: 'Помилка завантаження', percentage: 100, color: 'error' };
    case 'ready':
      return busy ? { label: 'Очікує завантаження', percentage: 0, color: 'primary' } : null;
  }
}

function useAorSelection(busy: boolean) {
  const [aors, setAors] = useState<AreaOfResponsibility[]>([]);
  const [selectedAors, setSelectedAors] = useState<AreaOfResponsibility[]>([]);
  const [aorsLoading, setAorsLoading] = useState(true);
  const [aorsError, setAorsError] = useState<string | null>(null);
  const [aorsLoadVersion, setAorsLoadVersion] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setAorsLoading(true);
    setAorsError(null);
    void listAors({ sortBy: 'AreaOfResponsibilityNameAsc' }, controller.signal)
      .then((loadedAors) => {
        setAors(loadedAors);
        setAorsLoading(false);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setAorsError(formatError(error));
        setAorsLoading(false);
      });
    return () => controller.abort();
  }, [aorsLoadVersion]);

  const selectAors = (value: AreaOfResponsibility[]) => {
    if (value.length <= MAX_AORS) setSelectedAors(value);
  };

  return {
    aors,
    selectedAors,
    selectAors,
    clearSelectedAors: () => setSelectedAors([]),
    aorsLoading,
    aorsError,
    retryAors: () => setAorsLoadVersion((version) => version + 1),
    aorsDisabled: busy || aorsLoading || aorsError !== null,
  };
}

function useAttachmentSelection(busy: boolean, onSelectionChange: () => void) {
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const previewFiles = useMemo(
    () =>
      attachments.map(({ id, file }) => ({
        id,
        name: file.name,
        type: file.type,
        size: file.size,
        data: file,
      })),
    [attachments],
  );
  const { urls, failPreview } = useLocalMediaPreviewUrls(previewFiles);

  const addFiles = useCallback(
    (incomingFiles: File[]) => {
      if (busy || incomingFiles.length === 0) return;
      setPickerError(null);
      onSelectionChange();
      const knownFiles = new Set(attachments.map(({ file }) => fileIdentity(file)));
      const next = [...attachments];
      const problems: string[] = [];

      for (const file of incomingFiles) {
        if (next.length >= MAX_FILES_PER_BATCH) {
          problems.push(`Можна додати не більше ${MAX_FILES_PER_BATCH} файлів за один раз.`);
          break;
        }
        if (file.size === 0) {
          problems.push(`${file.name}: файл порожній.`);
          continue;
        }
        if (file.size > MAX_FILE_BYTES) {
          problems.push(`${file.name}: розмір перевищує 50 МБ.`);
          continue;
        }
        if (Array.from(file.name).length > MAX_FILENAME_CHARS) {
          problems.push(`${file.name}: назва перевищує ${MAX_FILENAME_CHARS} символів.`);
          continue;
        }
        const identity = fileIdentity(file);
        if (knownFiles.has(identity)) {
          problems.push(`${file.name}: цей файл уже додано.`);
          continue;
        }
        knownFiles.add(identity);
        next.push({
          id: `unit-attachment-${nextFileId++}`,
          file,
          status: 'ready',
          error: null,
        });
      }

      setAttachments(next);
      if (problems.length > 0) {
        setPickerError(problems.join(' '));
      }
    },
    [attachments, busy, onSelectionChange],
  );

  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      if (busy) return;
      const files = Array.from(event.clipboardData?.items ?? [])
        .filter((item) => item.kind === 'file')
        .map((item) => item.getAsFile())
        .filter((file): file is File => file !== null);
      if (files.length === 0) return;
      event.preventDefault();
      addFiles(files);
    };
    document.addEventListener('paste', handlePaste);
    return () => document.removeEventListener('paste', handlePaste);
  }, [addFiles, busy]);

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    addFiles(Array.from(event.target.files ?? []));
    event.target.value = '';
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    addFiles(Array.from(event.dataTransfer.files ?? []));
    event.dataTransfer.clearData();
  };

  const handleDropzoneKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (busy || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    fileInputRef.current?.click();
  };

  const removeFile = (id: string) => {
    setAttachments((current) => current.filter((attachment) => attachment.id !== id));
    setPickerError(null);
    onSelectionChange();
  };

  return {
    attachments,
    setAttachments,
    clearAttachments: () => setAttachments([]),
    pickerError,
    clearPickerError: () => setPickerError(null),
    fileInputRef,
    urls,
    failPreview,
    handleFileSelect,
    handleDrop,
    handleDropzoneKeyDown,
    removeFile,
  };
}

function setAttachmentStatus(
  setAttachments: React.Dispatch<React.SetStateAction<PendingAttachment[]>>,
  id: string,
  status: PendingStatus,
  error: string | null,
) {
  setAttachments((current) =>
    current.map((attachment) =>
      attachment.id === id ? { ...attachment, status, error } : attachment,
    ),
  );
}

type UploadBatchParams = {
  unitId: number;
  attachments: PendingAttachment[];
  shortDescription: string;
  fullDescription: string;
  aorIds: number[];
  setAttachments: React.Dispatch<React.SetStateAction<PendingAttachment[]>>;
};

async function uploadAttachmentBatch({
  unitId,
  attachments,
  shortDescription,
  fullDescription,
  aorIds,
  setAttachments,
}: UploadBatchParams) {
  const failed = new Map<string, string>();
  let uploadedCount = 0;

  for (const attachment of attachments) {
    setAttachmentStatus(setAttachments, attachment.id, 'uploading', null);
    try {
      await uploadUnitAttachment({
        unitId,
        shortDescription,
        fullDescription,
        aorIds,
        file: attachment.file,
      });
      uploadedCount += 1;
      setAttachmentStatus(setAttachments, attachment.id, 'uploaded', null);
    } catch (error) {
      const message = formatError(error);
      failed.set(attachment.id, message);
      setAttachmentStatus(setAttachments, attachment.id, 'failed', message);
    }
  }

  return { failed, uploadedCount };
}

type AttachmentRowsProps = {
  attachments: PendingAttachment[];
  busy: boolean;
  urls: Map<string, { url: string }>;
  onRemove: (id: string) => void;
  onPreviewError: (id: string) => void;
};

function AttachmentRows({
  attachments,
  busy,
  urls,
  onRemove,
  onPreviewError,
}: AttachmentRowsProps) {
  if (attachments.length === 0) return null;

  return (
    <Stack spacing={0.75}>
      {attachments.map((attachment) => {
        const preview = urls.get(attachment.id);
        return (
          <AttachmentFileRow
            key={attachment.id}
            file={{
              id: attachment.id,
              name: attachment.file.name,
              type: attachment.file.type,
              size: attachment.file.size,
              data: attachment.file,
            }}
            busy={busy}
            onRemove={() => onRemove(attachment.id)}
            previewUrl={preview?.url}
            onPreviewError={() => onPreviewError(attachment.id)}
            upload={uploadPresentation(attachment, busy)}
          />
        );
      })}
    </Stack>
  );
}

type MetadataFieldsProps = {
  busy: boolean;
  shortDescription: string;
  fullDescription: string;
  onShortDescriptionChange: (value: string) => void;
  onFullDescriptionChange: (value: string) => void;
  aorSelection: ReturnType<typeof useAorSelection>;
};

function MetadataFields({
  busy,
  shortDescription,
  fullDescription,
  onShortDescriptionChange,
  onFullDescriptionChange,
  aorSelection,
}: MetadataFieldsProps) {
  return (
    <>
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
        <TextField
          label="Короткий опис"
          value={shortDescription}
          onChange={(event) => onShortDescriptionChange(event.target.value)}
          multiline
          minRows={3}
          required
          disabled={busy}
          inputProps={{ maxLength: MAX_SHORT_DESCRIPTION_CHARS }}
          fullWidth
        />
        <TextField
          label="Повний опис"
          value={fullDescription}
          onChange={(event) => onFullDescriptionChange(event.target.value)}
          multiline
          minRows={3}
          required
          disabled={busy}
          inputProps={{ maxLength: MAX_FULL_DESCRIPTION_CHARS }}
          fullWidth
        />
      </Stack>

      <Autocomplete
        multiple
        options={aorSelection.aors}
        value={aorSelection.selectedAors}
        loading={aorSelection.aorsLoading}
        disabled={aorSelection.aorsDisabled}
        isOptionEqualToValue={(option, value) => option.id === value.id}
        getOptionLabel={(option) => option.name}
        onChange={(_, value) => aorSelection.selectAors(value)}
        renderInput={(params) => (
          <TextField
            {...params}
            label="Смуги"
            required
            placeholder="Оберіть смуги, користувачі яких бачитимуть файли"
            InputProps={{
              ...params.InputProps,
              endAdornment: (
                <>
                  {aorSelection.aorsLoading ? <CircularProgress color="inherit" size={20} /> : null}
                  {params.InputProps.endAdornment}
                </>
              ),
            }}
          />
        )}
      />

      {aorSelection.aorsError ? (
        <PowerAlert
          severity="error"
          autoHideDuration={null}
          action={
            <Button color="inherit" size="small" onClick={aorSelection.retryAors}>
              Спробувати ще раз
            </Button>
          }
        >
          Не вдалося завантажити смуги: {aorSelection.aorsError}
        </PowerAlert>
      ) : null}
    </>
  );
}

export function UnitAttachmentUploader({ unitId, onUploaded }: Props) {
  const [shortDescription, setShortDescription] = useState('');
  const [fullDescription, setFullDescription] = useState('');
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const clearUploadFeedback = useCallback(() => {
    setUploadError(null);
    setSuccessMessage(null);
  }, []);
  const aorSelection = useAorSelection(busy);
  const attachmentSelection = useAttachmentSelection(busy, clearUploadFeedback);
  const {
    attachments,
    setAttachments,
    pickerError,
    clearPickerError,
    fileInputRef,
    urls,
    failPreview,
    handleFileSelect,
    handleDrop,
    handleDropzoneKeyDown,
    removeFile,
  } = attachmentSelection;

  const canUpload =
    !busy &&
    attachments.length > 0 &&
    aorSelection.selectedAors.length > 0 &&
    shortDescription.trim() !== '' &&
    fullDescription.trim() !== '';

  const uploadFiles = async () => {
    if (!canUpload) return;
    setBusy(true);
    clearPickerError();
    setUploadError(null);
    setSuccessMessage(null);

    const batch: PendingAttachment[] = attachments.map((attachment) => ({
      ...attachment,
      status: 'ready',
      error: null,
    }));
    const { failed, uploadedCount } = await uploadAttachmentBatch({
      unitId,
      attachments: batch,
      shortDescription: shortDescription.trim(),
      fullDescription: fullDescription.trim(),
      aorIds: aorSelection.selectedAors.map(({ id }) => id),
      setAttachments,
    });

    if (uploadedCount > 0) {
      onUploaded(uploadedCount);
    }

    if (failed.size === 0) {
      attachmentSelection.clearAttachments();
      aorSelection.clearSelectedAors();
      setShortDescription('');
      setFullDescription('');
      setSuccessMessage(
        uploadedCount === 1 ? 'Файл успішно додано.' : `Успішно додано ${uploadedCount} файлів.`,
      );
    } else {
      setAttachments((current) =>
        current
          .filter(({ id }) => failed.has(id))
          .map((attachment) => ({
            ...attachment,
            status: 'failed',
            error: failed.get(attachment.id) ?? null,
          })),
      );
      const failedDetails = batch
        .filter(({ id }) => failed.has(id))
        .map(({ id, file }) => `${file.name}: ${failed.get(id)}`)
        .join(' ');
      setUploadError(
        uploadedCount > 0
          ? `${uploadedCount} файлів додано. Не вдалося додати решту: ${failedDetails}`
          : `Не вдалося додати файли: ${failedDetails}`,
      );
    }
    setBusy(false);
  };

  return (
    <Box
      sx={{
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 1,
        p: 2.5,
        bgcolor: 'background.paper',
      }}
    >
      <Stack spacing={2}>
        <Box>
          <Typography variant="h6" component="h2">
            Додати файли
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Обрані описи та смуги доступу будуть застосовані до кожного файлу.
          </Typography>
        </Box>

        <AttachmentDropzone
          busy={busy}
          fileInputRef={fileInputRef}
          onFileSelect={handleFileSelect}
          onDrop={handleDrop}
          onKeyDown={handleDropzoneKeyDown}
          helperText="До 20 файлів, до 50 МБ кожен"
        />

        {pickerError ? <PowerAlert severity="warning">{pickerError}</PowerAlert> : null}
        {uploadError ? (
          <PowerAlert severity="error" autoHideDuration={null}>
            {uploadError}
          </PowerAlert>
        ) : null}
        {successMessage ? <PowerAlert severity="success">{successMessage}</PowerAlert> : null}

        <AttachmentRows
          attachments={attachments}
          busy={busy}
          urls={urls}
          onRemove={removeFile}
          onPreviewError={failPreview}
        />

        <MetadataFields
          busy={busy}
          shortDescription={shortDescription}
          fullDescription={fullDescription}
          onShortDescriptionChange={setShortDescription}
          onFullDescriptionChange={setFullDescription}
          aorSelection={aorSelection}
        />

        <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button
            variant="contained"
            startIcon={busy ? <CircularProgress color="inherit" size={16} /> : <UploadIcon />}
            disabled={!canUpload}
            onClick={() => void uploadFiles()}
          >
            {busy
              ? 'Додавання…'
              : attachments.length === 1
                ? 'Додати файл'
                : `Додати файли (${attachments.length})`}
          </Button>
        </Box>
      </Stack>
    </Box>
  );
}
