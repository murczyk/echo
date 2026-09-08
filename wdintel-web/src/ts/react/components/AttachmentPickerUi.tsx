import CloseIcon from '@mui/icons-material/Close';
import CloudUploadOutlinedIcon from '@mui/icons-material/CloudUploadOutlined';
import DownloadIcon from '@mui/icons-material/Download';
import EditIcon from '@mui/icons-material/Edit';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import {
  Box,
  IconButton,
  LinearProgress,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Typography,
} from '@mui/material';
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

type PreviewUrl = { url: string; data: Blob };

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
  useEffect(() => {
    let changed = false;
    const currentIds = new Set(files.map((file) => file.id));
    for (const [id, preview] of urlsRef.current) {
      if (!currentIds.has(id)) {
        URL.revokeObjectURL(preview.url);
        urlsRef.current.delete(id);
        failedRef.current.delete(id);
        changed = true;
      }
    }

    for (const file of files) {
      const data = file.data;
      const existing = urlsRef.current.get(file.id);
      if (!mediaKind(file.type, file.name) || !isLocalBlob(data)) continue;
      if (failedRef.current.has(file.id) && existing?.data === data) continue;
      if (existing?.data === data) continue;
      failedRef.current.delete(file.id);
      if (existing) URL.revokeObjectURL(existing.url);
      urlsRef.current.set(file.id, { url: URL.createObjectURL(data), data });
      changed = true;
    }
    if (changed) refresh((value) => value + 1);

    return () => undefined;
  }, [files]);

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
  onClick,
}: {
  file: AttachmentPreviewFile;
  previewUrl: string;
  onError?: () => void;
  onClick?: () => void;
}) {
  const kind = mediaKind(file.type, file.name);
  const previewSx = {
    width: '100%',
    height: '100%',
    flexShrink: 0,
    objectFit: 'cover',
    borderRadius: 0.75,
    bgcolor: 'action.selected',
    display: 'block',
  } as const;

  const content =
    kind === 'image' ? (
      <Box component="img" src={previewUrl} alt="" onError={onError} sx={previewSx} />
    ) : kind === 'video' ? (
      <Box sx={{ position: 'relative', width: '100%', height: '100%', flexShrink: 0 }}>
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
    ) : null;

  if (!content) return null;

  if (onClick) {
    return (
      <Box
        component="button"
        type="button"
        aria-label={`Переглянути ${file.name}`}
        onClick={onClick}
        sx={{
          p: 0,
          m: 0,
          border: 0,
          background: 'none',
          cursor: 'pointer',
          borderRadius: 0.75,
          display: 'flex',
          width: '100%',
          height: '100%',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          transition: 'opacity 150ms ease',
          '&:hover': { opacity: 0.85 },
          '&:focus-visible': {
            outline: '2px solid',
            outlineColor: 'primary.main',
            outlineOffset: 2,
          },
        }}
      >
        {content}
      </Box>
    );
  }

  return content;
}

type FileRowProps = {
  file: AttachmentPreviewFile;
  busy: boolean;
  onRemove: () => void;
  onDownload?: () => void;
  onEdit?: () => void;
  previewUrl?: string;
  onPreviewError?: () => void;
  onPreviewClick?: () => void;
  upload?: AttachmentUploadPresentation | null;
};

