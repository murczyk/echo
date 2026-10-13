import type { CustomAudioPlayer } from '@echoua/echo-audio-player';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DeviceAudioPreparation } from '../../../../../Bindings';
import { PowerButton } from '../../../components/PowerButton';
import {
  AudioPlayerHost,
  type AudioPlayerElement,
} from '../../../components/audio-player/AudioPlayerHost';
import { useOptionalPowerSnackbar } from '../../../components/PowerSnackbar';
import { AUTH_UNAUTHORIZED_EVENT } from '../../../auth-redirect';
import { FORCED_NAVIGATION_EVENT } from '../../../../browser/navigation-guard';
import { headDeviceAudioContent, prepareDeviceAudio } from '../../../services/api/device-audio';
import { HttpRequestError, isAbortError } from '../../../services/api/client';
import { formatDeviceErrorMessage } from '../../devices/helpers';

type PlaybackState = {
  phase: 'loading' | 'waiting' | 'ready' | 'error' | 'unavailable';
  message?: string;
};

export function DeviceAudioPlayer({
  deviceId,
  audioId,
  active = true,
  onPrepared,
}: {
  deviceId: string;
  audioId: string;
  active?: boolean;
  onPrepared?: () => void;
}) {
  return active ? (
    <PlayerSession
      key={`${deviceId}:${audioId}`}
      deviceId={deviceId}
      audioId={audioId}
      onPrepared={onPrepared}
    />
  ) : null;
}

