import { Dialog } from '@mui/material';
import { useCallback, useEffect, useRef, useState } from 'react';

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
import type {
  ImageEditorEscapeHandler,
  ImageEditingCapability,
  RegisterImageEditorEscapeHandler,
} from '../../image-editor/image-editor.types';

const isDownloadIdle = () => false;
const allowDownloadStart = () => true;
const consumeEvent = (event: KeyboardEvent) => {
  event.preventDefault();
  event.stopPropagation();
};

function getPreviewKind(item: MessageCardPreviewItem) {
  if (item.type === 'document') return item.value.kind;
  return item.type === 'coordinate' ? 'coordinate-map' : item.type;
}

function getPreviewDialogLabel(previewKind: string) {
  if (previewKind === 'image') return 'Перегляд зображення';
  if (previewKind === 'video') return 'Перегляд відео';
  if (previewKind === 'coordinate-map') return 'Перегляд координат';
  return 'Перегляд документа';
}

export function MessageCardAttachmentPreviewDialog({
  item,
  navigation,
  onClose,
  isDownloadStarting = isDownloadIdle,
  onDownloadStart = allowDownloadStart,
  imageEditing,
  initialAction,
}: {
  item: MessageCardPreviewItem;
  navigation: MessageCardPreviewNavigation;
  onClose: () => void;
  imageEditing?: ImageEditingCapability;
  initialAction?: 'edit-image';
} & Partial<MessageCardDownloadGuardProps>) {
  const previewKind = getPreviewKind(item);
  const dialogLabel = getPreviewDialogLabel(previewKind);
  const [isFullscreen, setIsFullscreen] = useState(true);
  const [isEditing, setIsEditing] = useState(false);
  const [childOverlayOpen, setChildOverlayOpen] = useState(false);
  const [dismissChildOverlay, setDismissChildOverlay] = useState(0);
  const editorEscapeHandlerRef = useRef<ImageEditorEscapeHandler | null>(null);
  const previewConfig = getMessageCardAttachmentPreviewConfig(previewKind);
  const dialogIsFullscreen = isFullscreen && previewConfig.supportsFullscreen;
  const registerEditorEscapeHandler = useCallback<RegisterImageEditorEscapeHandler>((handler) => {
    editorEscapeHandlerRef.current = handler;
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (childOverlayOpen) {
          consumeEvent(event);
          setDismissChildOverlay((value) => value + 1);
          return;
        }
        const editorEscapeHandler = editorEscapeHandlerRef.current;
        if (editorEscapeHandler) {
          if (editorEscapeHandler(event)) consumeEvent(event);
          return;
        }
        if (isEditing) {
          consumeEvent(event);
          return;
        }
        consumeEvent(event);
        if (previewKind !== 'image' && previewConfig.layout === 'media' && dialogIsFullscreen) {
          setIsFullscreen(false);
          return;
        }
        closeDialog();
        return;
      }
      if (childOverlayOpen || navigation.count <= 1 || shouldIgnoreArrowNavigation(event.target))
        return;

      if (isEditing && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        consumeEvent(event);
        return;
      }

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
  }, [childOverlayOpen, dialogIsFullscreen, isEditing, navigation, previewConfig, previewKind]);

  const closeDialog = () => {
    blurActiveAttachmentPreviewElement();
    setIsFullscreen(true);
    onClose();
  };
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
      onClose={() => {
        if (!isEditing) closeDialog();
      }}
      maxWidth={false}
      fullScreen={dialogIsFullscreen}
      disableEscapeKeyDown
      disableRestoreFocus={previewConfig.disableRestoreFocus}
      PaperProps={{
        'aria-label': dialogLabel,
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
        <ImageAttachmentPreviewRenderer
          image={item.value}
          imageEditing={imageEditing}
          initialAction={initialAction}
          onEditModeChange={setIsEditing}
          registerEditorEscapeHandler={registerEditorEscapeHandler}
          onChildOverlayChange={setChildOverlayOpen}
          dismissChildOverlay={dismissChildOverlay}
          {...rendererProps}
        />
      ) : item.type === 'video' ? (
        <VideoAttachmentPreviewRenderer
          video={item.value}
          onChildOverlayChange={setChildOverlayOpen}
          dismissChildOverlay={dismissChildOverlay}
          {...rendererProps}
        />
      ) : item.type === 'document' ? (
        <DocumentAttachmentPreviewRenderer document={item.value} {...rendererProps} />
      ) : (
        <CoordinateAttachmentPreviewRenderer
          points={item.points}
          navigation={navigation}
          isFullscreen={dialogIsFullscreen}
          onFullscreenChange={setIsFullscreen}
          onClose={closeDialog}
        />
      )}
    </Dialog>
  );
}
