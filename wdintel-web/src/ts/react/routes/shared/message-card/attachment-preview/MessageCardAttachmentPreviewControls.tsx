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
  isFullscreen: boolean;
  canFullscreen: boolean;
  onZoomChange: (zoom: number) => void;
  onToggleFullscreen: () => void;
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
        backgroundColor: 'background.paper',
        py: 1.5,
        px: 3,
      }}
    >
      <Tooltip title="Зменшити" enterDelay={300}>
        <span>
          <IconButton
            aria-label="Зменшити"
            size="small"
            onClick={() => onZoomChange(zoom - buttonStep)}
            disabled={zoom <= min}
            sx={{ color: 'text.secondary' }}
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
          width: { xs: 180, sm: 260 },
          color: 'primary.main',
          padding: 0,
          height: 4,
          '& .MuiSlider-track': { border: 'none' },
          '& .MuiSlider-thumb': {
            width: 12,
            height: 12,
            '&.Mui-active': { width: 16, height: 16 },
          },
          '& .MuiSlider-rail': { opacity: 0.28 },
          '& .MuiSlider-mark': { width: 2, height: 4 },
        }}
      />
      <Tooltip title="Збільшити" enterDelay={300}>
        <span>
          <IconButton
            aria-label="Збільшити"
            size="small"
            onClick={() => onZoomChange(zoom + buttonStep)}
            disabled={zoom >= max}
            sx={{ color: 'text.secondary' }}
          >
            <ZoomInIcon />
          </IconButton>
        </span>
      </Tooltip>
      <Typography
        variant="caption"
        className="font-mono"
        sx={{
          color: 'text.secondary',
          minWidth: 44,
          textAlign: 'center',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {Math.round(zoom)}%
      </Typography>
      {canFullscreen ? (
        <Tooltip
          title={isFullscreen ? 'Вийти з повноекранного режиму' : 'Повноекранний режим'}
          enterDelay={300}
        >
          <IconButton
            aria-label={isFullscreen ? 'Вийти з повноекранного режиму' : 'Повноекранний режим'}
            size="small"
            onClick={onToggleFullscreen}
            sx={{ color: 'text.secondary' }}
          >
            {isFullscreen ? <FullscreenExitIcon /> : <FullscreenIcon />}
          </IconButton>
        </Tooltip>
      ) : null}
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
        backgroundColor: 'background.paper',
        py: { xs: 1, sm: 1.5 },
        px: { xs: 1, sm: 3 },
        borderRadius: { xs: 0, sm: 2 },
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
          color: 'text.secondary',
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
      {canFullscreen ? (
        <Tooltip
          title={isFullscreen ? 'Вийти з повноекранного режиму' : 'Повноекранний режим'}
          enterDelay={300}
        >
          <IconButton
            aria-label={isFullscreen ? 'Вийти з повноекранного режиму' : 'Повноекранний режим'}
            size="small"
            onClick={onToggleFullscreen}
            sx={{ color: 'inherit' }}
          >
            {isFullscreen ? <FullscreenExitIcon /> : <FullscreenIcon />}
          </IconButton>
        </Tooltip>
      ) : null}
    </Box>
  );
}
