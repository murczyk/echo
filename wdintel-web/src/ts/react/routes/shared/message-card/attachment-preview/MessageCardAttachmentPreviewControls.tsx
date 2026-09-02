import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import { Box, IconButton, Stack, Tooltip, Typography } from '@mui/material';

import type { MessageCardPreviewNavigation } from './message-card-preview.types';
import type { VideoPlayerState } from '../message-card-video-utils';
import { formatVideoTime } from '../message-card-video-utils';
import {
  PlayPauseButton,
  SpeedSelect,
  VideoProgressSlider,
  VolumeControl,
} from '../MessageCardVideoControls';

export function AttachmentPreviewMobileCarouselNav({
  navigation,
}: {
  navigation: MessageCardPreviewNavigation;
}) {
  if (navigation.count <= 1) return null;

  return (
    <Stack
      direction="row"
      spacing={1}
      alignItems="center"
      justifyContent="center"
      sx={{
        color: '#fff',
        py: 0.25,
      }}
    >
      <IconButton
        aria-label="Попереднє"
        size="small"
        onClick={navigation.onPrevious}
        sx={{
          color: 'rgba(255, 255, 255, 0.9)',
          '&:hover': { backgroundColor: 'rgba(255, 255, 255, 0.15)' },
        }}
        data-attachment-preview-nav="prev"
      >
        <ChevronLeftIcon fontSize="small" />
      </IconButton>
      <Typography
        variant="caption"
        className="font-mono"
        data-attachment-preview-counter
        sx={{
          px: 1.5,
          py: 0.5,
          borderRadius: 1,
          backgroundColor: 'rgba(255, 255, 255, 0.15)',
          color: '#fff',
          fontWeight: 700,
          fontSize: '0.85rem',
          whiteSpace: 'nowrap',
        }}
      >
        {`${navigation.index + 1} / ${navigation.count}`}
      </Typography>
      <IconButton
        aria-label="Наступне"
        size="small"
        onClick={navigation.onNext}
        sx={{
          color: 'rgba(255, 255, 255, 0.9)',
          '&:hover': { backgroundColor: 'rgba(255, 255, 255, 0.15)' },
        }}
        data-attachment-preview-nav="next"
      >
        <ChevronRightIcon fontSize="small" />
      </IconButton>
    </Stack>
  );
}

export function AttachmentPreviewPlaybackControls({
  playerState,
  onPlayPause,
  onVolumeChange,
  onMuteToggle,
  onRateChange,
  onSeek,
}: {
  playerState: VideoPlayerState;
  onPlayPause: () => void;
  onStop?: () => void;
  onVolumeChange: (volume: number) => void;
  onMuteToggle: () => void;
  onRateChange: (rate: 0.5 | 1 | 1.5 | 2) => void;
  onSeek: (time: number) => void;
  videoRef?: React.RefObject<HTMLVideoElement>;
}) {
  const { isPlaying, currentTime, duration, volume, muted, playbackRate } = playerState;

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: { xs: 1, sm: 2 },
        width: '100%',
        backgroundColor: 'rgba(18, 18, 18, 0.75)',
        backdropFilter: 'blur(12px)',
        boxShadow: '0 -4px 20px rgba(0, 0, 0, 0.25)',
        color: '#fff',
        py: { xs: 0.75, sm: 1 },
        px: { xs: 2, sm: 3 },
        borderRadius: 0,
      }}
    >
      {/* 1. [Play/Pause] */}
      <PlayPauseButton isPlaying={isPlaying} onPlayPause={onPlayPause} />

      {/* 2. [00:19 / 00:30] */}
      <Typography
        variant="caption"
        sx={{
          color: 'rgba(255, 255, 255, 0.9)',
          whiteSpace: 'nowrap',
          fontFamily: 'monospace',
          fontSize: { xs: 11, sm: 12 },
          fontWeight: 600,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {formatVideoTime(currentTime)} / {formatVideoTime(duration)}
      </Typography>

      {/* 3. [=== Timeline Slider ===] */}
      <Box sx={{ flex: 1, minWidth: { xs: 40, sm: 100 }, display: 'flex', alignItems: 'center' }}>
        <VideoProgressSlider currentTime={currentTime} duration={duration} onSeek={onSeek} />
      </Box>

      {/* 4. [Mute/Volume Slider] */}
      <VolumeControl
        volume={volume}
        muted={muted}
        onVolumeChange={onVolumeChange}
        onMuteToggle={onMuteToggle}
      />

      {/* 5. [1x / Speed Menu] */}
      <SpeedSelect playbackRate={playbackRate} onRateChange={onRateChange} />
    </Box>
  );
}
