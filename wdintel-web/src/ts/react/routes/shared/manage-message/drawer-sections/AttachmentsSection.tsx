import { Box, Typography } from '@mui/material';
import type { Uppy, UppyFile } from '@uppy/core';
import type { RefObject } from 'react';
import { useFormContext } from 'react-hook-form';

import type { MessageMediaInfo } from '../../../../../../Bindings';
import {
  AttachmentDropzone,
  AttachmentFileRow,
  useLocalMediaPreviewUrls,
  type AttachmentUploadPresentation,
} from '../../../../components/AttachmentPickerUi';
import { FormSectionWrapper } from './FormSectionWrapper';
import type { MessageFormData } from '../manage-message-drawer.schema';

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

function fileUploadPresentation(
  file: UppyFile<any, any>,
  busy: boolean,
): AttachmentUploadPresentation | null {
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
  const visibleMedia = existingMedia.filter((media) => !deletedMediaIds.includes(media.id));
  const previewFiles = uppyFiles.map((file) => ({
    id: file.id,
    name: file.name ?? '',
    type: file.type,
    size: file.size,
    data: file.data,
  }));
  const { urls, failPreview } = useLocalMediaPreviewUrls(previewFiles);
  const totalFiles = uppyFiles.length + visibleMedia.length;

  return (
    <FormSectionWrapper title={`Вкладення (${totalFiles})`}>
      <AttachmentDropzone
        busy={busy}
        fileInputRef={fileInputRef}
        onFileSelect={handleFileSelect}
        onDrop={handleDrop}
        onKeyDown={handleDropzoneKeyDown}
        helperText="До 20 файлів, до 2 ГБ кожен"
      />

      {errorMsg ? (
        <Typography variant="caption" color="error" sx={{ px: 1, mt: 0.5 }}>
          {errorMsg}
        </Typography>
      ) : null}

      {totalFiles > 0 ? (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
          {uppyFiles.map((file) => {
            const previewFile = {
              id: file.id,
              name: file.name ?? '',
              type: file.type,
              size: file.size,
              data: file.data,
            };
            const preview = urls.get(file.id);
            return (
              <AttachmentFileRow
                key={file.id}
                file={previewFile}
                busy={busy}
                onRemove={() => uppy.removeFile(file.id)}
                previewUrl={preview?.url}
                onPreviewError={() => failPreview(file.id)}
                upload={fileUploadPresentation(file, busy)}
              />
            );
          })}

          {visibleMedia.map((media) => (
            <AttachmentFileRow
              key={media.id}
              file={{
                id: media.id,
                name: media.fileName ?? 'Unnamed file',
                type: media.contentType,
                size: media.sizeBytes,
              }}
              busy={busy}
              onRemove={() =>
                setValue('deleted_media_ids', [...deletedMediaIds, media.id], {
                  shouldDirty: true,
                })
              }
            />
          ))}
        </Box>
      ) : null}
    </FormSectionWrapper>
  );
}
