import type { MouseEvent, ReactNode } from 'react';

import type {
  AttachmentPreviewDownload,
  AttachmentPreviewDownloadItem,
  MessageCardPreviewNavigation,
} from './message-card-preview.types';
import { MessageCardAttachmentPreviewHeader } from './MessageCardAttachmentPreviewHeader';

export type { AttachmentPreviewDownload, AttachmentPreviewDownloadItem };

export function MessageCardAttachmentPreviewActions(props: {
  fileName?: string | null;
  openHref?: string | null;
  download?: AttachmentPreviewDownload;
  downloadKey?: string;
  navigation: MessageCardPreviewNavigation;
  additionalActions?: ReactNode;
  overflowAction?: ReactNode;
  status?: ReactNode;
  onInfoClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  infoSeverity?: 'warning' | 'error';
  isFullscreen?: boolean;
  canFullscreen?: boolean;
  onToggleFullscreen?: () => void;
  onClose: () => void;
  isDownloadStarting?: (downloadKey: string) => boolean;
  onDownloadStart?: (downloadKey: string) => boolean;
}) {
  return <MessageCardAttachmentPreviewHeader {...props} />;
}
