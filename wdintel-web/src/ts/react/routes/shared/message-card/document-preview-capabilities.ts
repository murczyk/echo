import type { MessageCardDocumentKind } from './document-preview.types';

export type MessageCardDocumentPreviewCapabilities = {
  zoomable: boolean;
  fullscreen: boolean;
};

const DOCUMENT_PREVIEW_CAPABILITIES: Record<
  MessageCardDocumentKind,
  MessageCardDocumentPreviewCapabilities
> = {
  pdf: { zoomable: true, fullscreen: true },
  docx: { zoomable: true, fullscreen: true },
  xlsx: { zoomable: true, fullscreen: true },
  txt: { zoomable: false, fullscreen: false },
  md: { zoomable: false, fullscreen: false },
  unsupported: { zoomable: false, fullscreen: false },
};

export function getDocumentPreviewCapabilities(
  kind: MessageCardDocumentKind,
): MessageCardDocumentPreviewCapabilities {
  return DOCUMENT_PREVIEW_CAPABILITIES[kind];
}
