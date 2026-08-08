import { Dialog } from '@mui/material';
import { useEffect, useState } from 'react';

import { shouldIgnoreArrowNavigation } from '../document-preview-utils';
import type { MessageCardDownloadGuardProps } from '../MessageCardMedia';
import { getMessageCardAttachmentPreviewConfig } from './message-card-preview-config';
import {
  blurActiveAttachmentPreviewElement,
  getAttachmentPreviewDialogPaperSx,
  getAttachmentPreviewStageBg,
} from './message-card-attachment-preview';
import type {
  MessageCardPreviewItem,
  MessageCardPreviewNavigation,
} from './message-card-preview.types';
import { CoordinateAttachmentPreviewRenderer } from '../renderers/CoordinateAttachmentPreviewRenderer';
import { DocumentAttachmentPreviewRenderer } from '../renderers/DocumentAttachmentPreviewRenderer';
import { ImageAttachmentPreviewRenderer } from '../renderers/ImageAttachmentPreviewRenderer';
import { VideoAttachmentPreviewRenderer } from '../renderers/VideoAttachmentPreviewRenderer';

const isDownloadIdle = () => false;
const allowDownloadStart = () => true;

function getPreviewKind(item: MessageCardPreviewItem) {
  if (item.type === 'document') return item.value.kind;
  return item.type === 'coordinate' ? 'coordinate-map' : item.type;
}

export function MessageCardAttachmentPreviewDialog({
  item,
  navigation,
  onClose,
  isDownloadStarting = isDownloadIdle,
  onDownloadStart = allowDownloadStart,
}: {
  item: MessageCardPreviewItem;
  navigation: MessageCardPreviewNavigation;
  onClose: () => void;
} & Partial<MessageCardDownloadGuardProps>) {
  const previewKind = getPreviewKind(item);
  const [fullscreenPreviewKind, setFullscreenPreviewKind] = useState<ReturnType<
    typeof getPreviewKind
  > | null>(null);
  const isFullscreen = fullscreenPreviewKind === previewKind;
  const setIsFullscreen = (value: boolean) => {
    setFullscreenPreviewKind(value ? previewKind : null);
  };

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (isFullscreen && event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setFullscreenPreviewKind(null);
        return;
      }
      if (navigation.count <= 1 || shouldIgnoreArrowNavigation(event.target)) return;

      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        event.stopPropagation();
        navigation.onPrevious();
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        event.stopPropagation();
        navigation.onNext();
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isFullscreen, navigation]);

  const closeDialog = () => {
    blurActiveAttachmentPreviewElement();
    setFullscreenPreviewKind(null);
    onClose();
  };
  const previewConfig = getMessageCardAttachmentPreviewConfig(previewKind);
  const dialogIsFullscreen = isFullscreen && previewConfig.supportsFullscreen;
  const paperSx: Record<string, unknown> = {
    display: 'flex',
    flexDirection: 'column',
    width: dialogIsFullscreen ? '100vw' : { xs: '100vw', sm: '92vw' },
    height: dialogIsFullscreen ? '100svh' : { xs: '100svh', sm: '92svh' },
    maxWidth: dialogIsFullscreen ? '100vw' : { xs: '100vw', sm: '92vw' },
    maxHeight: dialogIsFullscreen ? '100svh' : { xs: '100svh', sm: '92svh' },
    borderRadius: dialogIsFullscreen ? 0 : { xs: 0, sm: 2 },
    m: 0,
  };
  const rendererProps = {
    navigation,
    isFullscreen: dialogIsFullscreen,
    onFullscreenChange: setIsFullscreen,
    onClose: closeDialog,
    isDownloadStarting,
    onDownloadStart,
  };

  return (
    <Dialog
      open
      onClose={(_event, reason) => {
        if (reason === 'escapeKeyDown' && dialogIsFullscreen) {
          setFullscreenPreviewKind(null);
          return;
        }
        closeDialog();
      }}
      maxWidth={false}
      fullScreen={dialogIsFullscreen}
      disableEscapeKeyDown={dialogIsFullscreen && previewConfig.disableEscapeKeyDownInFullscreen}
      disableRestoreFocus={previewConfig.disableRestoreFocus}
      PaperProps={{
        'aria-label': 'Перегляд вкладення',
        sx: {
          ...getAttachmentPreviewDialogPaperSx(dialogIsFullscreen),
          backgroundColor: (theme) => getAttachmentPreviewStageBg(theme),
          ...paperSx,
        },
      }}
      BackdropProps={{
        sx: { backgroundColor: 'rgba(0, 0, 0, 0.8)' },
      }}
    >
      {item.type === 'image' ? (
        <ImageAttachmentPreviewRenderer image={item.value} {...rendererProps} />
      ) : item.type === 'video' ? (
        <VideoAttachmentPreviewRenderer video={item.value} {...rendererProps} />
      ) : item.type === 'document' ? (
        <DocumentAttachmentPreviewRenderer document={item.value} {...rendererProps} />
      ) : (
        <CoordinateAttachmentPreviewRenderer
          points={item.points}
          activePoint={item.value}
          navigation={navigation}
          isFullscreen={dialogIsFullscreen}
          onFullscreenChange={setIsFullscreen}
          onClose={closeDialog}
        />
      )}
    </Dialog>
  );
}
