import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import PauseIcon from '@mui/icons-material/Pause';
import StopIcon from '@mui/icons-material/Stop';
import VolumeUpIcon from '@mui/icons-material/VolumeUp';
import VolumeOffIcon from '@mui/icons-material/VolumeOff';
import { Box, IconButton, MenuItem, Select, Slider, Tooltip, type SelectChangeEvent } from '@mui/material';
import { useState, useRef, useEffect } from 'react';

export function PlayPauseButton({ isPlaying, onPlayPause }: { isPlaying: boolean; onPlayPause: () => void }) {
  return (
    <Tooltip title={isPlaying ? "Пауза" : "Відтворення"} enterDelay={300}>
      <IconButton size="small" onClick={onPlayPause} sx={{ color: 'inherit' }}>
        {isPlaying ? <PauseIcon /> : <PlayArrowIcon />}
      </IconButton>
    </Tooltip>
  );
}

export function StopButton({ onStop }: { onStop: () => void }) {
  return (
    <Tooltip title="Стоп" enterDelay={300}>
      <IconButton size="small" onClick={onStop} sx={{ color: 'inherit' }}>
        <StopIcon />
      </IconButton>
    </Tooltip>
  );
}

export function VolumeControl({
  volume,
  muted,
  onVolumeChange,
  onMuteToggle,
}: {
  volume: number;
  muted: boolean;
  onVolumeChange: (value: number) => void;
  onMuteToggle: () => void;
}) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', width: { xs: 80, sm: 120 }, gap: 1 }}>
      <Tooltip title={muted || volume === 0 ? "Увімкнути звук" : "Вимкнути звук"} enterDelay={300}>
        <IconButton size="small" onClick={onMuteToggle} sx={{ color: 'inherit', p: 0.5 }}>
          {muted || volume === 0 ? <VolumeOffIcon fontSize="small" /> : <VolumeUpIcon fontSize="small" />}
        </IconButton>
      </Tooltip>
      <Slider
        size="small"
        min={0}
        max={1}
        step={0.05}
        value={muted ? 0 : volume}
        onChange={(_, val) => onVolumeChange(val as number)}
        sx={{
          color: 'primary.light',
          '& .MuiSlider-thumb': {
            width: 12,
            height: 12,
          }
        }}
      />
    </Box>
  );
}

export function SpeedSelect({
  playbackRate,
  onRateChange,
}: {
  playbackRate: 0.5 | 1 | 1.5 | 2;
  onRateChange: (rate: 0.5 | 1 | 1.5 | 2) => void;
}) {
  return (
    <Select
      size="small"
      value={playbackRate}
      onChange={(e: SelectChangeEvent<number>) => onRateChange(Number(e.target.value) as 0.5 | 1 | 1.5 | 2)}
      variant="outlined"
      sx={{
        color: 'text.secondary',
        '& .MuiOutlinedInput-notchedOutline': { borderColor: 'divider' },
        '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: 'text.secondary' },
        '& .MuiSvgIcon-root': { color: 'text.secondary' },
        '&.Mui-focused .MuiOutlinedInput-notchedOutline': { borderColor: 'primary.light' },
        fontSize: '0.85rem',
        height: 28,
      }}
      MenuProps={{
        PaperProps: {
          sx: { backgroundColor: 'background.paper', color: 'text.primary' },
        }
      }}
    >
      <MenuItem value={0.5}>0.5x</MenuItem>
      <MenuItem value={1}>1x</MenuItem>
      <MenuItem value={1.5}>1.5x</MenuItem>
      <MenuItem value={2}>2x</MenuItem>
    </Select>
  );
}

export function VideoProgressSlider({
  currentTime,
  duration,
  onSeek,
}: {
  currentTime: number;
  duration: number;
  onSeek: (time: number) => void;
  videoRef?: React.RefObject<HTMLVideoElement>;
}) {
  const isDragging = useRef(false);
  const [localTime, setLocalTime] = useState(currentTime);

  useEffect(() => {
    if (!isDragging.current) {
      setLocalTime(currentTime);
    }
  }, [currentTime]);

  return (
    <Slider
      size="small"
      min={0}
      max={duration || 100}
      value={localTime}
      onChange={(_, value) => {
        isDragging.current = true;
        setLocalTime(value as number);
        onSeek(value as number);
      }}
      onChangeCommitted={(_, value) => {
        isDragging.current = false;
        onSeek(value as number);
      }}
      disabled={!duration}
      sx={{
        color: 'primary.main',
        padding: '0',
        height: 4,
        '& .MuiSlider-track': {
          transition: isDragging.current ? 'none' : 'width 0.25s linear, left 0.25s linear',
        },
        '& .MuiSlider-thumb': {
          width: 12,
          height: 12,
          transition: isDragging.current ? 'none' : 'left 0.25s linear, box-shadow 0.15s ease-out, width 0.15s ease-out, height 0.15s ease-out, box-shadow 0.15s ease-out',
          '&.Mui-active': {
            width: 16,
            height: 16,
          },
        },
        '& .MuiSlider-rail': {
          opacity: 0.28,
        },
      }}
    />
  );
}
