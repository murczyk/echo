import type { CustomAudioPlayer } from '@echoua/echo-audio-player';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AudioPlayerElement } from '../../components/audio-player/AudioPlayerHost';
import { HttpRequestError, isAbortError } from '../../services/api/client';
import {
  DEVICE_MEDIA_PREVIEW_TIMEOUT_MS,
  getDeviceFileMediaAudioPrefix,
  preflightDeviceFileMedia,
} from '../../services/api/device-file-preview';
import type { FilePreviewLifecycleProps } from '../shared/message-card/attachment-preview/file-preview-source';
import { releaseNativeMedia } from '../shared/message-card/attachment-preview/native-media-lifecycle';
import {
  hasMpegAudioSignature,
  isAmbiguousAudioOnlyMedia,
} from '../shared/message-card/audio-only-media';
import type { DeviceFilePreviewSource } from './use-device-file-preview';

type Snapshot = {
  key: string;
  signal: AbortSignal;
  phase: 'loading' | 'ready' | 'checking' | 'empty' | 'error';
  href?: string;
  message?: string;
};
type MediaSession = {
  active: boolean;
  probing: boolean;
  controller: AbortController;
  current: () => boolean;
  native: HTMLMediaElement | null;
  stopPlayer?: () => void;
  stopDuration?: () => void;
  watchdog?: ReturnType<typeof setTimeout>;
};

function stopNative(session: MediaSession) {
  clearTimeout(session.watchdog);
  session.stopDuration?.();
  session.stopPlayer?.();
  if (session.native) releaseNativeMedia(session.native);
}

function observeNativeDuration(
  session: MediaSession,
  element: HTMLMediaElement,
  onDurationChange: (seconds: number) => void,
) {
  session.stopDuration?.();
  session.native = element;
  const update = () => {
    if (
      session.current() &&
      session.native === element &&
      Number.isFinite(element.duration) &&
      element.duration >= 0
    )
      onDurationChange(element.duration);
  };
  element.addEventListener('loadedmetadata', update);
  element.addEventListener('durationchange', update);
  session.stopDuration = () => {
    element.removeEventListener('loadedmetadata', update);
    element.removeEventListener('durationchange', update);
  };
  update();
}

function guardAudioPlayer(
  player: CustomAudioPlayer,
  session: MediaSession,
  fail: (code?: number, timeout?: boolean) => void,
  onDurationChange: (seconds: number) => void,
) {
  let active = true;
  const originalBinding = player.bindAudioEvents.bind(player);
  const originalPlay = player.play.bind(player);
  player.play = () => (active && session.current() ? originalPlay() : Promise.resolve());
  const stop = () => {
    if (!active) return;
    active = false;
    player.autoplay = false;
    player.play = () => Promise.resolve();
    player.retryCurrentSource = () => {};
    player.setSrc = () => {};
    player.setSrcImmediate = () => {};
    player.bindAudioEvents = () => {};
    if (session.native === player.audio) session.stopDuration?.();
    if (player.audio) releaseNativeMedia(player.audio);
  };
  player.bindAudioEvents = () => {
    if (!active || !session.current()) return;
    const audio = player.audio;
    observeNativeDuration(session, audio, onDurationChange);
    const current = () => active && session.current() && player.audio === audio;
    const waiting = () => {
      if (!current()) return;
      clearTimeout(session.watchdog);
      session.watchdog = setTimeout(() => {
        if (current()) fail(undefined, true);
      }, DEVICE_MEDIA_PREVIEW_TIMEOUT_MS);
    };
    for (const name of [
      'loadstart',
      'waiting',
      'stalled',
      'seeking',
      'seeked',
      'canplay',
      'playing',
      'error',
      'play',
      'pause',
      'ended',
      'timeupdate',
    ]) {
      audio.addEventListener(
        name,
        (event) => {
          if (!current()) event.stopImmediatePropagation();
        },
        true,
      );
    }
    for (const name of ['loadstart', 'waiting', 'stalled', 'seeking'])
      audio.addEventListener(name, waiting);
    for (const name of ['canplay', 'playing', 'seeked'])
      audio.addEventListener(
        name,
        () => {
          if (!current()) return;
          player.autoplay = false;
          clearTimeout(session.watchdog);
        },
        true,
      );
    audio.addEventListener(
      'error',
      (event) => {
        if (!current()) return;
        event.stopImmediatePropagation();
        fail(audio.error?.code);
      },
      true,
    );
    player.autoplay = false;
    originalBinding();
    waiting();
  };
  return stop;
}

