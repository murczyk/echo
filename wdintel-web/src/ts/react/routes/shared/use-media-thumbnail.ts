import { useEffect, useRef, useState } from 'react';
import { AUTH_UNAUTHORIZED_EVENT } from '../../auth-redirect';
import { FORCED_NAVIGATION_EVENT } from '../../../browser/navigation-guard';
import { handleUnauthorizedMediaResponse } from './message-card/message-card-media-fetch';
import type { ThumbnailRequestScheduler } from './thumbnail-request-scheduler';

const THUMBNAIL_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const;
const THUMBNAIL_MAX_TRANSIENT_FAILURES = 4;
type ThumbnailState = 'loading' | 'loaded' | 'failed';
type ThumbnailSnapshot = { state: ThumbnailState; imageSrc: string | null };
type ThumbnailOptions = {
  cancelOnAuth?: boolean;
  retainLoadedOffscreen?: boolean;
  maxWaitMs?: number;
  requestTimeoutMs?: number;
  scheduler?: ThumbnailRequestScheduler;
  onFailure?: (status: number | null) => void;
};

function thumbnailRetryDelay(response: Response | null, attempt: number): number {
  const fallback =
    THUMBNAIL_RETRY_DELAYS_MS[Math.min(attempt, THUMBNAIL_RETRY_DELAYS_MS.length - 1)];
  const retryAfterSeconds = Number(response?.headers.get('Retry-After') ?? Number.NaN);
  return Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
    ? Math.max(fallback, retryAfterSeconds * 1_000)
    : fallback;
}

class ThumbnailSession {
  snapshot: ThumbnailSnapshot = { state: 'loading', imageSrc: null };
  private active = false;
  private disposed = false;
  private controller: AbortController | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  private startedAt: number | null = null;
  private attempt = 0;
  private failures = 0;

  constructor(
    readonly source: string,
    private options: ThumbnailOptions,
    private onChange: () => void,
  ) {}

  private publish(state: ThumbnailState, imageSrc = this.snapshot.imageSrc) {
    this.snapshot = { state, imageSrc };
    this.onChange();
  }

  private cancelRequests() {
    this.controller?.abort();
    this.controller = null;
    clearTimeout(this.retryTimer);
    clearTimeout(this.deadlineTimer);
  }

  private releaseImage() {
    if (this.snapshot.imageSrc !== null) URL.revokeObjectURL(this.snapshot.imageSrc);
    this.snapshot = { ...this.snapshot, imageSrc: null };
  }

  dispose() {
    this.disposed = true;
    this.cancelRequests();
    this.releaseImage();
  }

  deny() {
    this.dispose();
    this.publish('failed', null);
  }

  setActive(active: boolean) {
    if (this.disposed || this.active === active) return;
    this.active = active;
    if (!active) {
      if (this.options.retainLoadedOffscreen && this.snapshot.imageSrc !== null) return;
      this.cancelRequests();
      if (!this.options.retainLoadedOffscreen) {
        this.releaseImage();
        this.startedAt = null;
        this.attempt = 0;
        this.failures = 0;
        this.publish('loading', null);
      }
      return;
    }
    if (this.snapshot.imageSrc !== null || this.snapshot.state === 'failed') return;
    this.startedAt ??= Date.now();
    if (this.options.maxWaitMs !== undefined) {
      const remaining = this.options.maxWaitMs - (Date.now() - this.startedAt);
      if (remaining <= 0) return this.fail(null);
      this.deadlineTimer = setTimeout(() => this.fail(null), remaining);
    }
    void this.request();
  }

  markLoaded() {
    if (this.disposed || this.snapshot.imageSrc === null) return;
    clearTimeout(this.deadlineTimer);
    this.publish('loaded');
  }

  fail(status: number | null) {
    if (this.disposed || this.snapshot.state === 'failed') return;
    this.cancelRequests();
    this.releaseImage();
    this.publish('failed', null);
    this.options.onFailure?.(status);
  }

  private retry(response: Response | null, pending = false) {
    this.failures = pending ? 0 : this.failures + 1;
    if (this.failures > THUMBNAIL_MAX_TRANSIENT_FAILURES)
      return this.fail(response?.status ?? null);
    const delay = thumbnailRetryDelay(response, this.attempt++);
    this.retryTimer = setTimeout(() => void this.request(), delay);
  }