export function AttachmentFileRow({
  file,
  busy,
  onRemove,
  onDownload,
  onEdit,
  previewUrl,
  onPreviewError,
  onPreviewClick,
  upload,
}: FileRowProps) {
  const FileIcon = attachmentIcon(file.name, file.type);
  const ext = fileExtension(file.name);
  const size = formatFileSize(file.size);
  const meta = [ext, size].filter(Boolean).join(' · ');
  const isMedia = Boolean(mediaKind(file.type, file.name));
  const [menuAnchorEl, setMenuAnchorEl] = useState<null | HTMLElement>(null);
  const menuOpen = Boolean(menuAnchorEl);

  const handleMenuOpen = (event: React.MouseEvent<HTMLElement>) => {
    event.stopPropagation();
    setMenuAnchorEl(event.currentTarget);
  };

  const handleMenuClose = () => {
    setMenuAnchorEl(null);
  };

  const handleDownloadClick = () => {
    handleMenuClose();
    onDownload?.();
  };

  const handleEditClick = () => {
    const menuAnchor = menuAnchorEl;
    handleMenuClose();
    menuAnchor?.blur();
    window.setTimeout(() => onEdit?.(), 0);
  };

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: 0.5,
        p: 0.5,
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 1,
        bgcolor: 'action.hover',
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, width: '100%' }}>
        <Box
          sx={{
            width: 48,
            height: 48,
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 0.75,
            bgcolor: 'action.selected',
            overflow: 'hidden',
          }}
        >
          {previewUrl && isMedia ? (
            <LocalMediaPreview
              file={file}
              previewUrl={previewUrl}
              onError={onPreviewError}
              onClick={onPreviewClick}
            />
          ) : onPreviewClick ? (
            <Box
              component="button"
              type="button"
              aria-label={`Переглянути ${file.name}`}
              onClick={onPreviewClick}
              sx={{
                p: 0,
                m: 0,
                border: 0,
                background: 'none',
                cursor: 'pointer',
                borderRadius: 0.75,
                display: 'flex',
                width: '100%',
                height: '100%',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
                transition: 'background-color 150ms ease',
                '&:hover': { bgcolor: 'action.focus' },
                '&:focus-visible': {
                  outline: '2px solid',
                  outlineColor: 'primary.main',
                  outlineOffset: 2,
                },
              }}
            >
              <FileIcon fontSize="small" sx={{ color: 'text.secondary' }} />
            </Box>
          ) : (
            <FileIcon fontSize="small" sx={{ color: 'text.secondary' }} />
          )}
        </Box>
        <Typography variant="body2" noWrap title={file.name} sx={{ flex: 1, minWidth: 0 }}>
          {file.name}
        </Typography>
        {meta ? (
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ flexShrink: 0, whiteSpace: 'nowrap' }}
          >
            {meta}
          </Typography>
        ) : null}
        {onDownload || onEdit ? (
          <span className="flex shrink-0 items-center gap-0">
            <IconButton
              size="small"
              aria-label={`Більше дій для ${file.name}`}
              aria-haspopup="true"
              aria-expanded={menuOpen ? 'true' : undefined}
              onClick={handleMenuOpen}
              disabled={busy}
              sx={{ flexShrink: 0 }}
            >
              <MoreVertIcon fontSize="small" />
            </IconButton>
            <Menu
              anchorEl={menuAnchorEl}
              open={menuOpen}
              onClose={handleMenuClose}
              transformOrigin={{ horizontal: 'right', vertical: 'top' }}
              anchorOrigin={{ horizontal: 'right', vertical: 'bottom' }}
            >
              {onEdit ? (
                <MenuItem onClick={handleEditClick}>
                  <ListItemIcon>
                    <EditIcon fontSize="small" />
                  </ListItemIcon>
                  <ListItemText>Редагувати</ListItemText>
                </MenuItem>
              ) : null}
              {onDownload ? (
                <MenuItem onClick={handleDownloadClick}>
                  <ListItemIcon>
                    <DownloadIcon fontSize="small" />
                  </ListItemIcon>
                  <ListItemText>Завантажити</ListItemText>
                </MenuItem>
              ) : null}
            </Menu>
            <IconButton
              size="small"
              aria-label={`Видалити ${file.name}`}
              onClick={onRemove}
              disabled={busy}
            >
              <CloseIcon fontSize="small" />
            </IconButton>
          </span>
        ) : null}
        {!onDownload && !onEdit ? (
          <IconButton
            size="small"
            aria-label={`Видалити ${file.name}`}
            onClick={onRemove}
            disabled={busy}
          >
            <CloseIcon fontSize="small" />
          </IconButton>
        ) : null}
      </Box>
      {upload ? (
        <Box
          data-attachment-upload-status-row="true"
          sx={{ display: 'flex', alignItems: 'center', gap: 1, width: '100%', pl: '60px', pr: 1 }}
        >
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
            noWrap
            sx={{ flex: '0 1 138px', minWidth: 0, textAlign: 'right' }}
          >
            {upload.label}
          </Typography>
        </Box>
      ) : null}
    </Box>
  );
}
