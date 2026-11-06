import MoreVertIcon from '@mui/icons-material/MoreVert';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import PauseIcon from '@mui/icons-material/Pause';
import VolumeOffIcon from '@mui/icons-material/VolumeOff';
import VolumeUpIcon from '@mui/icons-material/VolumeUp';
import FullscreenIcon from '@mui/icons-material/Fullscreen';
import FullscreenExitIcon from '@mui/icons-material/FullscreenExit';
import { Box, IconButton, Menu, MenuItem, Slider, Typography } from '@mui/material';
import { alpha } from '@mui/material/styles';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { VideoPlayerState } from '../message-card-video-utils';
import { formatVideoTime } from '../message-card-video-utils';
import { getAttachmentPreviewStageBg } from '../attachment-preview/message-card-attachment-preview';
import { MessageCardAttachmentPreviewHeader } from '../attachment-preview/MessageCardAttachmentPreviewHeader';
import { AttachmentPreviewMobileCarouselNav } from '../attachment-preview/MessageCardAttachmentPreviewControls';
import type { MessageCardPreviewNavigation } from '../attachment-preview/message-card-preview.types';
import type { MessageCardDownloadGuardProps } from '../MessageCardMedia';

const buttonSx = { color: 'inherit', width: 44, height: 44, flexShrink: 0 };

const panelSx = {
  position: 'absolute',
  color: 'text.primary',
  pointerEvents: 'auto',
  backgroundColor: (theme: import('@mui/material/styles').Theme) =>
    alpha(getAttachmentPreviewStageBg(theme), 0.82),
} as const;

type MobileControlsProps = {
  fileName: string;
  navigation: MessageCardPreviewNavigation;
  playerState: VideoPlayerState;
  visible: boolean;
  onClose: () => void;
  onPlayPause: () => void;
  onSeek: (time: number) => void;
  onMuteToggle: () => void;
  onRateChange: (rate: 0.5 | 1 | 1.5 | 2) => void;
  onDownload: () => void;
  downloadKey: string;
  openHref: string | null;
  onInfo: (anchor: HTMLButtonElement) => void;
  additionalActions?: ReactNode;
  onMenuChange: (open: boolean) => void;
  dismissChildOverlay?: number;
  onInteraction: (busy: boolean) => void;
  playbackAvailable: boolean;
  fullscreenSupported: boolean;
  fullscreenActive: boolean;
  fullscreenReady: boolean;
  onFullscreen: () => void;
} & MessageCardDownloadGuardProps;

export function VideoAttachmentPreviewMobileControls({
  fileName,
  navigation,
  playerState,
  visible,
  onClose,
  onPlayPause,
  onSeek,
  onMuteToggle,
  onRateChange,
  onDownload,
  downloadKey,
  isDownloadStarting,
  onDownloadStart,
  openHref,
  onInfo,
  additionalActions,
  onMenuChange,
  dismissChildOverlay,
  onInteraction,
  playbackAvailable,
  fullscreenSupported,
  fullscreenActive,
  fullscreenReady,
  onFullscreen,
}: MobileControlsProps) {
  const [menuAnchor, setMenuAnchor] = useState<HTMLButtonElement | null>(null);
  useLayoutEffect(() => {
    const viewport = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    if (!viewport) return;
    const content = viewport.content;
    const directives = content
      .split(',')
      .filter((directive) => !/^\s*viewport-fit\s*=/i.test(directive));
    viewport.content = [...directives, 'viewport-fit=cover'].join(',');
    return () => {
      viewport.content = content;
    };
  }, []);
  const pointerActive = useRef(false);
  const focusActive = useRef(false);
  useEffect(() => () => onInteraction(false), [onInteraction]);
  useLayoutEffect(() => {
    onMenuChange(menuAnchor !== null);
    return () => onMenuChange(false);
  }, [menuAnchor, onMenuChange]);
  useLayoutEffect(() => setMenuAnchor(null), [dismissChildOverlay]);
  const menuButton = (
    <IconButton
      aria-label="Додаткові дії"
      aria-haspopup="menu"
      aria-expanded={menuAnchor !== null}
      onClick={(event) => setMenuAnchor(event.currentTarget)}
      size="small"
      sx={{ color: 'text.secondary' }}
    >
      <MoreVertIcon fontSize="small" />
    </IconButton>
  );

  return (
    <Box
      data-mobile-video-controls
      data-visible={String(visible)}
      onPointerDown={() => {
        pointerActive.current = true;
        onInteraction(true);
      }}
      onPointerUp={(event) => {
        pointerActive.current = false;
        if (event.pointerType === 'touch' && event.currentTarget.contains(document.activeElement))
          (document.activeElement as HTMLElement | null)?.blur();
        onInteraction(focusActive.current);
      }}
      onPointerCancel={() => {
        pointerActive.current = false;
        onInteraction(focusActive.current);
      }}
      onFocusCapture={() => {
        focusActive.current = true;
        onInteraction(true);
      }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          focusActive.current = false;
          onInteraction(pointerActive.current);
        }
      }}
      sx={{
        position: 'absolute',
        inset: 0,
        zIndex: 12,
        pointerEvents: 'none',
        visibility: visible ? 'visible' : 'hidden',
        opacity: visible ? 1 : 0,
        transition: 'opacity 150ms ease-out, visibility 150ms ease-out',
        '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
      }}
    >
      <Box
        sx={{
          ...panelSx,
          top: 0,
          left: 0,
          right: 0,
          backgroundColor: 'background.paper',
          pt: 'env(safe-area-inset-top, 0px)',
          pl: 'env(safe-area-inset-left, 0px)',
          pr: 'env(safe-area-inset-right, 0px)',
          ...(fullscreenActive
            ? {
                '@media (orientation: portrait)': {
                  pt: 'calc(8px + env(safe-area-inset-top, 0px))',
                  pl: 'calc(8px + env(safe-area-inset-left, 0px))',
                  pr: 'calc(8px + env(safe-area-inset-right, 0px))',
                },
              }
            : {}),
        }}
      >
        <MessageCardAttachmentPreviewHeader
          fileName={fileName}
          navigation={navigation}
          onClose={onClose}
          onInfoClick={(event) => onInfo(event.currentTarget)}
          download={{ onDownload }}
          downloadKey={downloadKey}
          isDownloadStarting={isDownloadStarting}
          onDownloadStart={onDownloadStart}
          openHref={openHref}
          additionalActions={additionalActions}
          overflowAction={menuButton}
        />
      </Box>
      <Box
        sx={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 1,
          pointerEvents: 'none',
        }}
      >
        {navigation.count > 1 ? (
          <Box
            data-video-carousel
            sx={{
              ...panelSx,
              position: 'relative',
              display: { xs: 'flex', sm: 'none' },
              width: 'max-content',
              borderRadius: 2,
              px: 0.5,
              py: 0.25,
            }}
          >
            <AttachmentPreviewMobileCarouselNav navigation={navigation} themed />
          </Box>
        ) : null}
        <MobileVideoTimeline
          onPlayPause={onPlayPause}
          playbackAvailable={playbackAvailable}
          playerState={playerState}
          onSeek={onSeek}
          onMuteToggle={onMuteToggle}
          fullscreenSupported={fullscreenSupported}
          fullscreenActive={fullscreenActive}
          fullscreenReady={fullscreenReady}
          onFullscreen={onFullscreen}
        />
      </Box>
      <MobileVideoMenu
        anchorEl={menuAnchor}
        onClose={() => setMenuAnchor(null)}
        playerState={playerState}
        onRateChange={onRateChange}
      />
    </Box>
  );
}

