import { useEffect, useRef, useState, type RefObject } from 'react';
import { Box, Typography, IconButton, LinearProgress } from '@mui/material';
import CloudUploadOutlinedIcon from '@mui/icons-material/CloudUploadOutlined';
import CloseIcon from '@mui/icons-material/Close';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import type { Uppy, UppyFile } from '@uppy/core';
import { useFormContext } from 'react-hook-form';
import { FormSectionWrapper } from './FormSectionWrapper';
import {
  attachmentIcon,
  fileExtension,
  formatFileSize,
  mediaKind,
  type MessageFormData,
} from '../manage-message-drawer.schema';
import type { MessageMediaInfo } from '../../../../../../Bindings';

type Props = {
  uppy: Uppy;
  uppyFiles: UppyFile<any, any>[];
  fileInputRef: RefObject<HTMLInputElement>;
  handleFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  handleDrop: (e: React.DragEvent<HTMLDivElement>) => void;
  handleDropzoneKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  busy: boolean;
  existingMedia?: MessageMediaInfo[];
  errorMsg?: string | null;
};

type UploadPresentation = {
  label: string;
  percentage: number;
  color: 'primary' | 'success' | 'error';
};

function fileUploadPresentation(
  file: UppyFile<any, any>,
  busy: boolean,
): UploadPresentation | null {
  const progress = file.progress;
  const rawPercentage = progress?.percentage ?? 0;
  const percentage = Math.min(100, Math.max(0, Math.round(rawPercentage)));
  if (file.error) {
    return { label: 'Помилка завантаження', percentage, color: 'error' };
  }
  if (progress?.uploadComplete) {
    return {
      label: busy ? 'Завантажено, обробка…' : 'Завантажено',
      percentage: 100,
      color: 'success',
    };
  }
  if (progress?.uploadStarted != null) {
    return { label: `Завантаження: ${percentage}%`, percentage, color: 'primary' };
  }
  if (busy) {
    return { label: 'Очікує завантаження', percentage: 0, color: 'primary' };
  }
  return null;
}

type PreviewUrl = { url: string };

function isLocalBlob(data: unknown): data is Blob {
  return (
    typeof data === 'object' &&
    data !== null &&
    typeof (data as Blob).size === 'number' &&
    typeof (data as Blob).type === 'string'
  );
}

function useLocalMediaPreviewUrls(files: UppyFile<any, any>[]) {
  const urlsRef = useRef(new Map<string, PreviewUrl>());
  const failedRef = useRef(new Set<string>());
  const [, refresh] = useState(0);
  const fileIdentity = files.map((file) => `${file.id}:${file.type}:${file.data}`).join('|');

  useEffect(() => {
    const currentIds = new Set(files.map((file) => file.id));
    for (const [id, preview] of urlsRef.current) {
      if (!currentIds.has(id)) {
        URL.revokeObjectURL(preview.url);
        urlsRef.current.delete(id);
        failedRef.current.delete(id);
      }
    }

    for (const file of files) {
      const data = file.data;
      if (
        !mediaKind(file.type) ||
        !isLocalBlob(data) ||
        failedRef.current.has(file.id) ||
        urlsRef.current.has(file.id)
      ) {
        continue;
      }
      urlsRef.current.set(file.id, { url: URL.createObjectURL(data) });
    }
    refresh((value) => value + 1);

    return () => undefined;
  }, [fileIdentity]);

  useEffect(
    () => () => {
      for (const { url } of urlsRef.current.values()) URL.revokeObjectURL(url);
      urlsRef.current.clear();
    },
    [],
  );

  const failPreview = (fileId: string) => {
    const preview = urlsRef.current.get(fileId);
    if (preview) URL.revokeObjectURL(preview.url);
    urlsRef.current.delete(fileId);
    failedRef.current.add(fileId);
    refresh((value) => value + 1);
  };

  return { urls: urlsRef.current, failPreview };
}

function LocalMediaPreview({
  file,
  previewUrl,
  onError,
}: {
  file: UppyFile<any, any>;
  previewUrl: string;
  onError: () => void;
}) {
  const kind = mediaKind(file.type);
  const previewSx = {
    width: 56,
    height: 56,
    flexShrink: 0,
    objectFit: 'cover',
    borderRadius: 0.75,
    bgcolor: 'action.selected',
  } as const;

  if (kind === 'image') {
    return <Box component="img" src={previewUrl} alt="" onError={onError} sx={previewSx} />;
  }
  if (kind !== 'video') return null;

  return (
    <Box sx={{ position: 'relative', width: 56, height: 56, flexShrink: 0 }}>
      <Box
        component="video"
        src={previewUrl}
        preload="auto"
        muted
        playsInline
        aria-hidden="true"
        onError={onError}
        sx={previewSx}
      />
      <PlayArrowIcon
        aria-hidden="true"
        sx={{
          position: 'absolute',
          inset: 0,
          margin: 'auto',
          p: 0.25,
          borderRadius: '50%',
          color: 'common.white',
          bgcolor: 'rgba(0, 0, 0, 0.55)',
          pointerEvents: 'none',
        }}
      />
    </Box>
  );
}

