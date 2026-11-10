import { Box, CircularProgress } from '@mui/material';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AudioPlayerHost } from '../../../components/audio-player/AudioPlayerHost';
import { DEVICE_MEDIA_PREVIEW_TIMEOUT_MS } from '../../../services/api/device-file-preview';
import type { FilePreviewLifecycleProps } from '../../shared/message-card/attachment-preview/file-preview-source';
import { AudioPreviewContent } from '../../shared/message-card/attachment-preview/AudioPreviewContent';
import { AttachmentPreviewZoomBadge } from '../../shared/message-card/attachment-preview/AttachmentPreviewZoomBadge';
import { AttachmentPreviewPlaybackControls } from '../../shared/message-card/attachment-preview/MessageCardAttachmentPreviewControls';
import { getAttachmentPreviewStageBg } from '../../shared/message-card/attachment-preview/message-card-attachment-preview';
import { clamp } from '../../shared/message-card/message-card-image-utils';
import {
  getNextWheelZoom,
  isInteractivePreviewTarget,
  ZOOM_MAX,
  ZOOM_MIN,
  ATTACHMENT_PREVIEW_DRAG_THRESHOLD_PX,
} from '../../shared/message-card/message-card-image-preview-utils';
import { VideoFilePreview } from '../../shared/message-card/renderers/VideoFilePreview';
import type { DeviceFilePreviewSource } from '../use-device-file-preview';
import { useDeviceMediaPreview } from '../use-device-media-preview';
import { useDeviceVideoPlayback } from '../use-device-video-playback';
import type { DeviceFileVideoPlayback } from '../types';

type MediaPreviewProps = {
  source: DeviceFilePreviewSource;
  kind: 'audio' | 'video';
  lifecycle: FilePreviewLifecycleProps;
  checkAccess: () => Promise<boolean>;
  onRetry: () => void;
  onDurationChange?: (seconds: number) => void;
  videoPlayback?: DeviceFileVideoPlayback | null;
};
type Pan = { x: number; y: number };
function boundedPan(
  pan: Pan,
  zoom: number,
  stage: HTMLElement | null,
  video: HTMLVideoElement | null,
): Pan {
  const maxX = Math.max(
    0,
    (((video?.clientWidth ?? 0) * zoom) / 100 - (stage?.clientWidth ?? 0)) / 2,
  );
  const maxY = Math.max(
    0,
    (((video?.clientHeight ?? 0) * zoom) / 100 - (stage?.clientHeight ?? 0)) / 2,
  );
  return { x: clamp(pan.x, -maxX, maxX), y: clamp(pan.y, -maxY, maxY) };
}

export function DeviceFileMediaPreview({
  source,
  kind,
  lifecycle,
  checkAccess,
  onRetry,
  onDurationChange,
  videoPlayback,
}: MediaPreviewProps) {
  const media = useDeviceMediaPreview({ source, lifecycle, checkAccess, onDurationChange });
  const [audioOnlySource, setAudioOnlySource] = useState<string | null>(null);
  const snapshot = media.snapshot;
  if (snapshot?.phase === 'empty') return <p>Файл порожній</p>;
  if (snapshot?.phase === 'error') return <p role="alert">{snapshot.message}</p>;
  if (!snapshot?.href)
    return (
      <div role="status">
        <CircularProgress size={22} />
        {snapshot?.phase === 'checking'
          ? 'Перевірка доступу до медіафайлу'
          : 'Завантаження медіафайлу'}
      </div>
    );
  if (kind === 'audio' || audioOnlySource === source.key)
    return (
      <Box sx={{ height: '100%', backgroundColor: getAttachmentPreviewStageBg }}>
        <AudioPreviewContent>
          <AudioPlayerHost
            href={snapshot.href}
            displayName={source.fileName}
            storageKey={`echo-device-file-preview-${source.key}`}
            onBeforeMount={media.prepareAudio}
            suppressInitialAutoplay
            previewSizing
          />
        </AudioPreviewContent>
      </Box>
    );
  return (
    <DeviceVideoPreview
      key={source.key}
      href={snapshot.href}
      videoPlayback={videoPlayback?.sourceKey === source.key ? videoPlayback : null}
      lifecycle={lifecycle}
      media={media}
      onRetry={onRetry}
      onMetadata={(element) => {
        void media.detectAudioOnly(element).then((audioOnly) => {
          if (audioOnly && lifecycle.isCurrent() && !lifecycle.signal.aborted)
            setAudioOnlySource(source.key);
        });
      }}
    />
  );
}

