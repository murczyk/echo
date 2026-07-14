import type { MessageCardDocumentKind } from './document-preview.types';

export type MessageCardPreviewKind = 'image' | 'video' | MessageCardDocumentKind;

export type MessageCardPreviewShellConfig = {
  layout: 'document' | 'media';
  disableRestoreFocus: boolean;
  supportsFullscreen: boolean;
  disableEscapeKeyDownInFullscreen: boolean;
};

const MESSAGE_CARD_PREVIEW_SHELL_CONFIG_BY_KIND = {
  image: {
    layout: 'media',
    disableRestoreFocus: true,
    supportsFullscreen: true,
    disableEscapeKeyDownInFullscreen: true,
  },
  video: {
    layout: 'media',
    disableRestoreFocus: false,
    supportsFullscreen: true,
    disableEscapeKeyDownInFullscreen: true,
  },
  pdf: {
    layout: 'document',
    disableRestoreFocus: true,
    supportsFullscreen: true,
    disableEscapeKeyDownInFullscreen: false,
  },
  docx: {
    layout: 'document',
    disableRestoreFocus: true,
    supportsFullscreen: true,
    disableEscapeKeyDownInFullscreen: false,
  },
  xlsx: {
    layout: 'document',
    disableRestoreFocus: true,
    supportsFullscreen: true,
    disableEscapeKeyDownInFullscreen: false,
  },
  txt: {
    layout: 'document',
    disableRestoreFocus: true,
    supportsFullscreen: false,
    disableEscapeKeyDownInFullscreen: false,
  },
  md: {
    layout: 'document',
    disableRestoreFocus: true,
    supportsFullscreen: false,
    disableEscapeKeyDownInFullscreen: false,
  },
  unsupported: {
    layout: 'document',
    disableRestoreFocus: true,
    supportsFullscreen: false,
    disableEscapeKeyDownInFullscreen: false,
  },
} satisfies Record<MessageCardPreviewKind, MessageCardPreviewShellConfig>;

export function getMessageCardPreviewShellConfig(
  kind: MessageCardPreviewKind,
): MessageCardPreviewShellConfig {
  return MESSAGE_CARD_PREVIEW_SHELL_CONFIG_BY_KIND[kind];
}