export function AttachmentsSection({
  uppy,
  uppyFiles,
  fileInputRef,
  handleFileSelect,
  handleDrop,
  handleDropzoneKeyDown,
  busy,
  existingMedia = [],
  errorMsg,
}: Props) {
  const { watch, setValue } = useFormContext<MessageFormData>();
  const deletedMediaIds = watch('deleted_media_ids') || [];
  const visibleMedia = existingMedia.filter((m) => !deletedMediaIds.includes(m.id));
  const { urls, failPreview } = useLocalMediaPreviewUrls(uppyFiles);

  const totalFiles = uppyFiles.length + visibleMedia.length;

  return (
    <FormSectionWrapper title={`Вкладення (${totalFiles})`}>
      <Box
        role="button"
        tabIndex={busy ? -1 : 0}
        aria-disabled={busy}
        aria-label="Додати файли"
        onClick={() => !busy && fileInputRef.current?.click()}
        onKeyDown={handleDropzoneKeyDown}
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onDrop={busy ? undefined : handleDrop}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1.5,
          border: '1px dashed',
          borderColor: 'divider',
          borderRadius: 1.5,
          py: 1,
          px: 1.5,
          cursor: busy ? 'not-allowed' : 'pointer',
          opacity: busy ? 0.5 : 1,
          transition: 'background-color 150ms ease, border-color 150ms ease',
          '&:hover': busy ? undefined : { bgcolor: 'action.hover', borderColor: 'primary.main' },
          '&:focus-visible': {
            outline: '2px solid',
            outlineColor: 'primary.main',
            outlineOffset: 2,
          },
        }}
      >
        <input
          type="file"
          multiple
          className="hidden"
          ref={fileInputRef}
          onChange={handleFileSelect}
          disabled={busy}
        />
        <CloudUploadOutlinedIcon fontSize="small" sx={{ color: 'text.secondary', flexShrink: 0 }} />
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="body2" color="text.secondary" noWrap>
            Натисніть, перетягніть або вставте (Cmd/Ctrl+V) файли сюди
          </Typography>
          <Typography variant="caption" color="text.disabled" noWrap component="div">
            До 20 файлів, до 2 ГБ кожен
          </Typography>
        </Box>
      </Box>

      {errorMsg && (
        <Typography variant="caption" color="error" sx={{ px: 1, mt: 0.5 }}>
          {errorMsg}
        </Typography>
      )}

      {totalFiles > 0 && (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
          {uppyFiles.map((f) => {
            const fileName = f.name ?? '';
            const FileIcon = attachmentIcon(fileName, f.type);
            const ext = fileExtension(fileName);
            const size = formatFileSize(f.size);
            const meta = [ext, size].filter(Boolean).join(' · ');
            const upload = fileUploadPresentation(f, busy);
            const preview = urls.get(f.id);
            return (
              <Box
                key={f.id}
                sx={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 0.5,
                  py: 0.5,
                  px: 1,
                  border: '1px solid',
                  borderColor: 'divider',
                  borderRadius: 1,
                  bgcolor: 'action.hover',
                }}
              >
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, width: '100%' }}>
                  <FileIcon fontSize="small" sx={{ color: 'text.secondary', flexShrink: 0 }} />
                  <Typography variant="body2" noWrap title={fileName} sx={{ flex: 1, minWidth: 0 }}>
                    {fileName}
                  </Typography>
                  {preview && (
                    <LocalMediaPreview
                      file={f}
                      previewUrl={preview.url}
                      onError={() => failPreview(f.id)}
                    />
                  )}
                  {meta && (
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ flexShrink: 0, whiteSpace: 'nowrap' }}
                    >
                      {meta}
                    </Typography>
                  )}
                  <IconButton
                    size="small"
                    aria-label={`Видалити ${fileName}`}
                    onClick={() => uppy.removeFile(f.id)}
                    disabled={busy}
                  >
                    <CloseIcon fontSize="small" />
                  </IconButton>
                </Box>
                {upload && (
                  <Box
                    sx={{ display: 'flex', alignItems: 'center', gap: 1, width: '100%', pl: 3.5 }}
                  >
                    <LinearProgress
                      variant="determinate"
                      value={upload.percentage}
                      color={upload.color}
                      aria-label={`Прогрес завантаження ${fileName}`}
                      sx={{ flex: 1, minWidth: 48 }}
                    />
                    <Typography
                      variant="caption"
                      color={upload.color === 'error' ? 'error' : 'text.secondary'}
                      sx={{ flexShrink: 0, minWidth: 138, textAlign: 'right' }}
                    >
                      {upload.label}
                    </Typography>
                  </Box>
                )}
              </Box>
            );
          })}

          {visibleMedia.map((m) => {
            const fileName = m.fileName ?? 'Unnamed file';
            const FileIcon = attachmentIcon(fileName, m.contentType);
            const ext = fileExtension(fileName);
            const size = formatFileSize(m.sizeBytes);
            const meta = [ext, size].filter(Boolean).join(' · ');
            return (
              <Box
                key={m.id}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1,
                  py: 0.5,
                  px: 1,
                  border: '1px solid',
                  borderColor: 'divider',
                  borderRadius: 1,
                  bgcolor: 'action.hover',
                }}
              >
                <FileIcon fontSize="small" sx={{ color: 'text.secondary', flexShrink: 0 }} />
                <Typography variant="body2" noWrap title={fileName} sx={{ flex: 1, minWidth: 0 }}>
                  {fileName}
                </Typography>
                {meta && (
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ flexShrink: 0, whiteSpace: 'nowrap' }}
                  >
                    {meta}
                  </Typography>
                )}
                <IconButton
                  size="small"
                  aria-label={`Видалити ${fileName}`}
                  onClick={() =>
                    setValue('deleted_media_ids', [...deletedMediaIds, m.id], { shouldDirty: true })
                  }
                  disabled={busy}
                >
                  <CloseIcon fontSize="small" />
                </IconButton>
              </Box>
            );
          })}
        </Box>
      )}
    </FormSectionWrapper>
  );
}
