import { useLayoutEffect, useRef } from 'react';
import { getMuiPaletteMode, useMuiPaletteMode } from '../../mui-theme';

const AUDIO_PLAYER_MIN_HEIGHT_PX = 40;
const AUDIO_PLAYER_TOP_PADDING_PX = 0;
const AUDIO_PLAYER_Z_INDEX = 0;

export function syncAudioPlayerTheme(player: HTMLElement, paletteMode: 'light' | 'dark') {
  player.setAttribute('theme', paletteMode);
}

export type AudioPlayerElement = HTMLElement & {
  pause?: () => void;
  play?: () => Promise<void>;
  autoplay?: boolean;
};

export function AudioPlayerHost({
  href,
  displayName,
  waveSrc = '',
  spectrumSrc = '',
  storageKey,
  variant = 'echo',
  mode = 'compact',
  theme,
  onBeforeMount,
  onDispose,
  onPlayerChange,
  suppressInitialAutoplay = false,
  previewSizing = false,
}: {
  href: string;
  displayName: string;
  waveSrc?: string;
  spectrumSrc?: string;
  storageKey: string;
  variant?: string;
  mode?: string;
  theme?: 'light' | 'dark';
  onBeforeMount?: (player: AudioPlayerElement) => void | (() => void);
  onDispose?: (player: AudioPlayerElement) => void;
  onPlayerChange?: (player: AudioPlayerElement | null, previousPlayer?: AudioPlayerElement) => void;
  suppressInitialAutoplay?: boolean;
  previewSizing?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<AudioPlayerElement | null>(null);
  const paletteMode = useMuiPaletteMode();
  const callbacks = useRef({ onBeforeMount, onDispose, onPlayerChange });
  callbacks.current = { onBeforeMount, onDispose, onPlayerChange };

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host || href === '') return;
    const player = document.createElement('custom-audio-player') as AudioPlayerElement;
    const dispose = callbacks.current.onBeforeMount?.(player);
    player.setAttribute('src', href);
    player.setAttribute('variant', variant);
    player.setAttribute('mode', mode);
    player.setAttribute('storage-key', storageKey);
    player.setAttribute('theme', theme ?? getMuiPaletteMode());
    if (displayName !== '<файл без назви>') player.setAttribute('file-name', displayName);
    const originalPlay = player.play;
    const restorePlay = () => {
      if (suppressInitialAutoplay) player.play = originalPlay;
    };
    if (suppressInitialAutoplay) {
      player.play = () => Promise.resolve();
      player.addEventListener('canplay', restorePlay, { once: true });
    }
    host.replaceChildren(player);
    playerRef.current = player;
    callbacks.current.onPlayerChange?.(player);
    return () => {
      if (typeof dispose === 'function') dispose();
      callbacks.current.onDispose?.(player);
      player.pause?.();
      player.removeEventListener('canplay', restorePlay);
      restorePlay();
      playerRef.current = null;
      callbacks.current.onPlayerChange?.(null, player);
      host.replaceChildren();
    };
  }, [displayName, href, storageKey, suppressInitialAutoplay, variant, mode]);

  useLayoutEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    if (waveSrc) player.setAttribute('wave-src', waveSrc);
    else player.removeAttribute('wave-src');
    if (spectrumSrc) player.setAttribute('spectrum-src', spectrumSrc);
    else player.removeAttribute('spectrum-src');
  }, [displayName, href, storageKey, suppressInitialAutoplay, variant, mode, waveSrc, spectrumSrc]);

  useLayoutEffect(() => {
    if (playerRef.current) syncAudioPlayerTheme(playerRef.current, theme ?? paletteMode);
  }, [paletteMode, theme]);

  return (
    <div
      ref={hostRef}
      className={`message-card-audio-host relative z-0 flex min-w-0 flex-1 items-stretch${
        previewSizing ? ' message-card-audio-host--preview' : ''
      }`}
      data-audio-player-host
      data-audio-player-min-height-px={AUDIO_PLAYER_MIN_HEIGHT_PX}
      data-audio-player-top-padding-px={AUDIO_PLAYER_TOP_PADDING_PX}
      data-audio-player-z-index={AUDIO_PLAYER_Z_INDEX}
    />
  );
}