function DeviceVideoPreview({
  href,
  lifecycle,
  media,
  onRetry,
  onMetadata,
  videoPlayback,
}: {
  href: string;
  lifecycle: FilePreviewLifecycleProps;
  media: ReturnType<typeof useDeviceMediaPreview>;
  onRetry: () => void;
  onMetadata: (element: HTMLVideoElement) => void;
  videoPlayback?: DeviceFileVideoPlayback | null;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const restoredPlayback = useRef(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ zoom: ZOOM_MIN, pan: { x: 0, y: 0 } });
  const viewRef = useRef(view);
  viewRef.current = view;
  const drag = useRef<{
    pointerId: number;
    x: number;
    y: number;
    origin: Pan;
    moved: boolean;
  } | null>(null);
  const suppressClick = useRef(false);
  const changeZoom = useCallback((next: number | ((current: number) => number)) => {
    setView((current) => {
      const zoom = clamp(typeof next === 'number' ? next : next(current.zoom), ZOOM_MIN, ZOOM_MAX);
      return { zoom, pan: boundedPan(current.pan, zoom, stageRef.current, videoRef.current) };
    });
  }, []);
  const timeout = useCallback(() => {
    void media.reportNativeFailure(undefined, true);
  }, [media.reportNativeFailure]);
  useLayoutEffect(() => {
    media.attachNative(videoRef.current);
  }, [href, media.attachNative]);
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    let initialDistance = 0,
      initialZoom = ZOOM_MIN;
    const wheel = (event: WheelEvent) => {
      if (isInteractivePreviewTarget(event.target) || (!event.ctrlKey && !event.metaKey)) return;
      event.preventDefault();
      changeZoom((zoom) =>
        getNextWheelZoom(zoom, event.deltaY, event.deltaMode, stage.clientHeight),
      );
    };
    const touchStart = (event: TouchEvent) => {
      if (event.touches.length !== 2 || isInteractivePreviewTarget(event.target)) return;
      const [first, second] = event.touches;
      initialDistance = Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY);
      initialZoom = viewRef.current.zoom;
      drag.current = null;
    };
    const touchMove = (event: TouchEvent) => {
      if (event.touches.length !== 2 || initialDistance <= 0) return;
      event.preventDefault();
      const [first, second] = event.touches;
      changeZoom(
        (initialZoom * Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY)) /
          initialDistance,
      );
    };
    const touchEnd = () => {
      initialDistance = 0;
    };
    const gestureStart = (event: Event) => {
      if (isInteractivePreviewTarget(event.target)) return;
      event.preventDefault();
      initialZoom = viewRef.current.zoom;
    };
    const gestureChange = (event: Event) => {
      if (isInteractivePreviewTarget(event.target)) return;
      const scale = (event as Event & { scale?: number }).scale;
      if (typeof scale === 'number') {
        event.preventDefault();
        changeZoom(initialZoom * scale);
      }
    };
    const resize = new ResizeObserver(() => changeZoom((zoom) => zoom));
    resize.observe(stage);
    if (videoRef.current) resize.observe(videoRef.current);
    stage.addEventListener('wheel', wheel, { passive: false });
    stage.addEventListener('touchstart', touchStart, { passive: true });
    stage.addEventListener('touchmove', touchMove, { passive: false });
    stage.addEventListener('touchend', touchEnd);
    stage.addEventListener('touchcancel', touchEnd);
    stage.addEventListener('gesturestart', gestureStart, { passive: false });
    stage.addEventListener('gesturechange', gestureChange, { passive: false });
    return () => {
      resize.disconnect();
      stage.removeEventListener('wheel', wheel);
      stage.removeEventListener('touchstart', touchStart);
      stage.removeEventListener('touchmove', touchMove);
      stage.removeEventListener('touchend', touchEnd);
      stage.removeEventListener('touchcancel', touchEnd);
      stage.removeEventListener('gesturestart', gestureStart);
      stage.removeEventListener('gesturechange', gestureChange);
    };
  }, [changeZoom]);
  const requestPlay = () => {
    const video = videoRef.current;
    if (!video || !lifecycle.isCurrent()) return;
    void video.play().catch((error: unknown) => {
      if (!lifecycle.isCurrent() || videoRef.current !== video) return;
      if (!(
        error instanceof DOMException && ['NotAllowedError', 'AbortError'].includes(error.name)
      ))
        void media.reportNativeFailure();
    });
  };
  const playback = useDeviceVideoPlayback({
    videoRef,
    isCurrent: lifecycle.isCurrent,
    requestPlay,
  });
  return (
    <Box
      className="flex h-full min-h-0 flex-col"
      sx={{ backgroundColor: getAttachmentPreviewStageBg }}
      onPointerMove={playback.revealControls}
      onFocusCapture={playback.revealControls}
      onBlurCapture={playback.revealControls}
    >
      <Box
        ref={stageRef}
        aria-label="Відеоперегляд"
        sx={{
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '100%',
          flex: '1 1 0',
          minHeight: 0,
          overflow: 'hidden',
          backgroundColor: getAttachmentPreviewStageBg,
        }}
        onDoubleClick={(event) => {
          if (isInteractivePreviewTarget(event.target)) return;
          changeZoom((zoom) => (zoom > ZOOM_MIN ? ZOOM_MIN : 150));
        }}
        onClickCapture={(event) => {
          if (suppressClick.current && !isInteractivePreviewTarget(event.target)) {
            event.preventDefault();
            event.stopPropagation();
          }
          suppressClick.current = false;
        }}
        onPointerDown={(event) => {
          suppressClick.current = false;
          playback.revealControls();
          const video = videoRef.current;
          if (
            view.zoom <= ZOOM_MIN ||
            event.button !== 0 ||
            isInteractivePreviewTarget(event.target) ||
            !video
          )
            return;
          drag.current = {
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            origin: view.pan,
            moved: false,
          };
        }}
        onPointerMove={(event) => {
          const origin = drag.current;
          if (!origin || origin.pointerId !== event.pointerId) return;
          if (!origin.moved) {
            if (
              Math.hypot(event.clientX - origin.x, event.clientY - origin.y) <=
              ATTACHMENT_PREVIEW_DRAG_THRESHOLD_PX
            )
              return;
            origin.moved = true;
            event.currentTarget.setPointerCapture?.(event.pointerId);
          }
          setView((current) => ({
            ...current,
            pan: boundedPan(
              {
                x: origin.origin.x + event.clientX - origin.x,
                y: origin.origin.y + event.clientY - origin.y,
              },
              current.zoom,
              stageRef.current,
              videoRef.current,
            ),
          }));
        }}
        onPointerUp={() => {
          suppressClick.current = drag.current?.moved ?? false;
          drag.current = null;
        }}
        onPointerCancel={() => {
          suppressClick.current = false;
          drag.current = null;
        }}
      >
        <VideoFilePreview
          src={href}
          videoRef={videoRef}
          zoom={view.zoom}
          pan={view.pan}
          loadTimeoutMs={DEVICE_MEDIA_PREVIEW_TIMEOUT_MS}
          needsPlayGesture={false}
          onRetry={onRetry}
          onRequestPlay={requestPlay}
          onLoadTimeout={timeout}
          onPlay={() => {}}
          onPause={() => {}}
          onEnded={() => {}}
          onLoadedMetadata={(event) => {
            media.attachNative(event.currentTarget);
            changeZoom((zoom) => zoom);
            onMetadata(event.currentTarget);
            const video = event.currentTarget;
            if (videoPlayback && !restoredPlayback.current && lifecycle.isCurrent()) {
              restoredPlayback.current = true;
              video.volume = videoPlayback.volume;
              video.muted = videoPlayback.muted;
              video.playbackRate = videoPlayback.playbackRate;
              video.currentTime = Math.max(
                0,
                Math.min(
                  videoPlayback.currentTime,
                  Number.isFinite(video.duration) ? video.duration : videoPlayback.currentTime,
                ),
              );
              if (!videoPlayback.paused) requestPlay();
            }
          }}
          onError={(event) => {
            media.attachNative(event.currentTarget);
            void media.reportNativeFailure(event.currentTarget.error?.code);
          }}
        />
        <AttachmentPreviewZoomBadge zoom={view.zoom} onResetZoom={() => changeZoom(ZOOM_MIN)} />
      </Box>
      <Box
        ref={playback.controlsRef}
        data-attachment-preview-video-controls
        onDoubleClick={(event) => event.stopPropagation()}
        sx={{
          flexShrink: 0,
          width: '100%',
          opacity: playback.controlsVisible ? 1 : 0,
          transition: 'opacity 300ms ease-out',
          pointerEvents: playback.controlsVisible ? 'auto' : 'none',
        }}
      >
        <AttachmentPreviewPlaybackControls {...playback.controls} />
      </Box>
    </Box>
  );
}
