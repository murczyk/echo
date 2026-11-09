import RecordVoiceOverIcon from '@mui/icons-material/RecordVoiceOver';
import { Typography } from '@mui/material';
import type { ReactNode } from 'react';

export function AudioPreviewContent({
  children,
  transcription = '',
}: {
  children: ReactNode;
  transcription?: string;
}) {
  return (
    <div
      className="flex h-full w-full min-h-0 overflow-y-auto overscroll-contain touch-pan-y"
      style={{
        paddingTop: 'var(--attachment-preview-content-inset, 0px)',
        paddingBottom: 'var(--attachment-preview-content-bottom-inset, 0px)',
      }}
    >
      <div
        data-audio-preview-content
        className="m-auto flex w-[min(685px,calc(100%-32px))] flex-col py-[24px]"
      >
        <div data-audio-preview-player className="mx-auto w-full">
          {children}
        </div>
        {transcription !== '' ? (
          <div
            data-attachment-preview-scroll
            data-audio-preview-transcription
            className="mt-[32px] flex min-w-0 gap-2 text-sm leading-5 select-text"
          >
            <RecordVoiceOverIcon className="audio-transcription-icon mt-0.5 shrink-0" aria-hidden />
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
  );
}
