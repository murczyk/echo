import type { MessageCardDocumentKind } from '../document-preview.types';

export type MessageCardPreviewKind = 'image' | 'video' | 'coordinate-map' | MessageCardDocumentKind;

export type MessageCardAttachmentPreviewConfig = {
  layout: 'document' | 'media';
  disableRestoreFocus: boolean;
};

const MESSAGE_CARD_PREVIEW_SHELL_CONFIG_BY_KIND = {
  image: {
    layout: 'media',
    disableRestoreFocus: true,
  },
  video: {
    layout: 'media',
    disableRestoreFocus: false,
  },
  'coordinate-map': {
    layout: 'media',
    disableRestoreFocus: true,
  },
  pdf: {
    layout: 'document',
    disableRestoreFocus: true,
  },
  docx: {
    layout: 'document',
    disableRestoreFocus: true,
  },
  xlsx: {
    layout: 'document',
    disableRestoreFocus: true,
  },
  csv: {
    layout: 'document',
    disableRestoreFocus: true,
  },
  txt: {
    layout: 'document',
    disableRestoreFocus: true,
  },
  md: {
    layout: 'document',
    disableRestoreFocus: true,
  },
  unsupported: {
    layout: 'document',
    disableRestoreFocus: true,
  },
} satisfies Record<MessageCardPreviewKind, MessageCardAttachmentPreviewConfig>;

export function getMessageCardAttachmentPreviewConfig(
  kind: MessageCardPreviewKind,
): MessageCardAttachmentPreviewConfig {
  return MESSAGE_CARD_PREVIEW_SHELL_CONFIG_BY_KIND[kind];
}
