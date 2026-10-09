export type FilePreviewSource<Geodata = unknown> = {
  key: string;
  fileName: string;
  extension: string;
  contentType: string;
  sizeBytes: number | null;
  originalHref: string;
  mediaHref?: string;
  geodata?: Geodata;
};

export type FilePreviewLifecycleProps = {
  signal: AbortSignal;
  onError: (error: unknown) => void;
  registerCleanup: (cleanup: () => void) => () => void;
  isCurrent: () => boolean;
};

export type FilePreviewCapabilityProps = {
  zoom?: number;
  onZoomChange?: (zoom: number) => void;
  fullscreen?: boolean;
  onFullscreenChange?: (fullscreen: boolean) => void;
};

export function normalizeFilePreviewMetadata({
  fileName,
  extension,
  contentType,
}: {
  fileName: string;
  extension?: string | null;
  contentType?: string | null;
}) {
  const name = fileName.trim();
  const suffix = /\.([^./\\]+)$/.exec(name)?.[1];
  return {
    fileName: name,
    extension: (suffix ?? extension ?? '').trim().replace(/^\./, '').toLowerCase(),
    contentType: (contentType ?? '').split(';', 1)[0].trim().toLowerCase(),
  };
}

export class FilePreviewRenderError extends Error {
  constructor(
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = 'FilePreviewRenderError';
  }
}
