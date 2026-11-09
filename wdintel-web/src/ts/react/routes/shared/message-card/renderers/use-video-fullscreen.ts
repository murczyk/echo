import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

type WebKitVideo = HTMLVideoElement & {
  webkitEnterFullscreen?: () => void;
  webkitExitFullscreen?: () => void;
  webkitSupportsFullscreen?: boolean;
};

let fullscreenOwner: symbol | null = null;

export function useVideoFullscreen(
  videoRef: RefObject<HTMLVideoElement>,
  src: string | null,
  onError: () => void,
) {
  const owner = useRef(Symbol('video-fullscreen'));
  const mounted = useRef(false);
  const pending = useRef(false);
  const reportError = useRef(onError);
  reportError.current = onError;
  const nativeVideo = useRef<WebKitVideo | null>(null);
  const [standardActive, setStandardActive] = useState(false);
  const [nativeActive, setNativeActive] = useState(false);

  const syncFullscreen = useCallback(() => {
    const ownsFullscreen = fullscreenOwner === owner.current;
    const active = ownsFullscreen && document.fullscreenElement === document.documentElement;
    if (mounted.current) setStandardActive(active);
    if (ownsFullscreen && !active && !pending.current) fullscreenOwner = null;
  }, []);

  const exitOwnedFullscreen = useCallback(async () => {
    if (fullscreenOwner !== owner.current) return;
    if (document.fullscreenElement === document.documentElement) {
      await document.exitFullscreen();
      if (fullscreenOwner === owner.current) fullscreenOwner = null;
    } else if (!pending.current) fullscreenOwner = null;
  }, []);

  useEffect(() => {
    mounted.current = true;
    document.addEventListener('fullscreenchange', syncFullscreen);
    return () => {
      mounted.current = false;
      document.removeEventListener('fullscreenchange', syncFullscreen);
      void exitOwnedFullscreen().catch(() => {});
    };
  }, [exitOwnedFullscreen, syncFullscreen]);

  useEffect(() => {
    const video = videoRef.current as WebKitVideo | null;
    if (!video) return;
    const restoreControls = () => {
      if (nativeVideo.current !== video) return;
      nativeVideo.current = null;
      video.controls = false;
      if (mounted.current) setNativeActive(false);
    };
    const handleBegin = () => {
      nativeVideo.current = video;
      video.controls = true;
      setNativeActive(true);
    };
    video.addEventListener('webkitbeginfullscreen', handleBegin);
    video.addEventListener('webkitendfullscreen', restoreControls);
    return () => {
      video.removeEventListener('webkitbeginfullscreen', handleBegin);
      video.removeEventListener('webkitendfullscreen', restoreControls);
      if (nativeVideo.current !== video) return;
      try {
        video.webkitExitFullscreen?.();
      } catch {
        // The video may already have left the native player during unmount.
      }
      restoreControls();
    };
  }, [src, videoRef]);

  const standardSupported =
    typeof document.documentElement.requestFullscreen === 'function' &&
    document.fullscreenEnabled !== false;
  const video = videoRef.current as WebKitVideo | null;
  const supported =
    standardSupported ||
    (typeof video?.webkitEnterFullscreen === 'function' &&
      video.webkitSupportsFullscreen !== false);

  const toggle = useCallback(() => {
    const video = videoRef.current as WebKitVideo | null;
    if (pending.current) return;
    if (!standardSupported) {
      if (!video) return;
      try {
        if (nativeVideo.current === video) video.webkitExitFullscreen?.();
        else if (video.webkitEnterFullscreen) {
          nativeVideo.current = video;
          video.controls = true;
          setNativeActive(true);
          video.webkitEnterFullscreen();
        }
      } catch {
        nativeVideo.current = null;
        video.controls = false;
        setNativeActive(false);
        reportError.current();
      }
      return;
    }
    if (!standardActive && !video) return;
    pending.current = true;
    let request: Promise<void>;
    try {
      if (standardActive) request = exitOwnedFullscreen();
      else {
        fullscreenOwner = owner.current;
        // Include portalled menus and notifications alongside our player.
        request = document.documentElement.requestFullscreen({ navigationUI: 'hide' });
      }
    } catch (error) {
      request = Promise.reject(error);
    }
    void request
      .then(() => {
        if (!mounted.current) return exitOwnedFullscreen();
      })
      .catch(() => {
        if (mounted.current) reportError.current();
      })
      .finally(() => {
        pending.current = false;
        syncFullscreen();
      });
  }, [exitOwnedFullscreen, standardActive, standardSupported, syncFullscreen, videoRef]);

  return { supported, active: standardActive || nativeActive, native: nativeActive, toggle };
}
