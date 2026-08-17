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

function attachmentSortRank(contentType: string | undefined, fileName: string | undefined): number {
  const kind = mediaKind(contentType, fileName);
  if (kind === 'image') return 0;
  if (kind === 'video') return 1;
  const type = (contentType ?? '').toLowerCase();
  if (type.startsWith('audio/')) return 3;
  return 2;
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

  const sortedVisibleMedia = useMemo(() => {
    return [...visibleMedia].sort((a, b) => {
      const rawA = a as MessageMediaInfo & {
        file_name?: string | null;
        content_type?: string | null;
      };
      const rawB = b as MessageMediaInfo & {
        file_name?: string | null;
        content_type?: string | null;
      };
      const rankA = attachmentSortRank(
        a.contentType ?? rawA.content_type ?? undefined,
        a.fileName ?? rawA.file_name ?? undefined,
      );
      const rankB = attachmentSortRank(
        b.contentType ?? rawB.content_type ?? undefined,
        b.fileName ?? rawB.file_name ?? undefined,
      );
      return rankA - rankB;
    });
  }, [visibleMedia]);

  const sortedUppyFiles = useMemo(() => {
    return [...uppyFiles].sort((a, b) => {
      const rankA = attachmentSortRank(a.type, a.name);
      const rankB = attachmentSortRank(b.type, b.name);
      return rankA - rankB;
    });
  }, [uppyFiles]);

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

    for (const media of sortedVisibleMedia) {
      const rawMedia = media as MessageMediaInfo & {
        file_name?: string | null;
        content_type?: string | null;
        size_bytes?: number | null;
      };
      const id = String(media.id ?? (rawMedia as any).id ?? '');
      const fileName = media.fileName ?? rawMedia.file_name ?? null;
      const contentType = media.contentType ?? rawMedia.content_type ?? undefined;
      const sizeBytes = media.sizeBytes ?? rawMedia.size_bytes ?? undefined;
      const href = media.href || (id ? `/api/messenger/media/${id}` : undefined);
      if (failedExistingMediaIds.has(id) || !href) continue;
      const kind = mediaKind(contentType, fileName ?? '');
      if (
        kind === 'image' ||
        isImageMediaAttachment({ ...media, id, contentType, fileName, href })
      ) {
        items.push({
          type: 'image',
          value: {
            id,
            href,
            fileName: fileName ?? '',
            sizeBytes: sizeBytes ?? null,
            contentType: contentType ?? null,
          },
        });
      } else if (
        kind === 'video' ||
        isVideoMediaAttachment({ ...media, id, contentType, fileName, href })
      ) {
        items.push({
          type: 'video',
          value: {
            id,
            name: fileName ?? 'video',
            source: href,
            mimeType: contentType,
            sizeBytes,
          },
        });
      } else {
        const docKind = getDocumentKind({ ...media, id, contentType, fileName, href });
        if (docKind !== 'unsupported') {
          items.push({
            type: 'document',
            value: {
              id,
              href,
              fileName,
              sizeBytes: sizeBytes ?? null,
              contentType: contentType ?? null,
              kind: docKind,
            },
          });
        }
      }
    }

    for (const file of sortedUppyFiles) {
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
      } else if (previewUrl) {
        const href = previewUrl;
        const docKind = getDocumentKind({
          id: file.id,
          contentType: file.type ?? '',
          fileName: file.name ?? null,
          sizeBytes: file.size ?? 0,
          transcription: null,
          ocr: null,
          summary: null,
          href,
        });
        if (docKind !== 'unsupported') {
          items.push({
            type: 'document',
            value: {
              id: file.id,
              href,
              fileName: file.name ?? '',
              sizeBytes: file.size ?? null,
              contentType: file.type ?? null,
              kind: docKind,
            },
          });
        }
      }
    }

    return items;
  }, [sortedUppyFiles, urls, sortedVisibleMedia, failedExistingMediaIds]);

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
          {sortedVisibleMedia.map((media) => {
            const rawMedia = media as MessageMediaInfo & {
              file_name?: string | null;
              content_type?: string | null;
              size_bytes?: number | null;
            };
            const id = String(media.id ?? (rawMedia as any).id ?? '');
            const fileName = media.fileName ?? rawMedia.file_name ?? 'Unnamed file';
            const contentType = media.contentType ?? rawMedia.content_type ?? undefined;
            const sizeBytes = media.sizeBytes ?? rawMedia.size_bytes ?? undefined;
            const href = media.href || (id ? `/api/messenger/media/${id}` : undefined);
            const isFailed = failedExistingMediaIds.has(id);
            return (
              <AttachmentFileRow
                key={id}
                file={{
                  id,
                  name: fileName,
                  type: contentType,
                  size: sizeBytes,
                }}
                busy={busy}
                onRemove={() =>
                  setValue('deleted_media_ids', [...deletedMediaIds, id], {
                    shouldDirty: true,
                  })
                }
                onDownload={() =>
                  downloadExistingMedia({ ...media, id, fileName, contentType, href: href ?? '' })
                }
                previewUrl={!isFailed && href ? href : undefined}
                onPreviewError={() => failExistingMedia(id)}
                onPreviewClick={() => openPreviewForId(id)}
              />
            );
          })}

          {sortedUppyFiles.map((file) => {
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
