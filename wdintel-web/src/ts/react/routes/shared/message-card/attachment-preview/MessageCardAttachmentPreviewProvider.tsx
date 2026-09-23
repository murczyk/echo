import { useCallback, useEffect, useRef, useState } from 'react';

import { normalizePreviewIndex } from '../document-preview-utils';
import { MessageCardAttachmentPreviewDialog } from './MessageCardAttachmentPreviewDialog';
import type { MessageCardDownloadGuardProps } from '../MessageCardMedia';
import type { MessageCardPreviewItem } from './message-card-preview.types';
import type { ImageEditingCapability } from '../../image-editor/image-editor.types';
import type { AttachmentPreviewReportDraft } from './ReportTextPreview';

export type MessageCardPreviewAttachment = MessageCardPreviewItem;

export function MessageCardAttachmentPreviewProvider({
  attachments,
  initialIndex,
  onClose,
  onIndexChange,
  isDownloadStarting,
  onDownloadStart,
  imageEditing,
  initialAction,
  reportDraft,
  onPreviewActivated,
}: {
  attachments: MessageCardPreviewItem[];
  initialIndex: number;
  onClose: () => void;
  onIndexChange?: (index: number) => void;
  imageEditing?: ImageEditingCapability;
  initialAction?: 'edit-image';
  reportDraft?: AttachmentPreviewReportDraft;
  onPreviewActivated?: () => void;
} & Partial<MessageCardDownloadGuardProps>) {
  const [currentIndex, setCurrentIndex] = useState(() =>
    normalizePreviewIndex(initialIndex, attachments.length),
  );
  const previousInitialIndexRef = useRef(initialIndex);

  useEffect(() => {
    setCurrentIndex((index) => normalizePreviewIndex(index, attachments.length));
  }, [attachments.length]);

  useEffect(() => {
    if (previousInitialIndexRef.current === initialIndex) return;
    previousInitialIndexRef.current = initialIndex;
    setCurrentIndex(normalizePreviewIndex(initialIndex, attachments.length));
  }, [attachments.length, initialIndex]);

  const changeIndex = useCallback(
    (index: number) => {
      const nextIndex = normalizePreviewIndex(index, attachments.length);
      setCurrentIndex(nextIndex);
      onIndexChange?.(nextIndex);
    },
    [attachments.length, onIndexChange],
  );
  const resolvedIndex = normalizePreviewIndex(currentIndex, attachments.length);
  const currentItem = attachments[resolvedIndex] ?? null;

  useEffect(() => {
    if (attachments.length <= 1) return;
    const hrefs = new Set<string>();
    for (const offset of [-1, 1]) {
      const item = attachments[normalizePreviewIndex(resolvedIndex + offset, attachments.length)];
      if (item?.type === 'image' && item.value.href) hrefs.add(item.value.href);
    }
    hrefs.forEach((href) => {
      const image = new Image();
      image.decoding = 'async';
      image.src = href;
    });
  }, [attachments, resolvedIndex]);

  useEffect(() => {
    if (currentItem != null) onPreviewActivated?.();
  }, [currentItem, onPreviewActivated]);

  if (currentItem == null) return null;

  return (
    <MessageCardAttachmentPreviewDialog
      item={currentItem}
      navigation={{
        index: resolvedIndex,
        count: attachments.length,
        onPrevious: () => changeIndex(resolvedIndex - 1),
        onNext: () => changeIndex(resolvedIndex + 1),
      }}
      onClose={onClose}
      isDownloadStarting={isDownloadStarting}
      onDownloadStart={onDownloadStart}
      imageEditing={imageEditing}
      initialAction={initialAction}
      reportDraft={reportDraft}
    />
  );
}
