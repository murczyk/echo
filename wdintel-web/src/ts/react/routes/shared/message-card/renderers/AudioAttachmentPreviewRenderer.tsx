import RecordVoiceOverIcon from '@mui/icons-material/RecordVoiceOver';
import { Typography } from '@mui/material';
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
    <MessageCardAttachmentPreviewStage kind="audio">
      <div className="flex h-full w-full min-h-0 overflow-y-auto overscroll-contain touch-pan-y">
        <div
          data-audio-preview-content
          className="m-auto flex w-[min(685px,calc(100%-32px))] flex-col py-[24px]"
        >
          <div data-audio-preview-player className="mx-auto w-full">
            <AudioPlayerHost
              href={audio.source}
              displayName={audio.fileName}
              mediaId={audio.mediaId ?? ''}
              sizeBytes={audio.sizeBytes ?? null}
              suppressInitialAutoplay
              previewSizing
            />
          </div>
          {transcription !== '' ? (
            <div
              data-attachment-preview-scroll
              data-audio-preview-transcription
              className="mt-[32px] flex min-w-0 gap-2 text-sm leading-5 select-text"
            >
              <RecordVoiceOverIcon
                className="audio-transcription-icon mt-0.5 shrink-0"
                aria-hidden
              />
              <Typography
                component="div"
                className="min-w-0 whitespace-pre-wrap wrap-break-word text-left text-sm leading-5"
                sx={{ fontSize: '14px', lineHeight: '20px' }}
              >
                {transcription}
              </Typography>
            </div>
          ) : null}
        </div>
      </div>
    </MessageCardAttachmentPreviewStage>
  );
  const source = (
    <ReportTextPreviewLayout source={stage} draft={reportDraft} visible={reportVisible} />
  );

  return (
    <MessageCardAttachmentPreviewLayout
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
