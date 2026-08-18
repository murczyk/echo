import type { MessageCardDocument } from '../document-preview.types';
import type { MessageCardImage } from '../message-card-image-utils';
import type { VideoPreviewSource } from '../message-card-video-utils';
import type { CoordinatePreviewPoint } from '../message-coordinate-preview';

export type MessageCardPreviewNavigation = {
  index: number;
  count: number;
  onPrevious: () => void;
  onNext: () => void;
};

export type AttachmentPreviewDownload =
  | { href: string; fileName: string; onDownload?: never }
  | { href?: never; fileName?: never; onDownload: () => void };

export type AttachmentPreviewDownloadItem = {
  label: string;
  download: AttachmentPreviewDownload;
  downloadKey?: string;
};

export type MessageCardPreviewItem =
  | { type: 'image'; value: MessageCardImage }
  | { type: 'video'; value: VideoPreviewSource }
  | { type: 'document'; value: MessageCardDocument }
  | { type: 'coordinate'; points: CoordinatePreviewPoint[] };
