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
import { AudioAttachmentPreviewRenderer } from '../renderers/AudioAttachmentPreviewRenderer';
import type { AttachmentPreviewReportDraft } from './ReportTextPreview';
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
  if (previewKind === 'audio') return 'Перегляд аудіо';
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
  reportDraft,
}: {
  item: MessageCardPreviewItem;
  navigation: MessageCardPreviewNavigation;
  onClose: () => void;
  imageEditing?: ImageEditingCapability;
  initialAction?: 'edit-image';
  reportDraft?: AttachmentPreviewReportDraft;
} & Partial<MessageCardDownloadGuardProps>) {
  const previewKind = getPreviewKind(item);
  const dialogLabel = getPreviewDialogLabel(previewKind);
  const [isEditing, setIsEditing] = useState(false);
  const [pendingInitialAction, setPendingInitialAction] = useState(initialAction);
  const [childOverlayOpen, setChildOverlayOpen] = useState(false);
  const childOverlayOpenRef = useRef(false);
  const [reportVisible, setReportVisible] = useState(false);
  const [dismissChildOverlay, setDismissChildOverlay] = useState(0);
  const editorEscapeHandlerRef = useRef<ImageEditorEscapeHandler | null>(null);
  const previewConfig = getMessageCardAttachmentPreviewConfig(previewKind);
  const registerEditorEscapeHandler = useCallback<RegisterImageEditorEscapeHandler>((handler) => {
    editorEscapeHandlerRef.current = handler;
  }, []);
  const consumeInitialAction = useCallback(() => setPendingInitialAction(undefined), []);
  const onChildOverlayChange = useCallback((open: boolean) => {
    childOverlayOpenRef.current = open;
    setChildOverlayOpen(open);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (childOverlayOpenRef.current) {
          consumeEvent(event);
          childOverlayOpenRef.current = false;
          setChildOverlayOpen(false);
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
  }, [childOverlayOpen, isEditing, navigation]);

  const closeDialog = () => {
    blurActiveAttachmentPreviewElement();
    setReportVisible(false);
    onClose();
  };
  const paperSx: Record<string, unknown> = {
    display: 'flex',
    flexDirection: 'column',
    width: '100vw',
    height: '100svh',
    maxWidth: '100vw',
    maxHeight: '100svh',
    borderRadius: 0,
    m: 0,
  };
  const rendererProps = {
    navigation,
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
      fullScreen
      disableEscapeKeyDown
      disableRestoreFocus={previewConfig.disableRestoreFocus}
      PaperProps={{
        'aria-label': dialogLabel,
        sx: {
          ...getAttachmentPreviewDialogPaperSx(),
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
          initialAction={pendingInitialAction}
          onInitialActionConsumed={consumeInitialAction}
          onEditModeChange={setIsEditing}
          registerEditorEscapeHandler={registerEditorEscapeHandler}
          onChildOverlayChange={onChildOverlayChange}
          dismissChildOverlay={dismissChildOverlay}
          reportDraft={reportDraft}
          reportVisible={reportVisible}
          onReportVisibleChange={setReportVisible}
          {...rendererProps}
        />
      ) : item.type === 'video' ? (
        <VideoAttachmentPreviewRenderer
          video={item.value}
          onChildOverlayChange={onChildOverlayChange}
          dismissChildOverlay={dismissChildOverlay}
          reportDraft={reportDraft}
          reportVisible={reportVisible}
          onReportVisibleChange={setReportVisible}
          {...rendererProps}
        />
      ) : item.type === 'audio' ? (
        <AudioAttachmentPreviewRenderer
          audio={item.value}
          onChildOverlayChange={onChildOverlayChange}
          dismissChildOverlay={dismissChildOverlay}
          reportDraft={reportDraft}
          reportVisible={reportVisible}
          onReportVisibleChange={setReportVisible}
          {...rendererProps}
        />
      ) : item.type === 'document' ? (
        <DocumentAttachmentPreviewRenderer
          document={item.value}
          reportDraft={reportDraft}
          reportVisible={reportVisible}
          onReportVisibleChange={setReportVisible}
          {...rendererProps}
        />
      ) : (
        <CoordinateAttachmentPreviewRenderer
          points={item.points}
          navigation={navigation}
          onClose={closeDialog}
        />
      )}
    </Dialog>
  );
}
