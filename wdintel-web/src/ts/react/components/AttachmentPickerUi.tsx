import CloseIcon from '@mui/icons-material/Close';
import CloudUploadOutlinedIcon from '@mui/icons-material/CloudUploadOutlined';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import { Box, IconButton, LinearProgress, Typography } from '@mui/material';
import { useEffect, useRef, useState, type RefObject } from 'react';

import { attachmentIcon, fileExtension, formatFileSize, mediaKind } from './attachment-files';

export type AttachmentPreviewFile = {
  id: string;
  name: string;
  type?: string;
  size?: number | null;
  data?: unknown;
};

export type AttachmentUploadPresentation = {
  label: string;
  percentage: number | null;
  color: 'primary' | 'success' | 'error';
};

type DropzoneProps = {
  busy: boolean;
  fileInputRef: RefObject<HTMLInputElement>;
  onFileSelect: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onDrop: (event: React.DragEvent<HTMLDivElement>) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  helperText: string;
};

export function AttachmentDropzone({
  busy,
  fileInputRef,
  onFileSelect,
  onDrop,
  onKeyDown,
  helperText,
}: DropzoneProps) {
  return (
    <Box
      role="button"
      tabIndex={busy ? -1 : 0}
      aria-disabled={busy}
      aria-label="Додати файли"
      onClick={() => !busy && fileInputRef.current?.click()}
      onKeyDown={onKeyDown}
      onDragOver={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onDrop={busy ? undefined : onDrop}
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
        onChange={onFileSelect}
        disabled={busy}
      />
      <CloudUploadOutlinedIcon fontSize="small" sx={{ color: 'text.secondary', flexShrink: 0 }} />
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="body2" color="text.secondary" noWrap>
          Натисніть, перетягніть або вставте (Cmd/Ctrl+V) файли сюди
        </Typography>
        <Typography variant="caption" color="text.disabled" noWrap component="div">
          {helperText}
        </Typography>
      </Box>
    </Box>
  );
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

export function useLocalMediaPreviewUrls(files: AttachmentPreviewFile[]) {
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
  file: AttachmentPreviewFile;
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

type FileRowProps = {
  file: AttachmentPreviewFile;
  busy: boolean;
  onRemove: () => void;
  previewUrl?: string;
  onPreviewError?: () => void;
  upload?: AttachmentUploadPresentation | null;
};

export function AttachmentFileRow({
  file,
  busy,
  onRemove,
  previewUrl,
  onPreviewError,
  upload,
}: FileRowProps) {
  const FileIcon = attachmentIcon(file.name, file.type);
  const ext = fileExtension(file.name);
  const size = formatFileSize(file.size);
  const meta = [ext, size].filter(Boolean).join(' · ');

  return (
    <Box
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
        <Typography variant="body2" noWrap title={file.name} sx={{ flex: 1, minWidth: 0 }}>
          {file.name}
        </Typography>
        {previewUrl && onPreviewError ? (
          <LocalMediaPreview file={file} previewUrl={previewUrl} onError={onPreviewError} />
        ) : null}
        {meta ? (
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ flexShrink: 0, whiteSpace: 'nowrap' }}
          >
            {meta}
          </Typography>
        ) : null}
        <IconButton
          size="small"
          aria-label={`Видалити ${file.name}`}
          onClick={onRemove}
          disabled={busy}
        >
          <CloseIcon fontSize="small" />
        </IconButton>
      </Box>
      {upload ? (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, width: '100%', pl: 3.5 }}>
          <LinearProgress
            variant={upload.percentage === null ? 'indeterminate' : 'determinate'}
            value={upload.percentage ?? undefined}
            color={upload.color}
            aria-label={`Прогрес завантаження ${file.name}`}
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
      ) : null}
    </Box>
  );
}
