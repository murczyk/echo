import DownloadIcon from '@mui/icons-material/Download';
import InfoIcon from '@mui/icons-material/Info';
import FullscreenExitIcon from '@mui/icons-material/FullscreenExit';
import FullscreenIcon from '@mui/icons-material/Fullscreen';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import {
  Box,
  Button,
  CircularProgress,
  DialogActions,
  IconButton,
  Tooltip,
  Typography,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import type { VideoPreviewSource, VideoPlayerState } from './message-card-video-utils';
import { formatVideoTime, downloadOriginalVideo } from './message-card-video-utils';
import {
  PlayPauseButton,
  StopButton,
  VolumeControl,
  SpeedSelect,
  VideoProgressSlider,
} from './MessageCardVideoControls';
import { MessageCardDisabledControlCursorWrapper } from './MessageCardDisabledControlCursorWrapper';
import { getMessageCardPreviewActionBarSx } from './message-card-preview-shell';

export function MessageCardVideoPreviewControls({
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
          <IconButton size="small" onClick={onToggleFullscreen} sx={{ color: 'inherit' }}>
            {isFullscreen ? <FullscreenExitIcon /> : <FullscreenIcon />}
          </IconButton>
        </Tooltip>
      ) : null}
    </Box>
  );
}

export function MessageCardVideoPreviewActions({
  video,
  openHref,
  onClose,
  hasCarousel,
  resolvedIndex,
  videoCount,
  onGoToPrevious,
  onGoToNext,
  onInfoClick,
  downloadKey,
  isDownloadStarting,
  onDownloadStart,
}: {
  video: VideoPreviewSource;
  openHref?: string | null;
  onClose: () => void;
  hasCarousel: boolean;
  resolvedIndex: number;
  videoCount: number;
  onGoToPrevious?: () => void;
  onGoToNext?: () => void;
  onInfoClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  downloadKey: string;
  isDownloadStarting: (downloadKey: string) => boolean;
  onDownloadStart: (downloadKey: string) => boolean;
}) {
  const downloading = isDownloadStarting(downloadKey);
  const theme = useTheme();
  return (
    <DialogActions sx={getMessageCardPreviewActionBarSx(theme)}>
      <Box
        sx={{
          flex: 1,
          display: 'flex',
          justifyContent: 'flex-start',
          gap: 0.5,
          minWidth: 0,
          flexWrap: 'wrap',
        }}
      >
        <Tooltip title="Інформація" enterDelay={300}>
          <IconButton
            aria-label="Інформація"
            size="small"
            onClick={onInfoClick}
            sx={{ color: 'text.secondary' }}
          >
            <InfoIcon />
          </IconButton>
        </Tooltip>
        {typeof openHref === 'string' && openHref.trim() !== '' ? (
          <Tooltip title="Відкрити в новій вкладці" enterDelay={300}>
            <IconButton
              component="a"
              href={openHref}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Відкрити в новій вкладці"
              size="small"
              sx={{ color: 'text.secondary' }}
            >
              <OpenInNewIcon />
            </IconButton>
          </Tooltip>
        ) : null}
        <Tooltip title={downloading ? 'Завантаження…' : 'Завантажити'} enterDelay={300}>
          <MessageCardDisabledControlCursorWrapper disabled={downloading}>
            <IconButton
              aria-label={downloading ? 'Завантаження…' : 'Завантажити'}
              aria-busy={downloading}
              disabled={downloading}
              size="small"
              onClick={(event) => {
                if (isDownloadStarting(downloadKey) || !onDownloadStart(downloadKey)) {
                  event.preventDefault();
                  return;
                }
                downloadOriginalVideo(video);
              }}
              sx={{ color: 'text.secondary' }}
            >
              {downloading ? (
                <CircularProgress size={14} aria-label="Завантаження…" />
              ) : (
                <DownloadIcon />
              )}
            </IconButton>
          </MessageCardDisabledControlCursorWrapper>
        </Tooltip>
      </Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        {hasCarousel && (
          <>
            <Tooltip title="Попереднє" enterDelay={300}>
              <IconButton size="small" onClick={onGoToPrevious} sx={{ color: 'text.secondary' }}>
                <ChevronLeftIcon />
              </IconButton>
            </Tooltip>
            <Typography
              variant="body2"
              sx={{
                backgroundColor: 'action.hover',
                color: 'text.primary',
                fontWeight: 700,
                letterSpacing: 0,
                px: 1,
                py: 0.25,
                borderRadius: 1,
              }}
            >
              {`${resolvedIndex + 1} / ${videoCount}`}
            </Typography>
            <Tooltip title="Наступне" enterDelay={300}>
              <IconButton size="small" onClick={onGoToNext} sx={{ color: 'text.secondary' }}>
                <ChevronRightIcon />
              </IconButton>
            </Tooltip>
          </>
        )}
      </Box>
      <Box sx={{ flex: '0 0 auto', display: 'flex', justifyContent: 'flex-end' }}>
        <Button onClick={onClose} sx={{ flexShrink: 0, ml: 1 }}>
          Закрити
        </Button>
      </Box>
    </DialogActions>
  );
}
