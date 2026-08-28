import type { MessageCardDocumentKind } from '../document-preview.types';

export type MessageCardPreviewKind = 'image' | 'video' | 'coordinate-map' | MessageCardDocumentKind;

export type MessageCardAttachmentPreviewConfig = {
  layout: 'document' | 'media';
  disableRestoreFocus: boolean;
  supportsFullscreen: boolean;
};

const MESSAGE_CARD_PREVIEW_SHELL_CONFIG_BY_KIND = {
  image: {
    layout: 'media',
    disableRestoreFocus: true,
    supportsFullscreen: true,
  },
  video: {
    layout: 'media',
    disableRestoreFocus: false,
    supportsFullscreen: true,
  },
  'coordinate-map': {
    layout: 'media',
    disableRestoreFocus: true,
    supportsFullscreen: true,
  },
  pdf: {
    layout: 'document',
    disableRestoreFocus: true,
    supportsFullscreen: true,
  },
  docx: {
    layout: 'document',
    disableRestoreFocus: true,
    supportsFullscreen: true,
  },
  xlsx: {
    layout: 'document',
    disableRestoreFocus: true,
    supportsFullscreen: true,
  },
  csv: {
    layout: 'document',
    disableRestoreFocus: true,
    supportsFullscreen: true,
  },
  txt: {
    layout: 'document',
    disableRestoreFocus: true,
    supportsFullscreen: true,
  },
  md: {
    layout: 'document',
    disableRestoreFocus: true,
    supportsFullscreen: true,
  },
  unsupported: {
    layout: 'document',
    disableRestoreFocus: true,
    supportsFullscreen: true,
  },
} satisfies Record<MessageCardPreviewKind, MessageCardAttachmentPreviewConfig>;

export function getMessageCardAttachmentPreviewConfig(
  kind: MessageCardPreviewKind,
): MessageCardAttachmentPreviewConfig {
  return MESSAGE_CARD_PREVIEW_SHELL_CONFIG_BY_KIND[kind];
}
