import FullscreenExitIcon from '@mui/icons-material/FullscreenExit';
import FullscreenIcon from '@mui/icons-material/Fullscreen';
import ZoomInIcon from '@mui/icons-material/ZoomIn';
import ZoomOutIcon from '@mui/icons-material/ZoomOut';
import { Box, IconButton, Slider, Tooltip, Typography } from '@mui/material';

import type { VideoPlayerState } from '../message-card-video-utils';
import { formatVideoTime } from '../message-card-video-utils';
import {
  PlayPauseButton,
  SpeedSelect,
  StopButton,
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
  isFullscreen,
  canFullscreen,
  onZoomChange,
  onToggleFullscreen,
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
        alignItems: 'center',
        justifyContent: 'center',
        gap: 1.5,
        flex: 1,
        minWidth: 0,
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
          '& .MuiSlider-mark': { width: 2, height: 4, backgroundColor: 'rgba(255, 255, 255, 0.5)' },
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
  );
}

export function AttachmentPreviewPlaybackControls({
  playerState,
  canFullscreen,
  onPlayPause,
  onStop,
  onVolumeChange,
  onMuteToggle,
  onRateChange,
  onSeek,
  onToggleFullscreen,
  videoRef,
}: {
  playerState: VideoPlayerState;
  canFullscreen: boolean;
  onPlayPause: () => void;
  onStop: () => void;
  onVolumeChange: (volume: number) => void;
  onMuteToggle: () => void;
  onRateChange: (rate: 0.5 | 1 | 1.5 | 2) => void;
  onSeek: (time: number) => void;
  onToggleFullscreen: () => void;
  videoRef: React.RefObject<HTMLVideoElement>;
}) {
  const { isPlaying, currentTime, duration, volume, muted, playbackRate, isFullscreen } =
    playerState;

  return (
    <Box
      sx={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: { xs: 0.5, sm: 1 },
        flex: 1,
        minWidth: 0,
        backgroundColor: 'rgba(18, 18, 18, 0.75)',
        backdropFilter: 'blur(12px)',
        boxShadow: '0 4px 20px rgba(0, 0, 0, 0.25)',
        color: '#fff',
        py: { xs: 1, sm: 1.25 },
        px: { xs: 1, sm: 2.5 },
        borderRadius: { xs: 0, sm: 3 },
      }}
    >
      <PlayPauseButton isPlaying={isPlaying} onPlayPause={onPlayPause} />
      <Box sx={{ display: { xs: 'none', sm: 'block' } }}>
        <StopButton onStop={onStop} />
      </Box>
      <Box
        sx={{
          flex: { xs: '1 1 100%', sm: 1 },
          mx: { xs: 0, sm: 2 },
          mb: { xs: 1, sm: 0 },
          minWidth: 100,
          display: 'flex',
          alignItems: 'center',
          order: { xs: -1, sm: 0 },
        }}
      >
        <VideoProgressSlider
          currentTime={currentTime}
          duration={duration}
          onSeek={onSeek}
          videoRef={videoRef}
        />
      </Box>
      <Typography
        variant="body2"
        sx={{
          color: 'rgba(255, 255, 255, 0.85)',
          whiteSpace: 'nowrap',
          fontFamily: 'monospace',
          mr: { xs: 'auto', sm: 1 },
          ml: { xs: 1, sm: 0 },
        }}
      >
        {formatVideoTime(currentTime)} / {formatVideoTime(duration)}
      </Typography>
      <VolumeControl
        volume={volume}
        muted={muted}
        onVolumeChange={onVolumeChange}
        onMuteToggle={onMuteToggle}
      />
      <Box sx={{ mr: { xs: 0, sm: 1 }, ml: { xs: 1, sm: 1 } }}>
        <SpeedSelect playbackRate={playbackRate} onRateChange={onRateChange} />
      </Box>
    </Box>
  );
}
