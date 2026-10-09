import AddIcon from '@mui/icons-material/Add';
import RemoveIcon from '@mui/icons-material/Remove';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import { Box, CircularProgress, IconButton } from '@mui/material';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AudioPlayerHost } from '../../../components/audio-player/AudioPlayerHost';
import { DEVICE_MEDIA_PREVIEW_TIMEOUT_MS } from '../../../services/api/device-file-preview';
import type { FilePreviewLifecycleProps } from '../../shared/message-card/attachment-preview/file-preview-source';
import { clamp } from '../../shared/message-card/message-card-image-utils';
import {
  getNextWheelZoom,
  isInteractivePreviewTarget,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEP,
} from '../../shared/message-card/message-card-image-preview-utils';
import { VideoFilePreview } from '../../shared/message-card/renderers/VideoFilePreview';
import type { DeviceFilePreviewSource } from '../use-device-file-preview';
import { useDeviceMediaPreview } from '../use-device-media-preview';

type MediaPreviewProps = {
  source: DeviceFilePreviewSource;
  kind: 'audio' | 'video';
  lifecycle: FilePreviewLifecycleProps;
  checkAccess: () => Promise<boolean>;
  onRetry: () => void;
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
}: MediaPreviewProps) {
  const media = useDeviceMediaPreview({ source, lifecycle, checkAccess });
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
  if (kind === 'audio')
    return (
      <AudioPlayerHost
        href={snapshot.href}
        displayName={source.fileName}
        storageKey={`echo-device-file-preview-${source.key}`}
        onBeforeMount={media.prepareAudio}
        suppressInitialAutoplay
        previewSizing
      />
    );
  return (
    <DeviceVideoPreview
      key={source.key}
      href={snapshot.href}
      lifecycle={lifecycle}
      media={media}
      onRetry={onRetry}
    />
  );
}

function DeviceVideoPreview({
  href,
  lifecycle,
  media,
  onRetry,
}: {
  href: string;
  lifecycle: FilePreviewLifecycleProps;
  media: ReturnType<typeof useDeviceMediaPreview>;
  onRetry: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ zoom: ZOOM_MIN, pan: { x: 0, y: 0 } });
  const viewRef = useRef(view);
  viewRef.current = view;
  const drag = useRef<{ pointerId: number; x: number; y: number; origin: Pan } | null>(null);
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
    if (!lifecycle.isCurrent()) return;
    void videoRef.current?.play().catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === 'NotAllowedError'))
        void media.reportNativeFailure();
    });
  };
  return (
    <Box
      ref={stageRef}
      aria-label="Відеоперегляд"
      sx={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '100%',
        height: '100%',
        overflow: 'hidden',
      }}
      onPointerDown={(event) => {
        const video = videoRef.current;
        if (
          view.zoom <= ZOOM_MIN ||
          event.button !== 0 ||
          isInteractivePreviewTarget(event.target) ||
          !video ||
          event.clientY >= video.getBoundingClientRect().bottom - 48
        )
          return;
        drag.current = {
          pointerId: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          origin: view.pan,
        };
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }}
      onPointerMove={(event) => {
        const origin = drag.current;
        if (!origin || origin.pointerId !== event.pointerId) return;
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
        drag.current = null;
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
    >
      <VideoFilePreview
        src={href}
        videoRef={videoRef}
        nativeControls
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
        }}
        onError={(event) => {
          media.attachNative(event.currentTarget);
          void media.reportNativeFailure(event.currentTarget.error?.code);
        }}
      />
      <Box
        role="group"
        aria-label="Масштаб відео"
        sx={{
          position: 'absolute',
          top: 8,
          left: 8,
          display: 'flex',
          alignItems: 'center',
          bgcolor: 'background.paper',
          borderRadius: 1,
        }}
      >
        <IconButton
          aria-label="Зменшити масштаб"
          disabled={view.zoom <= ZOOM_MIN}
          onClick={() => changeZoom((zoom) => zoom - ZOOM_STEP)}
        >
          <RemoveIcon />
        </IconButton>
        <span>{Math.round(view.zoom)}%</span>
        <IconButton
          aria-label="Збільшити масштаб"
          disabled={view.zoom >= ZOOM_MAX}
          onClick={() => changeZoom((zoom) => zoom + ZOOM_STEP)}
        >
          <AddIcon />
        </IconButton>
        <IconButton
          aria-label="Скинути масштаб"
          disabled={view.zoom === ZOOM_MIN}
          onClick={() => changeZoom(ZOOM_MIN)}
        >
          <RestartAltIcon />
        </IconButton>
      </Box>
    </Box>
  );
}
