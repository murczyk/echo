import type { MouseEvent, ReactNode } from 'react';

import type { MessageCardPreviewNavigation } from './message-card-preview.types';
import {
  MessageCardAttachmentPreviewHeader,
  type AttachmentPreviewDownload,
} from './MessageCardAttachmentPreviewHeader';

export type { AttachmentPreviewDownload };

export function MessageCardAttachmentPreviewActions(props: {
  fileName?: string | null;
  openHref?: string | null;
  download?: AttachmentPreviewDownload;
  downloadKey?: string;
  navigation: MessageCardPreviewNavigation;
  additionalActions?: ReactNode;
  status?: ReactNode;
  onInfoClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  isFullscreen?: boolean;
  canFullscreen?: boolean;
  onToggleFullscreen?: () => void;
  onClose: () => void;
  isDownloadStarting?: (downloadKey: string) => boolean;
  onDownloadStart?: (downloadKey: string) => boolean;
}) {
  return <MessageCardAttachmentPreviewHeader {...props} />;
}
