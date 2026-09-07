import { Tooltip } from '@mui/material';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import SmartToyOutlinedIcon from '@mui/icons-material/SmartToyOutlined';
import SubtitlesIcon from '@mui/icons-material/Subtitles';
import {
  createContext,
  type KeyboardEvent,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

type AudioTranscriptionPreferences = {
  collapsedByDefault: boolean;
  enabled: boolean;
};

const AudioTranscriptionPreferencesContext = createContext<AudioTranscriptionPreferences>({
  collapsedByDefault: false,
  enabled: true,
});

export function AudioTranscriptionPreferencesProvider({
  children,
  collapsedByDefault,
  enabled = true,
}: {
  children: ReactNode;
  collapsedByDefault: boolean;
  enabled?: boolean;
}) {
  const preferences = useMemo(
    () => ({ collapsedByDefault, enabled }),
    [collapsedByDefault, enabled],
  );

  return (
    <AudioTranscriptionPreferencesContext.Provider value={preferences}>
      {children}
    </AudioTranscriptionPreferencesContext.Provider>
  );
}

export function useAudioTranscriptionPreferences(): AudioTranscriptionPreferences {
  return useContext(AudioTranscriptionPreferencesContext);
}

function hasMoreThanThreeLogicalLines(transcription: string): boolean {
  return transcription.split(/\r?\n/).length > 3;
}

export function MessageCardAudioTranscription({ transcription }: { transcription: string }) {
  const { collapsedByDefault, enabled } = useAudioTranscriptionPreferences();
  const normalizedTranscription = transcription.trim();
  const [visible, setVisible] = useState(!collapsedByDefault);
  const [expanded, setExpanded] = useState(false);
  const [hasOverflow, setHasOverflow] = useState(() =>
    hasMoreThanThreeLogicalLines(normalizedTranscription),
  );
  const textRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    setVisible(!collapsedByDefault);
    setExpanded(false);
  }, [collapsedByDefault, normalizedTranscription]);

  useLayoutEffect(() => {
    if (!visible || expanded) return;
    const transcriptionText = textRef.current;
    if (!transcriptionText) return;

    const measure = () => {
      setHasOverflow(
        hasMoreThanThreeLogicalLines(normalizedTranscription) ||
          transcriptionText.scrollHeight > transcriptionText.clientHeight + 1,
      );
    };

    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(transcriptionText);
    return () => observer.disconnect();
  }, [expanded, normalizedTranscription, visible]);

  if (!enabled || normalizedTranscription === '') return null;

  const toggleExpanded = () => {
    if (!hasOverflow) return;
    setExpanded((current) => !current);
  };

  const onTranscriptionKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!hasOverflow || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    toggleExpanded();
  };

  return (
    <div
      className={
        visible
          ? 'audio-transcription-control audio-transcription-control--visible'
          : 'audio-transcription-control'
      }
      data-audio-transcription-control
    >
      {collapsedByDefault ? (
        <Tooltip title="Транскрибувати аудіо" enterDelay={400}>
          <button
            type="button"
            className="audio-transcription-toggle"
            aria-label="Транскрибувати аудіо"
            aria-expanded={visible}
            onClick={() => {
              setVisible((current) => !current);
              setExpanded(false);
            }}
          >
            <SubtitlesIcon fontSize="small" aria-hidden="true" />
          </button>
        </Tooltip>
      ) : null}
      {visible ? (
        <blockquote
          data-audio-transcription
          className={
            'audio-transcription m-0 mt-0.5 mb-1 flex gap-1 px-2 py-1.5 text-sm leading-5 ' +
            'whitespace-pre-wrap wrap-break-word' +
            (collapsedByDefault ? ' audio-transcription--with-toggle' : '') +
            (!expanded ? ' audio-transcription--clamped' : '') +
            (hasOverflow ? ' cursor-pointer' : '')
          }
          role={hasOverflow ? 'button' : undefined}
          tabIndex={hasOverflow ? 0 : undefined}
          aria-expanded={hasOverflow ? expanded : undefined}
          onClick={toggleExpanded}
          onKeyDown={onTranscriptionKeyDown}
        >
          <SmartToyOutlinedIcon
            className="audio-transcription-icon"
            data-audio-transcription-icon="robot"
            aria-hidden
          />
          <span className="min-w-0 flex-1">
            <span ref={textRef} className="audio-transcription-text">
              {normalizedTranscription}
            </span>
          </span>
          {hasOverflow ? (
            expanded ? (
              <KeyboardArrowUpIcon
                className="audio-transcription-arrow"
                data-audio-transcription-arrow="up"
                aria-hidden
              />
            ) : (
              <KeyboardArrowDownIcon
                className="audio-transcription-arrow"
                data-audio-transcription-arrow="down"
                aria-hidden
              />
            )
          ) : null}
        </blockquote>
      ) : null}
    </div>
  );
}
