import type { MessageCardDocumentKind } from './document-preview.types';

export type MessageCardDocumentPreviewCapabilities = {
  zoomable: boolean;
  carouselSwipeable: boolean;
};

const DOCUMENT_PREVIEW_CAPABILITIES: Record<
  MessageCardDocumentKind,
  MessageCardDocumentPreviewCapabilities
> = {
  pdf: { zoomable: true, carouselSwipeable: true },
  docx: { zoomable: true, carouselSwipeable: true },
  xlsx: { zoomable: true, carouselSwipeable: false },
  csv: { zoomable: true, carouselSwipeable: false },
  txt: { zoomable: false, carouselSwipeable: true },
  md: { zoomable: false, carouselSwipeable: true },
  unsupported: { zoomable: false, carouselSwipeable: true },
};

export function getDocumentPreviewCapabilities(
  kind: MessageCardDocumentKind,
): MessageCardDocumentPreviewCapabilities {
  return DOCUMENT_PREVIEW_CAPABILITIES[kind];
}
