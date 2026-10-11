import { useEffect, useRef, type RefObject } from 'react';
import type Hls from 'hls.js';
import { handleUnauthorizedMediaResponse } from './message-card-media-fetch';

export function isVideoPreviewStream(src: string | null): boolean {
  return src?.endsWith('/playback/preview.m3u8') ?? false;
}

export function useVideoPreviewStream(
  src: string | null,
  videoRef: RefObject<HTMLVideoElement>,
  onReady: () => void,
  onError: (cause: unknown) => void,
) {
  const callbacks = useRef({ onReady, onError });
  callbacks.current = { onReady, onError };

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src || !isVideoPreviewStream(src)) return;
    let cancelled = false;
    let stream: Hls | undefined;

    void import('hls.js')
      .then(({ default: Hls }) => {
        if (cancelled) return;
        if (!Hls.isSupported()) {
          if (video.canPlayType('application/vnd.apple.mpegurl')) {
            video.src = src;
            callbacks.current.onReady();
            return;
          }
          throw new Error('Streaming video is unavailable in this browser');
        }
        stream = new Hls({
          maxBufferLength: 8,
          maxMaxBufferLength: 8,
          backBufferLength: 10,
          lowLatencyMode: false,
        });
        stream.on(Hls.Events.MANIFEST_PARSED, () => callbacks.current.onReady());
        stream.on(Hls.Events.ERROR, (_, data) => {
          if (data.response?.code === 401) {
            handleUnauthorizedMediaResponse(new Response(null, { status: 401 }), src);
          }
          if (!data.fatal) return;
          stream?.destroy();
          callbacks.current.onError(new Error(data.details));
        });
        stream.attachMedia(video);
        stream.loadSource(src);
      })
      .catch((cause: unknown) => {
        if (!cancelled) callbacks.current.onError(cause);
      });

    return () => {
      cancelled = true;
      stream?.destroy();
    };
  }, [src, videoRef]);
}
