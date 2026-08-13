import AudioFileIcon from '@mui/icons-material/AudioFile';
import ImageIcon from '@mui/icons-material/Image';
import MapIcon from '@mui/icons-material/Map';
import VideocamIcon from '@mui/icons-material/Videocam';
import type { ReactNode } from 'react';

export type MessageCardMediaRevealKind = 'visuals' | 'audio' | 'coordinates';

export function formatMessageMediaCountLabel(
  count: number,
  forms: { one: string; few: string; many: string },
): string {
  const lastTwoDigits = count % 100;
  const lastDigit = count % 10;
  if (lastDigit === 1 && lastTwoDigits !== 11) return `${count} ${forms.one}`;
  if (lastDigit >= 2 && lastDigit <= 4 && (lastTwoDigits < 12 || lastTwoDigits > 14)) {
    return `${count} ${forms.few}`;
  }
  return `${count} ${forms.many}`;
}

export function formatMessageAudioRevealLabel(count: number): string {
  return formatMessageMediaCountLabel(count, {
    one: 'аудіо',
    few: 'аудіо',
    many: 'аудіо',
  });
}

export function formatMessagePhotoRevealLabel(count: number): string {
  return formatMessageMediaCountLabel(count, {
    one: 'фото',
    few: 'фото',
    many: 'фото',
  });
}

export function formatMessageVideoRevealLabel(count: number): string {
  return formatMessageMediaCountLabel(count, {
    one: 'відео',
    few: 'відео',
    many: 'відео',
  });
}

export function formatMessageVisualRevealLabel(imageCount: number, videoCount: number): string {
  const parts: string[] = [];
  if (imageCount > 0) parts.push(formatMessagePhotoRevealLabel(imageCount));
  if (videoCount > 0) parts.push(formatMessageVideoRevealLabel(videoCount));
  return parts.join(' · ');
}

export function messageCardVisualRevealIcon(imageCount: number, videoCount: number): ReactNode {
  if (imageCount > 0 && videoCount === 0) return <ImageIcon fontSize="inherit" />;
  if (videoCount > 0 && imageCount === 0) return <VideocamIcon fontSize="inherit" />;
  return <ImageIcon fontSize="inherit" />;
}

export function MessageCardMediaRevealBanner({
  kind,
  label,
  icon,
  onReveal,
}: {
  kind: MessageCardMediaRevealKind;
  label: string;
  icon: ReactNode;
  onReveal: () => void;
}) {
  return (
    <button
      type="button"
      className="message-card-media-reveal"
      data-message-media-reveal={kind}
      aria-label={`Показати ${label}`}
      onClick={onReveal}
    >
      <span className="message-card-media-reveal__icon" aria-hidden>
        {icon}
      </span>
      <span className="message-card-media-reveal__label">{label}</span>
    </button>
  );
}

export const MESSAGE_CARD_AUDIO_REVEAL_ICON = <AudioFileIcon fontSize="inherit" />;
export const MESSAGE_CARD_COORDINATE_REVEAL_ICON = <MapIcon fontSize="inherit" />;