export function useDeviceMediaPreview({
  source,
  lifecycle,
  checkAccess,
  onDurationChange,
}: {
  source: DeviceFilePreviewSource;
  lifecycle: FilePreviewLifecycleProps;
  checkAccess: () => Promise<boolean>;
  onDurationChange?: (seconds: number) => void;
}) {
  const selected = useRef(source.key);
  selected.current = source.key;
  const latest = useRef({ lifecycle, checkAccess, onDurationChange });
  latest.current = { lifecycle, checkAccess, onDurationChange };
  const current = useRef<MediaSession | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  useEffect(() => {
    const lifetime = latest.current.lifecycle;
    const controller = new AbortController();
    const session: MediaSession = {
      active: true,
      probing: false,
      controller,
      native: null,
      current: () =>
        session.active &&
        !lifetime.signal.aborted &&
        lifetime.isCurrent() &&
        selected.current === source.key &&
        current.current === session,
    };
    current.current = session;
    const stop = () => {
      if (!session.active) return;
      session.active = false;
      controller.abort();
      stopNative(session);
    };
    lifetime.signal.addEventListener('abort', stop, { once: true });
    const unregister = lifetime.registerCleanup(stop);
    const base = { key: source.key, signal: lifetime.signal };
    setSnapshot({ ...base, phase: source.sizeBytes === 0 ? 'empty' : 'loading' });
    if (session.current() && source.sizeBytes !== 0) {
      void preflightDeviceFileMedia(source, controller.signal)
        .then((href) => {
          if (session.current()) setSnapshot({ ...base, phase: 'ready', href });
        })
        .catch((error: unknown) => {
          if (!session.current() || isAbortError(error)) return;
          setSnapshot({
            ...base,
            phase: 'error',
            message: error instanceof Error ? error.message : 'Не вдалося завантажити медіафайл.',
          });
          lifetime.onError(error);
        });
    }
    return () => {
      stop();
      unregister();
      lifetime.signal.removeEventListener('abort', stop);
    };
  }, [source.key, lifecycle.signal]);
  const reportCurrentNativeFailure = useCallback(async (code?: number, timeout = false) => {
    const session = current.current;
    if (!session?.current() || session.probing) return;
    session.probing = true;
    stopNative(session);
    setSnapshot((state) => (state ? { ...state, phase: 'checking', href: undefined } : state));
    try {
      if (!(await latest.current.checkAccess()) || !session.current()) return;
      const codec = !timeout && (code === 3 || code === 4);
      const error = new HttpRequestError(
        codec ? 415 : 0,
        codec
          ? 'Браузер не підтримує кодек цього медіафайлу. Скачайте оригінальний файл.'
          : timeout
            ? 'Завантаження медіафайлу триває надто довго. Спробуйте ще раз.'
            : 'Не вдалося отримати медіафайл для відтворення. Повторіть спробу.',
      );
      setSnapshot((state) =>
        state ? { ...state, phase: 'error', message: error.message } : state,
      );
      latest.current.lifecycle.onError(error);
    } catch (error) {
      if (session.current() && !isAbortError(error)) latest.current.lifecycle.onError(error);
    }
  }, []);
  const renderingSession = current.current;
  const reportNativeFailure = useCallback(
    (code?: number, timeout = false) => {
      if (!renderingSession?.current()) return Promise.resolve();
      return reportCurrentNativeFailure(code, timeout);
    },
    [renderingSession, reportCurrentNativeFailure],
  );
  const attachNative = useCallback(
    (element: HTMLMediaElement | null) => {
      if (renderingSession?.current() && element)
        observeNativeDuration(renderingSession, element, (seconds) =>
          latest.current.onDurationChange?.(seconds),
        );
    },
    [renderingSession],
  );
  const detectAudioOnly = useCallback(
    async (element: HTMLVideoElement) => {
      const session = renderingSession;
      if (!session?.current() || session.native !== element) return false;
      if (isAmbiguousAudioOnlyMedia(source.fileName, source.contentType, element)) return true;
      if (
        source.contentType !== 'video/mpeg' ||
        !/\.(mpeg|mpg)$/i.test(source.fileName) ||
        !isAmbiguousAudioOnlyMedia(source.fileName, '', element)
      )
        return false;
      try {
        const prefix = await getDeviceFileMediaAudioPrefix(source, session.controller.signal);
        return (
          session.current() &&
          session.native === element &&
          prefix !== null &&
          isAmbiguousAudioOnlyMedia(source.fileName, '', element) &&
          hasMpegAudioSignature(prefix)
        );
      } catch (error) {
        if (session.current() && !isAbortError(error)) latest.current.lifecycle.onError(error);
        return false;
      }
    },
    [renderingSession, source],
  );
  const prepareAudio = useCallback(
    (element: AudioPlayerElement) => {
      const session = current.current;
      if (!session?.current()) return;
      const stop = guardAudioPlayer(
        element as CustomAudioPlayer,
        session,
        (code, timeout) => {
          void reportNativeFailure(code, timeout);
        },
        (seconds) => latest.current.onDurationChange?.(seconds),
      );
      session.stopPlayer = stop;
      return stop;
    },
    [reportNativeFailure],
  );
  const matches = snapshot?.key === source.key && snapshot.signal === lifecycle.signal;
  return {
    snapshot: matches ? snapshot : null,
    reportNativeFailure,
    attachNative,
    prepareAudio,
    detectAudioOnly,
  };
}
