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
import type { ImageEditingCapability } from '../../image-editor/image-editor.types';
import { replacePendingImageFile } from '../../image-editor/image-editor-upload';
import { blurActiveElement } from '../../../../utils/focus';
import { MAX_MESSAGE_ATTACHMENTS } from '../useMessageUppy';
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
  const replacementByMediaId = useMemo(() => {
    const replacements = new Map<string, UppyFile<any, any>>();
    uppyFiles.forEach((file) => {
      const mediaId = file.meta?.replaces_media_id;
      if (typeof mediaId === 'string' && existingMedia.some((media) => media.id === mediaId))
        replacements.set(mediaId, file);
    });
    return replacements;
  }, [existingMedia, uppyFiles]);
  const visibleMedia = existingMedia.filter(
    (media) => !deletedMediaIds.includes(media.id) || replacementByMediaId.has(media.id),
  );

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
  const replacementFiles = [...replacementByMediaId.values()];

  const previewFiles = useMemo(
    () =>
      uppyFiles.map((file) => ({
        id: file.id,
        name: file.name ?? '',
        type: file.type,
        size: file.size,
        data: file.data,
      })),
    [uppyFiles],
  );
  const { urls, failPreview } = useLocalMediaPreviewUrls(previewFiles);
  const totalFiles =
    visibleMedia.length + uppyFiles.filter((file) => !replacementFiles.includes(file)).length;

  const [failedExistingMediaIds, setFailedExistingMediaIds] = useState<Set<string>>(
    () => new Set(),
  );
  const failExistingMedia = useCallback((id: string) => {
    setFailedExistingMediaIds((prev) => new Set(prev).add(id));
  }, []);

  const [previewDialogIndex, setPreviewDialogIndex] = useState<number | null>(null);
  const [previewInitialAction, setPreviewInitialAction] = useState<'edit-image' | null>(null);
  const imageEditing = useMemo<ImageEditingCapability>(
    () => ({
      canEdit: (image) =>
        !busy &&
        ['image/jpeg', 'image/png', 'image/webp'].includes((image.contentType ?? '').toLowerCase()),
      loadSource: async (image, signal) => {
        const imageId = image.id ?? '';
        const pending = uppy.getFile(imageId);
        if (pending?.data instanceof Blob)
          return {
            blob: pending.data,
            fileName: pending.name ?? image.fileName ?? 'image',
            mimeType: pending.type ?? image.contentType ?? 'image/png',
          };
        const response = await fetch(image.href, { signal, credentials: 'same-origin' });
        if (!response.ok) throw new Error('Не вдалося завантажити зображення для редагування');
        const blob = await response.blob();
        return {
          blob,
          fileName: image.fileName ?? 'image',
          mimeType: image.contentType ?? blob.type ?? 'image/png',
        };
      },
      applyReplacement: async (image, result) => {
        const imageId = image.id ?? '';
        if (!imageId) throw new Error('Не вдалося визначити вкладення для заміни');
        const pending = uppy.getFile(imageId);
        if (pending) {
          replacePendingImageFile({ uppy, fileId: imageId, pending, replacement: result.file });
          return;
        }
        if (visibleMedia.length - 1 + uppy.getFiles().length >= MAX_MESSAGE_ATTACHMENTS)
          throw new Error(`Перевищено максимальну кількість вкладень (${MAX_MESSAGE_ATTACHMENTS})`);
        try {
          uppy.addFile({
            name: result.file.name,
            type: result.file.type,
            data: result.file,
            meta: { replaces_media_id: imageId },
          });
        } catch (cause) {
          throw new Error(
            cause instanceof Error
              ? `Не вдалося додати заміну вкладення: ${cause.message}`
              : 'Не вдалося додати заміну вкладення',
          );
        }
        setValue('deleted_media_ids', Array.from(new Set([...deletedMediaIds, imageId])), {
          shouldDirty: true,
        });
      },
    }),
    [busy, deletedMediaIds, setValue, uppy, visibleMedia.length],
  );

  const previewAttachments = useMemo<MessageCardPreviewItem[]>(() => {
    const items: MessageCardPreviewItem[] = [];
    const appendUppyPreview = (file: UppyFile<any, any>) => {
      const previewUrl = urls.get(file.id)?.url;
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
        const docKind = getDocumentKind({
          id: file.id,
          contentType: file.type ?? '',
          fileName: file.name ?? null,
          sizeBytes: file.size ?? 0,
          transcription: null,
          ocr: null,
          summary: null,
          href: previewUrl,
        });
        if (docKind !== 'unsupported') {
          items.push({
            type: 'document',
            value: {
              id: file.id,
              href: previewUrl,
              fileName: file.name ?? '',
              sizeBytes: file.size ?? null,
              contentType: file.type ?? null,
              kind: docKind,
            },
          });
        }
      }
    };

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
      const replacement = replacementByMediaId.get(id);
      if (replacement) {
        appendUppyPreview(replacement);
        continue;
      }
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

    for (const file of sortedUppyFiles)
      if (!replacementFiles.includes(file)) appendUppyPreview(file);

    return items;
  }, [sortedUppyFiles, urls, sortedVisibleMedia, failedExistingMediaIds, replacementByMediaId]);

  const openPreviewForId = useCallback(
    (id: string, initialAction: 'edit-image' | null = null) => {
      const idx = previewAttachments.findIndex((item) =>
        item.type === 'coordinate' ? false : item.value.id === id,
      );
      if (idx !== -1) {
        blurActiveElement();
        setPreviewInitialAction(initialAction);
        setPreviewDialogIndex(idx);
      }
    },
    [previewAttachments],
  );
  const canEditPreviewAttachment = useCallback(
    (id: string) => {
      const item = previewAttachments.find(
        (candidate): candidate is Extract<MessageCardPreviewItem, { type: 'image' }> =>
          candidate.type === 'image' && candidate.value.id === id,
      );
      return item != null && imageEditing.canEdit(item.value);
    },
    [imageEditing, previewAttachments],
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

  const removeReplacement = useCallback(
    (file: UppyFile<any, any>, mediaId: string) => {
      uppy.removeFile(file.id);
      setValue(
        'deleted_media_ids',
        deletedMediaIds.filter((id) => id !== mediaId),
        { shouldDirty: true },
      );
    },
    [deletedMediaIds, setValue, uppy],
  );

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
            const replacement = replacementByMediaId.get(id);
            const preview = replacement ? urls.get(replacement.id) : undefined;
            return (
              <AttachmentFileRow
                key={replacement?.id ?? id}
                file={{
                  id: replacement?.id ?? id,
                  name: replacement?.name ?? fileName,
                  type: replacement?.type ?? contentType,
                  size: replacement?.size ?? sizeBytes,
                }}
                busy={busy}
                onRemove={() =>
                  replacement
                    ? removeReplacement(replacement, id)
                    : setValue('deleted_media_ids', Array.from(new Set([...deletedMediaIds, id])), {
                        shouldDirty: true,
                      })
                }
                onDownload={() =>
                  replacement
                    ? downloadUppyFile(replacement)
                    : downloadExistingMedia({
                        ...media,
                        id,
                        fileName,
                        contentType,
                        href: href ?? '',
                      })
                }
                previewUrl={replacement ? preview?.url : !isFailed && href ? href : undefined}
                onPreviewError={() =>
                  replacement ? failPreview(replacement.id) : failExistingMedia(id)
                }
                onPreviewClick={() => openPreviewForId(replacement?.id ?? id)}
                onEdit={
                  canEditPreviewAttachment(replacement?.id ?? id)
                    ? () => openPreviewForId(replacement?.id ?? id, 'edit-image')
                    : undefined
                }
                upload={replacement ? fileUploadPresentation(replacement, busy) : undefined}
              />
            );
          })}

          {sortedUppyFiles
            .filter((file) => !replacementFiles.includes(file))
            .map((file) => {
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
                  onEdit={
                    canEditPreviewAttachment(file.id)
                      ? () => openPreviewForId(file.id, 'edit-image')
                      : undefined
                  }
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
          onClose={() => {
            blurActiveElement();
            setPreviewInitialAction(null);
            setPreviewDialogIndex(null);
          }}
          imageEditing={imageEditing}
          initialAction={previewInitialAction ?? undefined}
        />
      ) : null}
    </FormSectionWrapper>
  );
}
