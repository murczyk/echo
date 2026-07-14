import React, { RefObject } from 'react';
import { Box, Typography, IconButton } from '@mui/material';
import CloudUploadOutlinedIcon from '@mui/icons-material/CloudUploadOutlined';
import CloseIcon from '@mui/icons-material/Close';
import type { Uppy, UppyFile } from '@uppy/core';
import { useFormContext } from 'react-hook-form';
import { FormSectionWrapper } from './FormSectionWrapper';
import {
  attachmentIcon,
  fileExtension,
  formatFileSize,
  type MessageFormData,
} from '../manage-message-drawer.schema';
import type { MessageMediaInfo } from '../../../../../Bindings';

type Props = {
  uppy: Uppy;
  uppyFiles: UppyFile<any, any>[];
  fileInputRef: RefObject<HTMLInputElement>;
  handleFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  handleDrop: (e: React.DragEvent<HTMLDivElement>) => void;
  handleDropzoneKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  busy: boolean;
  existingMedia?: MessageMediaInfo[];
};

export function AttachmentsSection({
  uppy,
  uppyFiles,
  fileInputRef,
  handleFileSelect,
  handleDrop,
  handleDropzoneKeyDown,
  busy,
  existingMedia = [],
}: Props) {
  const { watch, setValue } = useFormContext<MessageFormData>();
  const deletedMediaIds = watch('deleted_media_ids') || [];
  const visibleMedia = existingMedia.filter((m) => !deletedMediaIds.includes(m.id));

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
            Натисніть або перетягніть файли сюди
          </Typography>
          <Typography variant="caption" color="text.disabled" noWrap component="div">
            До 20 файлів, до 2 ГБ кожен
          </Typography>
        </Box>
      </Box>

      {totalFiles > 0 && (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
          {uppyFiles.map((f) => {
            const fileName = f.name ?? '';
            const FileIcon = attachmentIcon(fileName, f.type);
            const ext = fileExtension(fileName);
            const size = formatFileSize(f.size);
            const meta = [ext, size].filter(Boolean).join(' · ');
            return (
              <Box
                key={f.id}
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
                  onClick={() => uppy.removeFile(f.id)}
                  disabled={busy}
                >
                  <CloseIcon fontSize="small" />
                </IconButton>
              </Box>
            );
          })}

          {visibleMedia.map((m) => {
            const fileName = m.fileName ?? 'Unnamed file';
            const FileIcon = attachmentIcon(fileName, m.contentType);
            const ext = m.fileExt || fileExtension(fileName);
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
