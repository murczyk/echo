import { useMemo, useState } from 'react';

import type { MessengersAttachment } from '../../../../../Bindings';
import { blurActiveElement } from '../../../utils/focus';
import {
  MessageMediaAudioPlayer,
  MessageMediaDownloadLink,
  isAudioMediaAttachment,
  isVideoMediaAttachment,
  mediaAttachmentContentType,
  mediaAttachmentDisplayName,
  useMessageCardDownloadGuard,
} from '../../shared/message-card/MessageCardMedia';
import { MessageCardImageList } from '../../shared/message-card/MessageCardImageList';
import { MessageMediaDocumentLink } from '../../shared/message-card/MessageMediaDocumentLink';
import { collectMessageDocuments } from '../../shared/message-card/message-card-document-utils';
import { collectMessageImages } from '../../shared/message-card/message-card-image-utils';
import {
  MessageCardAttachmentPreviewProvider,
  type MessageCardPreviewAttachment,
} from '../../shared/message-card/attachment-preview/MessageCardAttachmentPreviewProvider';

const hrefOf = (href: unknown) => String(href ?? '').trim();

// Photos, video, documents and audio of one analysis messenger message, built from the shared message card pieces.
// shortcut: no KMZ or coordinate previews yet; those attachments fall back to a plain download link.
export function MessengerMessageAttachments({
  attachments,
}: {
  attachments: readonly MessengersAttachment[];
}) {
  const downloadGuard = useMessageCardDownloadGuard();
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);

  const parts = useMemo(() => {
    const media = attachments.map((attachment) => attachment.media);
    const images = collectMessageImages({ images: [], media });
    const documents = collectMessageDocuments({ media });
    const taken = new Set([...images, ...documents].map((item) => hrefOf(item.href)));
    const rest = media.filter((item) => !taken.has(hrefOf(item.href)));
    const audio = rest.filter(isAudioMediaAttachment);
    const videos = rest.filter(
      (item) => isVideoMediaAttachment(item) && !isAudioMediaAttachment(item),
    );
    const downloads = rest.filter(
      (item) => !isAudioMediaAttachment(item) && !isVideoMediaAttachment(item),
    );
    const previewableDocuments = documents.filter((document) => document.kind !== 'unsupported');
    const preview: MessageCardPreviewAttachment[] = [
      ...images.map((image) => ({ type: 'image' as const, value: image })),
      ...videos.map((video) => ({
        type: 'video' as const,
        value: {
          id: video.id ?? '',
          name: mediaAttachmentDisplayName(video),
          source: String(video.href ?? ''),
          mimeType: mediaAttachmentContentType(video) || undefined,
          sizeBytes: video.sizeBytes ?? undefined,
        },
      })),
      ...previewableDocuments.map((document) => ({ type: 'document' as const, value: document })),
    ];
    return { images, documents, previewableDocuments, audio, videos, downloads, preview };
  }, [attachments]);

  const { images, documents, previewableDocuments, audio, videos, downloads, preview } = parts;
  if (preview.length + documents.length + audio.length + downloads.length === 0) return null;

  const open = (index: number) => {
    blurActiveElement();
    setPreviewIndex(index);
  };

  return (
    <div className="flex flex-col items-start gap-2" data-messenger-attachments>
      <MessageCardImageList
        images={images}
        videos={videos}
        onOpen={open}
        onOpenVideo={(index) => open(images.length + index)}
        {...downloadGuard}
      />
      {documents.length + downloads.length > 0 ? (
        <div className="flex w-full flex-wrap items-start gap-2">
          {documents.map((document, index) => {
            const previewable = previewableDocuments.findIndex(
              (candidate) => candidate.href === document.href,
            );
            return (
              <MessageMediaDocumentLink
                key={document.id ?? document.href}
                document={document}
                index={index}
                onPreview={
                  previewable >= 0
                    ? () => open(images.length + videos.length + previewable)
                    : undefined
                }
                {...downloadGuard}
              />
            );
          })}
          {downloads.map((attachment) => (
            <MessageMediaDownloadLink
              key={attachment.id}
              attachment={attachment}
              {...downloadGuard}
            />
          ))}
        </div>
      ) : null}
      {audio.map((attachment) => (
        <MessageMediaAudioPlayer key={attachment.id} attachment={attachment} {...downloadGuard} />
      ))}
      {previewIndex != null && preview.length > 0 ? (
        <MessageCardAttachmentPreviewProvider
          attachments={preview}
          initialIndex={previewIndex}
          onClose={() => setPreviewIndex(null)}
          {...downloadGuard}
        />
      ) : null}
    </div>
  );
}