function PlayerSession({
  deviceId,
  audioId,
  onPrepared,
}: {
  deviceId: string;
  audioId: string;
  onPrepared?: () => void;
}) {
  const preparedRef = useRef(onPrepared);
  preparedRef.current = onPrepared;
  const [state, setState] = useState<PlaybackState>({ phase: 'loading' });
  const { notify } = useOptionalPowerSnackbar();
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  const [preparation, setPreparation] = useState<DeviceAudioPreparation | null>(null);
  const [retry, setRetry] = useState(0);
  const [preparationError, setPreparationError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let graphicsWarning = false;
    let admissionWarning = false;
    setPreparation(null);
    setPreparationError(null);
    setState({ phase: 'loading' });
    const stop = () => {
      controller.abort();
      clearTimeout(timer);
      setPreparation(null);
    };
    window.addEventListener(AUTH_UNAUTHORIZED_EVENT, stop, true);
    window.addEventListener(FORCED_NAVIGATION_EVENT, stop, true);
    const poll = async (explicitRetry = false) => {
      try {
        const result = await prepareDeviceAudio(
          { deviceId, audioId, retry: explicitRetry },
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        setPreparation(result);
        preparedRef.current?.();
        if (result.transcriptionAdmissionError && !admissionWarning) {
          admissionWarning = true;
          notifyRef.current({
            severity: 'warning',
            message: result.transcriptionAdmissionError.message,
          });
        }
        if (result.content === 'failed') {
          throw new Error('Не вдалося підготувати аудіо. Спробуйте ще раз.');
        }
        if (!graphicsWarning && [result.wave, result.spectrogram].includes('failed')) {
          graphicsWarning = true;
          notifyRef.current({
            severity: 'warning',
            message: 'Не вдалося підготувати графіки аудіо.',
          });
        }
        if (
          [result.content, result.wave, result.spectrogram].some(
            (value) => value === 'queued' || value === 'preparing',
          )
        ) {
          timer = setTimeout(() => void poll(), Math.max(500, Math.min(result.retryAfterMs, 5000)));
        }
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) return;
        if (error instanceof HttpRequestError && [401, 403, 404].includes(error.status)) {
          setPreparation(null);
          setState({ phase: 'unavailable' });
        }
        const message = `Помилка підготовки аудіо: ${formatDeviceErrorMessage(error)}`;
        setPreparationError(message);
        notifyRef.current({ severity: 'error', message });
      }
    };
    void poll(retry > 0);
    return () => {
      controller.abort();
      clearTimeout(timer);
      window.removeEventListener(AUTH_UNAUTHORIZED_EVENT, stop, true);
      window.removeEventListener(FORCED_NAVIGATION_EVENT, stop, true);
    };
  }, [deviceId, audioId, retry]);
  const source = `/api/device/audio/${encodeURIComponent(deviceId)}/${encodeURIComponent(audioId)}`;
  const prepare = useCallback(
    (element: AudioPlayerElement) => {
      const player = element as CustomAudioPlayer;
      let active = true;
      let epoch = 0;
      let probe: AbortController | null = null;
      const originalPause = player.pause.bind(player);
      const stop = () => {
        if (!active) return;
        active = false;
        window.removeEventListener(AUTH_UNAUTHORIZED_EVENT, stop, true);
        window.removeEventListener(FORCED_NAVIGATION_EVENT, stop, true);
        ++epoch;
        probe?.abort();
        player.play = () => Promise.resolve();
        player.retryCurrentSource = () => {};
        player.setSrc = () => {};
        player.setSrcImmediate = () => {};
        player.bindAudioEvents = () => {};
        originalPause();
        player.autoplay = false;
        if (player.audio) {
          player.audio.pause();
          player.audio.removeAttribute('src');
          player.audio.load();
        }
      };
      window.addEventListener(AUTH_UNAUTHORIZED_EVENT, stop, true);
      window.addEventListener(FORCED_NAVIGATION_EVENT, stop, true);
      const checkAccess = async () => {
        probe?.abort();
        const request = new AbortController();
        probe = request;
        const current = ++epoch;
        setState({
          phase: 'error',
          message: 'Помилка відтворення аудіо. Скористайтеся повторною спробою програвача.',
        });
        try {
          await headDeviceAudioContent(deviceId, audioId, { signal: request.signal });
          if (active && current === epoch && !request.signal.aborted) {
            notifyRef.current({ severity: 'error', message: 'Помилка відтворення аудіо.' });
          }
        } catch (error) {
          if (!active || current !== epoch || request.signal.aborted || isAbortError(error)) return;
          const denied =
            error instanceof HttpRequestError && [401, 403, 404].includes(error.status);
          const message = denied
            ? 'Аудіо недоступне.'
            : `Помилка отримання аудіо: ${formatDeviceErrorMessage(error)}`;
          if (denied) stop();
          setState({ phase: denied ? 'unavailable' : 'error', message });
          notifyRef.current({ severity: 'error', message });
        }
      };
      const originalBinding = player.bindAudioEvents.bind(player);
      player.bindAudioEvents = () => {
        if (!active) return;
        ++epoch;
        probe?.abort();
        setState({ phase: 'loading' });
        const audio = player.audio;
        const current = () => active && player.audio === audio;
        for (const name of [
          'canplay',
          'error',
          'loadedmetadata',
          'loadstart',
          'timeupdate',
          'play',
          'pause',
          'ended',
          'waiting',
          'stalled',
        ]) {
          audio.addEventListener(
            name,
            (event) => {
              if (!current()) event.stopImmediatePropagation();
            },
            true,
          );
        }
        audio.addEventListener('loadstart', () => {
          if (!current()) return;
          ++epoch;
          probe?.abort();
          setState({ phase: 'loading' });
        });
        for (const name of ['waiting', 'stalled'])
          audio.addEventListener(name, () => {
            if (!current()) return;
            player.showLoading();
            setState({ phase: 'waiting' });
          });
        audio.addEventListener('canplay', () => {
          if (!current()) return;
          ++epoch;
          probe?.abort();
          setState({ phase: 'ready' });
        });
        audio.addEventListener('error', () => {
          if (current()) void checkAccess();
        });
        originalBinding();
      };
      return stop;
    },
    [deviceId, audioId],
  );

  return (
    <div className="min-w-0" data-device-audio-player>
      {preparation?.content === 'ready' && state.phase !== 'unavailable' ? (
        <AudioPlayerHost
          href={`${source}/content`}
          waveSrc={preparation.wave === 'ready' ? `${source}/wave` : ''}
          spectrumSrc={preparation.spectrogram === 'ready' ? `${source}/spectrogram` : ''}
          storageKey={`echo-device-audio-${deviceId}-${audioId}`}
          displayName="Аудіоматеріал"
          onBeforeMount={prepare}
        />
      ) : null}
      {!preparationError && (state.phase === 'loading' || state.phase === 'waiting') ? (
        <p role="status">
          {preparation?.content === 'ready' ? 'Очікування аудіо…' : 'Підготовка аудіо…'}
        </p>
      ) : null}
      {state.message ? <p role="alert">{state.message}</p> : null}
      {preparationError ? (
        <div>
          <p role="alert">{preparationError}</p>
          <PowerButton onClick={() => setRetry((value) => value + 1)}>Повторити</PowerButton>
        </div>
      ) : null}
    </div>
  );
}
