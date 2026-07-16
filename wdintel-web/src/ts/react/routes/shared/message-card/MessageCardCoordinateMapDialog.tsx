import { useCallback, useEffect, useMemo, useState } from 'react';

import type { CoordinatePreviewPoint } from './message-coordinate-preview';
import { normalizePreviewIndex, shouldIgnoreArrowNavigation } from './document-preview-utils';
import { MessageCardPreviewShell } from './MessageCardPreviewShell';
import { getMessageCardPreviewShellConfig } from './message-card-preview-config';
import { blurActivePreviewDialogElement } from './message-card-preview-shell';
import { MessageCardCoordinateMapActions } from './MessageCardCoordinateMapActions';
import { MessageCardCoordinateMapControls } from './MessageCardCoordinateMapControls';
import { MessageCardCoordinateMapStage } from './MessageCardCoordinateMapStage';

type BaseLayerId = 'googleHybrid' | 'openStreetMap';

type Props = {
  points: CoordinatePreviewPoint[];
  currentIndex: number;
  open: boolean;
  onClose: () => void;
  onIndexChange: (index: number) => void;
};

export function MessageCardCoordinateMapDialog({
  points,
  currentIndex,
  open,
  onClose,
  onIndexChange,
}: Props) {
  const [baseLayerId, setBaseLayerId] = useState<BaseLayerId>('googleHybrid');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const previewConfig = getMessageCardPreviewShellConfig('coordinate-map');
  const canFullscreen = previewConfig.supportsFullscreen;
  const dialogIsFullscreen = canFullscreen && isFullscreen;

  const currentPoint = useMemo(() => {
    if (points.length === 0) {
      return null;
    }

    return points[Math.min(Math.max(currentIndex, 0), points.length - 1)] ?? null;
  }, [currentIndex, points]);

  useEffect(() => {
    if (!open) {
      setBaseLayerId('googleHybrid');
      setIsFullscreen(false);
      return;
    }

    setBaseLayerId('googleHybrid');
    setIsFullscreen(false);
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const handleWindowKeyDown = (event: globalThis.KeyboardEvent) => {
      if (dialogIsFullscreen && event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setIsFullscreen(false);
        return;
      }

      if (points.length <= 1 || shouldIgnoreArrowNavigation(event.target)) {
        return;
      }

      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        event.stopPropagation();
        onIndexChange(normalizePreviewIndex(currentIndex - 1, points.length));
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        event.stopPropagation();
        onIndexChange(normalizePreviewIndex(currentIndex + 1, points.length));
      }
    };

    window.addEventListener('keydown', handleWindowKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleWindowKeyDown, true);
    };
  }, [currentIndex, dialogIsFullscreen, onIndexChange, open, points.length]);

  const handleClose = useCallback(() => {
    blurActivePreviewDialogElement();
    onClose();
  }, [onClose]);

  const handleShellClose = useCallback(
    (event: unknown, reason: 'backdropClick' | 'escapeKeyDown') => {
      if (reason === 'escapeKeyDown' && dialogIsFullscreen) {
        setIsFullscreen(false);
        return;
      }

      handleClose();
    },
    [dialogIsFullscreen, handleClose],
  );

  if (!open || currentPoint == null) {
    return null;
  }

  return (
    <MessageCardPreviewShell
      open={open}
      isFullscreen={dialogIsFullscreen}
      ariaLabel="Карта координат"
      onClose={handleShellClose}
      config={previewConfig}
      stage={
        <MessageCardCoordinateMapStage
          open={open}
          point={currentPoint}
          baseLayerId={baseLayerId}
          isFullscreen={dialogIsFullscreen}
        />
      }
      controls={
        <MessageCardCoordinateMapControls
          baseLayerId={baseLayerId}
          canFullscreen={canFullscreen}
          isFullscreen={dialogIsFullscreen}
          onBaseLayerChange={setBaseLayerId}
          onToggleFullscreen={() => setIsFullscreen((value) => !value)}
        />
      }
      actions={
        <MessageCardCoordinateMapActions
          currentIndex={Math.min(Math.max(currentIndex, 0), points.length - 1)}
          pointCount={points.length}
          onClose={handleClose}
          onIndexChange={onIndexChange}
        />
      }
    />
  );
}
