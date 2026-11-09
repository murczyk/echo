import { useState, type Dispatch, type SetStateAction } from 'react';

import type {
  FilePreviewLifecycleProps,
  FilePreviewSource,
} from '../attachment-preview/file-preview-source';
import { AttachmentPreviewZoomBadge } from '../attachment-preview/AttachmentPreviewZoomBadge';
import { DocumentPreviewZoomControls } from '../attachment-preview/DocumentPreviewZoomControls';
import { MessageCardAttachmentPreviewStage } from '../attachment-preview/MessageCardAttachmentPreviewStage';
import { useDocumentPreviewZoom } from '../attachment-preview/useDocumentPreviewZoom';
import { getDocumentFileKind } from '../document-file-kind';
import { getDocumentPreviewCapabilities } from '../document-preview-capabilities';
import type { MessageCardDocumentKind } from '../document-preview.types';
import { isInteractivePreviewTarget } from '../message-card-image-preview-utils';
import { DocumentFilePreview } from './DocumentFilePreview';

export function DocumentFilePreviewStage({
  source,
  kind = getDocumentFileKind(source),
  lifecycle,
  zoom,
  onZoomChange,
  onBackgroundClick,
  zoomBadgePosition,
}: {
  source: FilePreviewSource;
  kind?: MessageCardDocumentKind;
  lifecycle?: FilePreviewLifecycleProps;
  zoom: number;
  onZoomChange: Dispatch<SetStateAction<number>>;
  onBackgroundClick?: () => void;
  zoomBadgePosition?: { alignWithCarousel?: boolean; bottom?: string };
}) {
  const [stageEl, setStageEl] = useState<HTMLDivElement | null>(null);
  const canZoom = getDocumentPreviewCapabilities(kind).zoomable;
  useDocumentPreviewZoom(stageEl, canZoom, onZoomChange);

  return (
    <MessageCardAttachmentPreviewStage
      ref={setStageEl}
      kind="document"
      onDoubleClick={(event) => {
        if (!canZoom || isInteractivePreviewTarget(event.target)) return;
        onZoomChange((currentZoom) => (currentZoom > 100 ? 100 : 150));
      }}
      onPrimaryClick={(_, region) => {
        if (region === 'background') onBackgroundClick?.();
      }}
    >
      <DocumentFilePreview source={source} kind={kind} zoom={zoom} lifecycle={lifecycle} />
      {kind === 'docx' ? (
        <DocumentPreviewZoomControls zoom={zoom} onZoomChange={onZoomChange} />
      ) : canZoom ? (
        <AttachmentPreviewZoomBadge
          zoom={zoom}
          onResetZoom={() => onZoomChange(100)}
          {...zoomBadgePosition}
        />
      ) : null}
    </MessageCardAttachmentPreviewStage>
  );
}
