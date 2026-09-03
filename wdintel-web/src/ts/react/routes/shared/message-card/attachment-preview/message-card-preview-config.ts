import type { MessageCardDocumentKind } from '../document-preview.types';

export type MessageCardPreviewKind = 'image' | 'video' | 'coordinate-map' | MessageCardDocumentKind;

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
  'coordinate-map': {
    disableRestoreFocus: true,
  },
  pdf: {
    disableRestoreFocus: true,
  },
  docx: {
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
  unsupported: {
    disableRestoreFocus: true,
  },
} satisfies Record<MessageCardPreviewKind, MessageCardAttachmentPreviewConfig>;

export function getMessageCardAttachmentPreviewConfig(
  kind: MessageCardPreviewKind,
): MessageCardAttachmentPreviewConfig {
  return MESSAGE_CARD_PREVIEW_SHELL_CONFIG_BY_KIND[kind];
}
