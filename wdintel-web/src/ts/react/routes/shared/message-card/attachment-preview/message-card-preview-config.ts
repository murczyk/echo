import type { MessageCardDocumentKind } from '../document-preview.types';

export const MESSAGE_CARD_PREVIEW_MOBILE_ISLAND_HEIGHT_PX = 40;
export const MESSAGE_CARD_PREVIEW_MOBILE_ISLAND_BOTTOM_PX = 16;
export const MESSAGE_CARD_PREVIEW_MOBILE_ISLAND_CONTROLS_BOTTOM_PX = 72;
export const MESSAGE_CARD_PREVIEW_MOBILE_TAP_MAX_DURATION_MS = 500;

export type MessageCardPreviewKind =
  'image' | 'video' | 'audio' | 'coordinate-map' | 'kmz-map' | MessageCardDocumentKind;

export type MessageCardAttachmentPreviewConfig = {
  disableRestoreFocus: boolean;
};

const MESSAGE_CARD_PREVIEW_SHELL_CONFIG_BY_KIND = {
  image: {
    disableRestoreFocus: true,
  },
  video: {
    disableRestoreFocus: false,
  },
  audio: {
    disableRestoreFocus: false,
  },
  'kmz-map': {
    disableRestoreFocus: true,
  },
  'coordinate-map': {
    disableRestoreFocus: true,
  },
  pdf: {
    disableRestoreFocus: true,
  },
  doc: {
    disableRestoreFocus: true,
  },
  docx: {
    disableRestoreFocus: true,
  },
  xls: {
    disableRestoreFocus: true,
  },
  xlsx: {
    disableRestoreFocus: true,
  },
  csv: {
    disableRestoreFocus: true,
  },
  txt: {
    disableRestoreFocus: true,
  },
  md: {
    disableRestoreFocus: true,
  },
  zip: {
    disableRestoreFocus: true,
  },
  unsupported: {
    disableRestoreFocus: true,
  },
} satisfies Record<MessageCardPreviewKind, MessageCardAttachmentPreviewConfig>;

export function getMessageCardAttachmentPreviewConfig(
  kind: MessageCardPreviewKind,
): MessageCardAttachmentPreviewConfig {
  return MESSAGE_CARD_PREVIEW_SHELL_CONFIG_BY_KIND[kind];
}
