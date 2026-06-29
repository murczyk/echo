import DownloadIcon from '@mui/icons-material/Download';
import FullscreenExitIcon from '@mui/icons-material/FullscreenExit';
import FullscreenIcon from '@mui/icons-material/Fullscreen';
import { Box, Button, DialogActions, IconButton, Tooltip, Typography } from '@mui/material';
import type { VideoPreviewSource, VideoPlayerState } from './message-card-video-utils';
import { formatVideoTime, downloadOriginalVideo } from './message-card-video-utils';
import { PlayPauseButton, StopButton, VolumeControl, SpeedSelect, VideoProgressSlider } from './MessageCardVideoControls';

export function MessageCardVideoPreviewActions({
  video,
  playerState,
  onPlayPause,
  onStop,
  onVolumeChange,
  onMuteToggle,
  onRateChange,
  onSeek,
  onToggleFullscreen,
  onClose,
  videoRef,
}: {
  video: VideoPreviewSource;
  playerState: VideoPlayerState;
  onPlayPause: () => void;
  onStop: () => void;
  onVolumeChange: (volume: number) => void;
  onMuteToggle: () => void;
  onRateChange: (rate: 0.5 | 1 | 1.5 | 2) => void;
  onSeek: (time: number) => void;
  onToggleFullscreen: () => void;
  onClose: () => void;
  videoRef: React.RefObject<HTMLVideoElement>;
}) {
  const { isPlaying, currentTime, duration, volume, muted, playbackRate, isFullscreen } = playerState;

  return (
    <DialogActions
      sx={{
        px: 2,
        py: '20px',
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        borderTop: '1px solid',
        borderColor: 'rgba(244, 247, 251, 0.12)',
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flex: 1, minWidth: 0 }}>
        <PlayPauseButton isPlaying={isPlaying} onPlayPause={onPlayPause} />
        <StopButton onStop={onStop} />
        <VolumeControl volume={volume} muted={muted} onVolumeChange={onVolumeChange} onMuteToggle={onMuteToggle} />
        
        <Box sx={{ flex: 1, mx: { xs: 1, sm: 2 }, minWidth: 100, display: 'flex', alignItems: 'center' }}>
          <VideoProgressSlider currentTime={currentTime} duration={duration} onSeek={onSeek} videoRef={videoRef} />
        </Box>

        <Typography variant="body2" sx={{ whiteSpace: 'nowrap', color: 'rgba(244, 247, 251, 0.8)', fontFamily: 'monospace', mr: { xs: 1, sm: 2 } }}>
          {formatVideoTime(currentTime)} / {formatVideoTime(duration)}
        </Typography>

        <Box sx={{ mr: { xs: 0, sm: 1 } }}>
          <SpeedSelect playbackRate={playbackRate} onRateChange={onRateChange} />
        </Box>

        <Tooltip title="Завантажити" enterDelay={300}>
          <IconButton size="small" onClick={() => downloadOriginalVideo(video)} sx={{ color: 'inherit' }}>
            <DownloadIcon />
          </IconButton>
        </Tooltip>
        <Tooltip title={isFullscreen ? 'Вийти з повноекранного режиму' : 'Повноекранний режим'} enterDelay={300}>
          <IconButton size="small" onClick={onToggleFullscreen} sx={{ color: 'inherit' }}>
            {isFullscreen ? <FullscreenExitIcon /> : <FullscreenIcon />}
          </IconButton>
        </Tooltip>
      </Box>

      <Button onClick={onClose} sx={{ flexShrink: 0, ml: 1 }}>Закрити</Button>
    </DialogActions>
  );
}
