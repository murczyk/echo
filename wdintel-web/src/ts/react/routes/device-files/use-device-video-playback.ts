import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { VideoPlayerState } from '../shared/message-card/message-card-video-utils';

export function useDeviceVideoPlayback({
  videoRef,
  isCurrent,
  requestPlay,
}: {
  videoRef: RefObject<HTMLVideoElement>;
  isCurrent: () => boolean;
  requestPlay: () => void;
}) {
  const current = useRef(isCurrent);
  current.current = isCurrent;
  const controlsRef = useRef<HTMLDivElement>(null);
  const [playerState, setPlayerState] = useState<VideoPlayerState>({
    isPlaying: false,
    currentTime: 0,
    duration: 0,
    volume: 1,
    muted: false,
    playbackRate: 1,
  });
  const [controlsVisible, setControlsVisible] = useState(true);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const revealControls = useCallback(() => {
    setControlsVisible(true);
    if (hideTimer.current !== null) clearTimeout(hideTimer.current);
    if (playerState.isPlaying) {
      hideTimer.current = setTimeout(() => {
        if (!(
          controlsRef.current?.contains(document.activeElement) &&
          document.activeElement?.matches(':focus-visible')
        ))
          setControlsVisible(false);
        hideTimer.current = null;
      }, 2000);
    }
  }, [playerState.isPlaying]);
  useEffect(() => {
    revealControls();
    return () => {
      if (hideTimer.current !== null) clearTimeout(hideTimer.current);
    };
  }, [revealControls]);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const update = () => {
      if (!current.current() || videoRef.current !== video) return;
      setPlayerState({
        isPlaying: !video.paused && !video.ended,
        currentTime: Number.isFinite(video.currentTime) ? video.currentTime : 0,
        duration: Number.isFinite(video.duration) ? video.duration : 0,
        volume: video.volume,
        muted: video.muted,
        playbackRate: video.playbackRate as VideoPlayerState['playbackRate'],
      });
    };
    const events = [
      'play',
      'pause',
      'ended',
      'timeupdate',
      'loadedmetadata',
      'durationchange',
      'volumechange',
      'ratechange',
      'seeked',
    ];
    events.forEach((name) => video.addEventListener(name, update));
    update();
    return () => events.forEach((name) => video.removeEventListener(name, update));
  }, [videoRef]);
  const withVideo = (action: (video: HTMLVideoElement) => void) => {
    const video = videoRef.current;
    if (current.current() && video) action(video);
  };
  return {
    controlsRef,
    controlsVisible,
    revealControls,
    controls: {
      playerState,
      onPlayPause: () =>
        withVideo((video) => {
          if (video.paused) requestPlay();
          else video.pause();
        }),
      onSeek: (time: number) =>
        withVideo((video) => {
          video.currentTime = time;
        }),
      onVolumeChange: (volume: number) =>
        withVideo((video) => {
          video.volume = volume;
          if (volume > 0) video.muted = false;
        }),
      onMuteToggle: () =>
        withVideo((video) => {
          video.muted = !video.muted;
        }),
      onRateChange: (rate: VideoPlayerState['playbackRate']) =>
        withVideo((video) => {
          video.playbackRate = rate;
        }),
    },
  };
}
