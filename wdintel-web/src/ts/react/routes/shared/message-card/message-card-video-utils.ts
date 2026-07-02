export type VideoPreviewSource = {
  id: string;
  name: string;
  source: File | Blob | string;
  mimeType?: string;
  sizeBytes?: number;
  lastModified?: number;
};

export type VideoPreviewError = {
  code: string;
  message: string;
  cause?: unknown;
};

export type VideoPlayerState = {
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  muted: boolean;
  playbackRate: 0.5 | 1 | 1.5 | 2;
  isFullscreen: boolean;
  error?: VideoPreviewError;
};

export function formatVideoTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '00:00';
  }

  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  if (hours > 0) {
    return [String(hours), String(minutes).padStart(2, '0'), String(secs).padStart(2, '0')].join(
      ':',
    );
  }

  return [String(minutes).padStart(2, '0'), String(secs).padStart(2, '0')].join(':');
}

export function downloadOriginalVideo(video: VideoPreviewSource) {
  if (typeof video.source === 'string') {
    const anchor = document.createElement('a');
    anchor.href = video.source;
    anchor.download = video.name;
    anchor.rel = 'noopener noreferrer';
    anchor.click();
    return;
  }

  const url = URL.createObjectURL(video.source);

  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = video.name;
  anchor.click();

  // Give the browser some time to start the download before revoking
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 1000);
}
