import ZoomInIcon from '@mui/icons-material/ZoomIn';
import ZoomOutIcon from '@mui/icons-material/ZoomOut';
import { Box, IconButton, Slider, Tooltip, Typography } from '@mui/material';

import type { VideoPlayerState } from '../message-card-video-utils';
import { formatVideoTime } from '../message-card-video-utils';
import {
  PlayPauseButton,
  SpeedSelect,
  VideoProgressSlider,
  VolumeControl,
} from '../MessageCardVideoControls';

export function AttachmentPreviewZoomControls({
  zoom,
  min,
  max,
  buttonStep,
  sliderStep = buttonStep,
  marks,
  onZoomChange,
}: {
  zoom: number;
  min: number;
  max: number;
  buttonStep: number;
  sliderStep?: number;
  marks: number[];
  isFullscreen?: boolean;
  canFullscreen?: boolean;
  onZoomChange: (zoom: number) => void;
  onToggleFullscreen?: () => void;
}) {
  return (
    <Box
      sx={{
        display: 'flex',
        justifyContent: 'center',
        pb: 2,
        width: '100%',
        pointerEvents: 'none',
      }}
    >
      <Box
        sx={{
          pointerEvents: 'auto',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 1.5,
          backgroundColor: 'rgba(18, 18, 18, 0.75)',
          backdropFilter: 'blur(12px)',
          borderRadius: 3,
          boxShadow: '0 4px 20px rgba(0, 0, 0, 0.25)',
          py: 1,
          px: 2.5,
          color: '#fff',
        }}
      >
        <Tooltip title="Зменшити" enterDelay={300}>
          <span>
            <IconButton
              aria-label="Зменшити"
              size="small"
              onClick={() => onZoomChange(zoom - buttonStep)}
              disabled={zoom <= min}
              sx={{
                color: 'rgba(255, 255, 255, 0.85)',
                '&.Mui-disabled': { color: 'rgba(255, 255, 255, 0.3)' },
                '&:hover': { backgroundColor: 'rgba(255, 255, 255, 0.1)' },
              }}
            >
              <ZoomOutIcon />
            </IconButton>
          </span>
        </Tooltip>
        <Slider
          size="small"
          value={zoom}
          min={min}
          max={max}
          step={sliderStep}
          marks={marks.map((value) => ({ value }))}
          aria-label="Масштаб"
          onChange={(_, value) => onZoomChange(Array.isArray(value) ? (value[0] ?? min) : value)}
          sx={{
            width: { xs: 140, sm: 220 },
            color: 'primary.light',
            padding: 0,
            height: 4,
            '& .MuiSlider-track': { border: 'none' },
            '& .MuiSlider-thumb': {
              width: 12,
              height: 12,
              backgroundColor: '#fff',
              '&.Mui-active': { width: 16, height: 16 },
            },
            '& .MuiSlider-rail': { opacity: 0.3, backgroundColor: '#fff' },
            '& .MuiSlider-mark': {
              width: 2,
              height: 4,
              backgroundColor: 'rgba(255, 255, 255, 0.5)',
            },
          }}
        />
        <Tooltip title="Збільшити" enterDelay={300}>
          <span>
            <IconButton
              aria-label="Збільшити"
              size="small"
              onClick={() => onZoomChange(zoom + buttonStep)}
              disabled={zoom >= max}
              sx={{
                color: 'rgba(255, 255, 255, 0.85)',
                '&.Mui-disabled': { color: 'rgba(255, 255, 255, 0.3)' },
                '&:hover': { backgroundColor: 'rgba(255, 255, 255, 0.1)' },
              }}
            >
              <ZoomInIcon />
            </IconButton>
          </span>
        </Tooltip>
        <Typography
          variant="caption"
          className="font-mono"
          sx={{
            color: 'rgba(255, 255, 255, 0.85)',
            minWidth: 44,
            textAlign: 'center',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {Math.round(zoom)}%
        </Typography>
      </Box>
    </Box>
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
  canFullscreen?: boolean;
  onPlayPause: () => void;
  onStop?: () => void;
  onVolumeChange: (volume: number) => void;
  onMuteToggle: () => void;
  onRateChange: (rate: 0.5 | 1 | 1.5 | 2) => void;
  onSeek: (time: number) => void;
  onToggleFullscreen?: () => void;
  videoRef?: React.RefObject<HTMLVideoElement>;
}) {
  const { isPlaying, currentTime, duration, volume, muted, playbackRate } = playerState;

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        width: '100%',
        backgroundColor: 'rgba(18, 18, 18, 0.55)',
        backdropFilter: 'blur(12px)',
        boxShadow: '0 -4px 20px rgba(0, 0, 0, 0.25)',
        color: '#fff',
        py: 1,
        px: 3,
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
          fontSize: 12,
          fontWeight: 600,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {formatVideoTime(currentTime)} / {formatVideoTime(duration)}
      </Typography>

      {/* 3. [=== Timeline Slider ===] */}
      <Box sx={{ flex: 1, minWidth: 100, display: 'flex', alignItems: 'center' }}>
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
