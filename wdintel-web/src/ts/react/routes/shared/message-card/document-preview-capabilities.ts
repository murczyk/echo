import type { MessageCardDocumentKind } from './document-preview.types';

export type MessageCardDocumentPreviewCapabilities = {
  zoomable: boolean;
};

const DOCUMENT_PREVIEW_CAPABILITIES: Record<
  MessageCardDocumentKind,
  MessageCardDocumentPreviewCapabilities
> = {
  pdf: { zoomable: true },
  docx: { zoomable: true },
  xlsx: { zoomable: true },
  csv: { zoomable: true },
  txt: { zoomable: false },
  md: { zoomable: false },
  unsupported: { zoomable: false },
};

export function getDocumentPreviewCapabilities(
  kind: MessageCardDocumentKind,
): MessageCardDocumentPreviewCapabilities {
  return DOCUMENT_PREVIEW_CAPABILITIES[kind];
}
