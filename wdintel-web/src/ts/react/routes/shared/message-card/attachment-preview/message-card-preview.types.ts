import type { MessageCardDocument } from '../document-preview.types';
import type { MessageCardImage } from '../message-card-image-utils';
import type { VideoPreviewSource } from '../message-card-video-utils';
import type { CoordinatePreviewPoint } from '../message-coordinate-preview';

export type AudioPreviewSource = {
  id: string;
  source: string;
  fileName: string;
  contentType?: string | null;
  sizeBytes?: number | null;
  transcription?: string | null;
  mediaId?: string | null;
};

export type KmzAttachmentPreviewSource = {
  id?: string;
  mediaId: string;
  originalHref: string;
  fileName: string;
  initialStatus: string;
};

export type MessageCardPreviewNavigation = {
  index: number;
  count: number;
  disabled?: boolean;
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
  | { type: 'audio'; value: AudioPreviewSource }
  | { type: 'document'; value: MessageCardDocument }
  | { type: 'kmz'; value: KmzAttachmentPreviewSource }
  | { type: 'coordinate'; points: CoordinatePreviewPoint[] };
