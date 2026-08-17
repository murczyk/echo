import { Box, Typography } from '@mui/material';
import type { Uppy, UppyFile } from '@uppy/core';
import { useCallback, useMemo, useState, type RefObject } from 'react';
import { useFormContext } from 'react-hook-form';

import type { MessageMediaInfo } from '../../../../../../Bindings';
import { mediaKind } from '../../../../components/attachment-files';
import {
  AttachmentDropzone,
  AttachmentFileRow,
  useLocalMediaPreviewUrls,
  type AttachmentUploadPresentation,
} from '../../../../components/AttachmentPickerUi';
import { getDocumentKind } from '../../message-card/message-card-document-utils';
import {
  isImageMediaAttachment,
  isVideoMediaAttachment,
} from '../../message-card/MessageCardMedia';
import { MessageCardAttachmentPreviewProvider } from '../../message-card/attachment-preview/MessageCardAttachmentPreviewProvider';
import type { MessageCardPreviewItem } from '../../message-card/attachment-preview/message-card-preview.types';
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

  const [failedExistingMediaIds, setFailedExistingMediaIds] = useState<Set<string>>(
    () => new Set(),
  );
  const failExistingMedia = useCallback((id: string) => {
    setFailedExistingMediaIds((prev) => new Set(prev).add(id));
  }, []);

  const [previewDialogIndex, setPreviewDialogIndex] = useState<number | null>(null);

  const previewAttachments = useMemo<MessageCardPreviewItem[]>(() => {
    const items: MessageCardPreviewItem[] = [];

    for (const file of uppyFiles) {
      const preview = urls.get(file.id);
      const previewUrl = preview?.url;
      const kind = mediaKind(file.type, file.name);
      if (kind === 'image' && previewUrl) {
        items.push({
          type: 'image',
          value: {
            id: file.id,
            href: previewUrl,
            fileName: file.name ?? '',
            sizeBytes: file.size ?? null,
            contentType: file.type ?? null,
          },
        });
      } else if (kind === 'video') {
        items.push({
          type: 'video',
          value: {
            id: file.id,
            name: file.name ?? 'video',
            source: file.data instanceof Blob ? file.data : (previewUrl ?? ''),
            mimeType: file.type ?? undefined,
            sizeBytes: file.size ?? undefined,
          },
        });
      }
    }

    for (const media of visibleMedia) {
      if (failedExistingMediaIds.has(media.id) || !media.href) continue;
      const kind = mediaKind(media.contentType, media.fileName ?? '');
      if (kind === 'image' || isImageMediaAttachment(media)) {
        items.push({
          type: 'image',
          value: {
            id: media.id,
            href: media.href,
            fileName: media.fileName ?? null,
            sizeBytes: media.sizeBytes ?? null,
            contentType: media.contentType ?? null,
          },
        });
      } else if (kind === 'video' || isVideoMediaAttachment(media)) {
        items.push({
          type: 'video',
          value: {
            id: media.id,
            name: media.fileName ?? 'video',
            source: media.href,
            mimeType: media.contentType ?? undefined,
            sizeBytes: media.sizeBytes ?? undefined,
          },
        });
      } else {
        const docKind = getDocumentKind(media);
        if (docKind !== 'unsupported') {
          items.push({
            type: 'document',
            value: {
              id: media.id,
              href: media.href,
              fileName: media.fileName ?? null,
              sizeBytes: media.sizeBytes ?? null,
              contentType: media.contentType ?? null,
              kind: docKind,
            },
          });
        }
      }
    }

    return items;
  }, [uppyFiles, urls, visibleMedia, failedExistingMediaIds]);

  const openPreviewForId = useCallback(
    (id: string) => {
      const idx = previewAttachments.findIndex((item) =>
        item.type === 'coordinate' ? false : item.value.id === id,
      );
      if (idx !== -1) {
        setPreviewDialogIndex(idx);
      }
    },
    [previewAttachments],
  );

  const downloadUppyFile = useCallback((file: UppyFile<any, any>) => {
    const blob = file.data instanceof Blob ? file.data : null;
    if (blob) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name ?? 'attachment';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }, []);

  const downloadExistingMedia = useCallback((media: MessageMediaInfo) => {
    if (!media.href) return;
    const a = document.createElement('a');
    a.href = media.href;
    a.download = media.fileName ?? 'attachment';
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, []);

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
                onDownload={() => downloadUppyFile(file)}
                previewUrl={preview?.url}
                onPreviewError={() => failPreview(file.id)}
                onPreviewClick={() => openPreviewForId(file.id)}
                upload={fileUploadPresentation(file, busy)}
              />
            );
          })}

          {visibleMedia.map((media) => {
            const isFailed = failedExistingMediaIds.has(media.id);
            return (
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
                onDownload={() => downloadExistingMedia(media)}
                previewUrl={!isFailed && media.href ? media.href : undefined}
                onPreviewError={() => failExistingMedia(media.id)}
                onPreviewClick={() => openPreviewForId(media.id)}
              />
            );
          })}
        </Box>
      ) : null}

      {previewDialogIndex !== null && previewAttachments.length > 0 ? (
        <MessageCardAttachmentPreviewProvider
          attachments={previewAttachments}
          initialIndex={previewDialogIndex}
          onClose={() => setPreviewDialogIndex(null)}
        />
      ) : null}
    </FormSectionWrapper>
  );
}