  private async fetch(controller: AbortController) {
    const separator = this.source.includes('?') ? '&' : '?';
    const url =
      this.attempt === 0 ? this.source : `${this.source}${separator}retry=${this.attempt}`;
    const timeout =
      this.options.requestTimeoutMs === undefined
        ? undefined
        : setTimeout(() => controller.abort(), this.options.requestTimeoutMs);
    try {
      const response = await fetch(url, {
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { Accept: 'image/jpeg' },
        signal: controller.signal,
      });
      const blob = response.status === 200 ? await response.blob() : null;
      if (blob === null) await response.body?.cancel();
      return { response, blob };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async request() {
    if (this.disposed || !this.active || this.snapshot.state === 'failed') return;
    const controller = new AbortController();
    this.controller = controller;
    try {
      const request = () => this.fetch(controller);
      const { response, blob } = await (this.options.scheduler
        ? this.options.scheduler(controller.signal, request)
        : request());
      if (this.disposed || this.controller !== controller || !this.active) return;
      if (response.status === 202) return this.retry(response, true);
      if (response.status !== 200) {
        if ([408, 425, 429].includes(response.status) || response.status >= 500) {
          this.retry(response);
        } else this.fail(response.status);
        handleUnauthorizedMediaResponse(response, this.source);
        return;
      }
      if (!blob) return this.fail(null);
      this.publish('loading', URL.createObjectURL(blob));
    } catch {
      if (!this.disposed && this.controller === controller && this.active) this.retry(null);
    }
  }
}

export function useThumbnailRequestActivation<T extends HTMLElement = HTMLButtonElement>() {
  const targetRef = useRef<T | null>(null);
  const [isActive, setIsActive] = useState(false);
  useEffect(() => {
    const target = targetRef.current;
    if (target === null || typeof IntersectionObserver === 'undefined') {
      setIsActive(true);
      return undefined;
    }
    const observer = new IntersectionObserver(
      (entries) => setIsActive(entries.some((entry) => entry.isIntersecting)),
      { rootMargin: '400px 0px' },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, []);
  return { targetRef, isActive };
}

export function useMediaThumbnail(
  thumbnailSrc: string,
  isActive: boolean,
  {
    cancelOnAuth = false,
    retainLoadedOffscreen,
    maxWaitMs,
    requestTimeoutMs,
    scheduler,
    onFailure,
  }: ThumbnailOptions = {},
) {
  const current = useRef<ThumbnailSession | null>(null);
  const selectedSource = useRef(thumbnailSrc);
  selectedSource.current = thumbnailSrc;
  const failureRef = useRef(onFailure);
  failureRef.current = onFailure;
  const [snapshot, setSnapshot] = useState<{
    session: ThumbnailSession;
    value: ThumbnailSnapshot;
  } | null>(null);
  useEffect(() => {
    if (thumbnailSrc === '') return;
    const session = new ThumbnailSession(
      thumbnailSrc,
      {
        retainLoadedOffscreen,
        maxWaitMs,
        requestTimeoutMs,
        scheduler,
        onFailure: (status) => failureRef.current?.(status),
      },
      () => {
        if (current.current === session) setSnapshot({ session, value: session.snapshot });
      },
    );
    current.current = session;
    setSnapshot({ session, value: session.snapshot });
    const cancel = () => session.deny();
    if (cancelOnAuth) {
      window.addEventListener(AUTH_UNAUTHORIZED_EVENT, cancel);
      window.addEventListener(FORCED_NAVIGATION_EVENT, cancel);
    }
    return () => {
      session.dispose();
      if (current.current === session) current.current = null;
      window.removeEventListener(AUTH_UNAUTHORIZED_EVENT, cancel);
      window.removeEventListener(FORCED_NAVIGATION_EVENT, cancel);
    };
  }, [thumbnailSrc, cancelOnAuth, retainLoadedOffscreen, maxWaitMs, requestTimeoutMs, scheduler]);
  useEffect(
    () => current.current?.setActive(isActive),
    [
      isActive,
      thumbnailSrc,
      cancelOnAuth,
      retainLoadedOffscreen,
      maxWaitMs,
      requestTimeoutMs,
      scheduler,
    ],
  );
  const matches =
    snapshot?.session === current.current && snapshot?.session.source === thumbnailSrc;
  const session = matches ? snapshot.session : null;
  return {
    imageSrc: matches ? snapshot.value.imageSrc : null,
    state: matches
      ? snapshot.value.state
      : thumbnailSrc === ''
        ? ('failed' as const)
        : ('loading' as const),
    markLoaded: () => {
      if (current.current === session && selectedSource.current === session?.source)
        session?.markLoaded();
    },
    markFailed: () => {
      if (current.current === session && selectedSource.current === session?.source)
        session?.fail(null);
    },
  };
}
