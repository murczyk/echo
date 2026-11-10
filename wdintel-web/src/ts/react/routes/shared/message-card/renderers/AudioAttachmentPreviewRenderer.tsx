import { useMediaQuery } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { useEffect, useState } from 'react';

import { useAudioTranscriptionPreferences } from '../MessageCardAudioTranscription';
import {
  AudioPlayerHost,
  mediaDownloadAttr,
  messageCardMediaDownloadKey,
} from '../MessageCardMedia';
import { MessageCardAttachmentPreviewHeader } from '../attachment-preview/MessageCardAttachmentPreviewHeader';
import { MessageCardAttachmentPreviewInfoPopover } from '../attachment-preview/MessageCardAttachmentPreviewInfoPopover';
import { MessageCardAttachmentPreviewLayout } from '../attachment-preview/MessageCardAttachmentPreviewLayout';
import { MessageCardAttachmentPreviewStage } from '../attachment-preview/MessageCardAttachmentPreviewStage';
import { AudioPreviewContent } from '../attachment-preview/AudioPreviewContent';
import {
  ReportTextPreviewAction,
  ReportTextPreviewLayout,
  type AttachmentPreviewReportDraft,
  type AttachmentPreviewReportVisibility,
} from '../attachment-preview/ReportTextPreview';
import type { MessageCardDownloadGuardProps } from '../MessageCardMedia';
import type {
  AudioPreviewSource,
  MessageCardPreviewNavigation,
} from '../attachment-preview/message-card-preview.types';

export function AudioAttachmentPreviewRenderer({
  audio,
  navigation,
  onClose,
  isDownloadStarting,
  onDownloadStart,
  reportDraft,
  reportVisible,
  onReportVisibleChange,
  onChildOverlayChange,
  dismissChildOverlay,
}: {
  audio: AudioPreviewSource;
  navigation: MessageCardPreviewNavigation;
  onClose: () => void;
  reportDraft?: AttachmentPreviewReportDraft;
} & AttachmentPreviewReportVisibility &
  Partial<MessageCardDownloadGuardProps> & {
    onChildOverlayChange?: (open: boolean) => void;
    dismissChildOverlay?: number;
  }) {
  const [infoAnchor, setInfoAnchor] = useState<HTMLButtonElement | null>(null);
  const narrowViewport = useMediaQuery(useTheme().breakpoints.down('sm'));
  const touchLandscape = useMediaQuery('(pointer: coarse) and (max-height: 599.95px)');
  const { enabled: transcriptionEnabled } = useAudioTranscriptionPreferences();
  const transcription = transcriptionEnabled ? (audio.transcription?.trim() ?? '') : '';
  const downloadKey = messageCardMediaDownloadKey(audio.mediaId || audio.id);
  useEffect(() => {
    if ((dismissChildOverlay ?? 0) > 0) {
      onChildOverlayChange?.(false);
      setInfoAnchor(null);
    }
  }, [dismissChildOverlay, onChildOverlayChange]);
  useEffect(() => () => onChildOverlayChange?.(false), [onChildOverlayChange]);
  const stage = (
    <MessageCardAttachmentPreviewStage
      kind="audio"
      onPrimaryClick={(_, region) => {
        if (region === 'background') onClose();
      }}
    >
      <AudioPreviewContent transcription={transcription}>
        <AudioPlayerHost
          href={audio.source}
          displayName={audio.fileName}
          mediaId={audio.mediaId ?? ''}
          sizeBytes={audio.sizeBytes ?? null}
          suppressInitialAutoplay
          previewSizing
        />
      </AudioPreviewContent>
    </MessageCardAttachmentPreviewStage>
  );
  const source = (
    <ReportTextPreviewLayout source={stage} draft={reportDraft} visible={reportVisible} />
  );

  return (
    <MessageCardAttachmentPreviewLayout
      mobileChrome="toggle"
      onSwipeDismiss={narrowViewport || touchLandscape ? onClose : undefined}
      headerInFlow={reportDraft != null && reportVisible}
      navigation={navigation}
      header={
        <MessageCardAttachmentPreviewHeader
          fileName={audio.fileName}
          openHref={audio.source}
          download={{ href: audio.source, fileName: mediaDownloadAttr(audio.fileName, 'audio') }}
          downloadKey={downloadKey}
          navigation={navigation}
          onClose={onClose}
          onInfoClick={(event) => {
            onChildOverlayChange?.(true);
            setInfoAnchor(event.currentTarget);
          }}
          isDownloadStarting={isDownloadStarting}
          onDownloadStart={onDownloadStart}
          additionalActions={
            reportDraft ? (
              <ReportTextPreviewAction
                kind={reportDraft.kind}
                active={reportVisible}
                onClick={() => onReportVisibleChange(!reportVisible)}
              />
            ) : null
          }
        />
      }
      stage={source}
      infoPopover={
        <MessageCardAttachmentPreviewInfoPopover
          open={infoAnchor !== null}
          anchorEl={infoAnchor}
          onClose={() => {
            onChildOverlayChange?.(false);
            setInfoAnchor(null);
          }}
          fields={[
            { label: 'Назва', value: audio.fileName },
            ...(audio.contentType ? [{ label: 'Тип', value: audio.contentType }] : []),
            ...(audio.sizeBytes != null
              ? [{ label: 'Розмір', value: `${audio.sizeBytes} Б` }]
              : []),
            { label: 'URL', value: audio.source },
            ...(audio.mediaId ? [{ label: 'ID медіа', value: audio.mediaId }] : []),
          ]}
        />
      }
    />
  );
}