function MobileVideoTimeline({
  fullscreenSupported,
  fullscreenActive,
  fullscreenReady,
  onFullscreen,
  onPlayPause,
  playbackAvailable,
  playerState,
  onSeek,
  onMuteToggle,
}: Pick<
  MobileControlsProps,
  | 'playerState'
  | 'onSeek'
  | 'onMuteToggle'
  | 'onPlayPause'
  | 'playbackAvailable'
  | 'fullscreenSupported'
  | 'fullscreenActive'
  | 'fullscreenReady'
  | 'onFullscreen'
>) {
  return (
    <Box
      data-mobile-video-playback-panel
      sx={{
        ...panelSx,
        position: 'relative',
        width: '100%',
        pl: 'max(16px, env(safe-area-inset-left, 0px))',
        pr: 'max(16px, env(safe-area-inset-right, 0px))',
        pt: 0.5,
        pb: 'max(8px, env(safe-area-inset-bottom, 0px))',
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        columnGap: 0.5,
      }}
    >
      <Slider
        data-mobile-video-timeline
        aria-label="Позиція відтворення"
        min={0}
        max={playerState.duration || 1}
        value={Math.min(playerState.currentTime, playerState.duration || 1)}
        disabled={!playerState.duration}
        onChange={(_, value) => onSeek(value as number)}
        sx={{
          color: 'text.primary',
          py: 2,
          touchAction: 'none',
          order: 0,
          flexBasis: '100%',
          '@media (min-width: 480px)': { order: 3, flex: '1 1 0', width: 'auto', mx: 1.5 },
        }}
      />
      {playbackAvailable ? (
        <IconButton
          aria-label={playerState.isPlaying ? 'Пауза' : 'Відтворення'}
          onClick={onPlayPause}
          sx={{ ...buttonSx, order: 1 }}
        >
          {playerState.isPlaying ? <PauseIcon /> : <PlayArrowIcon />}
        </IconButton>
      ) : null}
      <Typography
        data-video-playback-time
        variant="caption"
        sx={{
          flex: 1,
          order: 2,
          fontVariantNumeric: 'tabular-nums',
          whiteSpace: 'nowrap',
          '@media (min-width: 480px)': { flex: '0 0 auto' },
        }}
      >
        {formatVideoTime(playerState.currentTime)} / {formatVideoTime(playerState.duration)}
      </Typography>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, order: 4, flexShrink: 0 }}>
        <IconButton
          aria-label={playerState.muted ? 'Увімкнути звук' : 'Вимкнути звук'}
          onClick={onMuteToggle}
          sx={buttonSx}
        >
          {playerState.muted ? <VolumeOffIcon /> : <VolumeUpIcon />}
        </IconButton>
        {fullscreenSupported ? (
          <IconButton
            aria-label={fullscreenActive ? 'Вийти з повноекранного режиму' : 'На весь екран'}
            disabled={!fullscreenActive && !fullscreenReady}
            onClick={onFullscreen}
            sx={buttonSx}
          >
            {fullscreenActive ? <FullscreenExitIcon /> : <FullscreenIcon />}
          </IconButton>
        ) : null}
      </Box>
    </Box>
  );
}

function MobileVideoMenu({
  anchorEl,
  onClose,
  playerState,
  onRateChange,
}: Pick<MobileControlsProps, 'playerState' | 'onRateChange'> & {
  anchorEl: HTMLButtonElement | null;
  onClose: () => void;
}) {
  return (
    <Menu anchorEl={anchorEl} open={anchorEl !== null} onClose={() => onClose()}>
      {([0.5, 1, 1.5, 2] as const).map((rate) => (
        <MenuItem
          key={rate}
          selected={playerState.playbackRate === rate}
          onClick={() => {
            onRateChange(rate);
            onClose();
          }}
        >
          Швидкість {rate}×
        </MenuItem>
      ))}
    </Menu>
  );
}
