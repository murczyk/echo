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
  doc: { zoomable: true, carouselSwipeable: true },
  docx: { zoomable: true, carouselSwipeable: true },
  xls: { zoomable: true, carouselSwipeable: false },
  xlsx: { zoomable: true, carouselSwipeable: false },
  csv: { zoomable: true, carouselSwipeable: false },
  txt: { zoomable: false, carouselSwipeable: true },
  md: { zoomable: false, carouselSwipeable: true },
  zip: { zoomable: false, carouselSwipeable: false },
  unsupported: { zoomable: false, carouselSwipeable: true },
};

export function getDocumentPreviewCapabilities(
  kind: MessageCardDocumentKind,
): MessageCardDocumentPreviewCapabilities {
  return DOCUMENT_PREVIEW_CAPABILITIES[kind];
}
