import dayjs from 'dayjs';
import { useEffect, useRef, useState, type MouseEvent } from 'react';

import type { SignalGroupEntry } from '../../../../../Bindings';
import { useOptionalPowerSnackbar } from '../../../components/PowerSnackbar';
import { fetchInboxItemContext } from '../../../services/api/inbox-messages';
import { APP_TIME_ZONE } from '../../../utils/misc';
import {
  summarizeIntelligenceMessage,
  type IntelligenceReportSummary,
} from '../intelligence-reports';
import { MessageSummaryPreview } from './MessageSummaryPreview';

const EMPTY_SUMMARY: IntelligenceReportSummary = {
  id: -1,
  isAccessible: true,
  isDeleted: false,
  text: '',
  attachmentsCount: 0,
  timestamp: null,
  date: null,
  time: null,
  isTimeNull: null,
  groupName: null,
  groupMasterKey: null,
  coords: null,
  mediaFileNames: [],
};
const MESSAGE_REFERENCE_RESOLUTION_TTL_MS = 5_000;
const MESSAGE_REFERENCE_ERROR_RESOLUTION_TTL_MS = 1_000;
const MESSAGE_REFERENCE_PROGRESS_DELAY_MS = 200;
const MESSAGE_REFERENCE_REQUEST_TIMEOUT_MS = 10_000;

enum MessageReferenceResolutionKind {
  Available = 'available',
  Unavailable = 'unavailable',
  Error = 'error',
  Abandoned = 'abandoned',
}

type MessageReferenceResolution =
  | { kind: MessageReferenceResolutionKind.Available }
  | { kind: MessageReferenceResolutionKind.Unavailable }
  | { kind: MessageReferenceResolutionKind.Error; error: unknown }
  | { kind: MessageReferenceResolutionKind.Abandoned };

type CachedMessageReferenceResolution = {
  resolution: MessageReferenceResolution;
  expiresAt: number;
};

function summaryTime(summary: IntelligenceReportSummary): string | null {
  if (summary.isTimeNull === true) {
    return (
      summary.date ??
      (summary.timestamp == null
        ? null
        : dayjs(summary.timestamp).tz(APP_TIME_ZONE).format('DD.MM.YYYY'))
    );
  }
  if (summary.timestamp != null) {
    return dayjs(summary.timestamp).tz(APP_TIME_ZONE).format('DD.MM.YYYY HH:mm');
  }
  return [summary.date, summary.time].filter(Boolean).join(' ') || null;
}

export function MessageReferenceLink({
  href,
  messageIdentifier,
  groupInfos,
}: {
  href: string;
  messageIdentifier: string;
  groupInfos: Record<string, SignalGroupEntry>;
}) {
  const [summary, setSummary] = useState<IntelligenceReportSummary>(EMPTY_SUMMARY);
  const [unavailable, setUnavailable] = useState(false);
  const [checking, setChecking] = useState(false);
  const [showCheckingIndicator, setShowCheckingIndicator] = useState(false);
  const pendingResolutionRef = useRef<Promise<MessageReferenceResolution> | null>(null);
  const cachedResolutionRef = useRef<CachedMessageReferenceResolution | null>(null);
  const clickCheckPendingRef = useRef(false);
  const checkingIndicatorTimeoutRef = useRef<number | null>(null);
  const activeRequestAbortControllerRef = useRef<AbortController | null>(null);
  const requestGenerationRef = useRef(0);
  const { notify } = useOptionalPowerSnackbar();

  useEffect(() => {
    const requestGeneration = ++requestGenerationRef.current;
    activeRequestAbortControllerRef.current?.abort();
    activeRequestAbortControllerRef.current = null;
    setSummary(EMPTY_SUMMARY);
    setUnavailable(false);
    setChecking(false);
    setShowCheckingIndicator(false);
    pendingResolutionRef.current = null;
    cachedResolutionRef.current = null;
    clickCheckPendingRef.current = false;
    if (checkingIndicatorTimeoutRef.current !== null) {
      window.clearTimeout(checkingIndicatorTimeoutRef.current);
      checkingIndicatorTimeoutRef.current = null;
    }

    return () => {
      if (requestGenerationRef.current === requestGeneration) {
        requestGenerationRef.current += 1;
      }
      activeRequestAbortControllerRef.current?.abort();
      activeRequestAbortControllerRef.current = null;
      pendingResolutionRef.current = null;
      clickCheckPendingRef.current = false;
      if (checkingIndicatorTimeoutRef.current !== null) {
        window.clearTimeout(checkingIndicatorTimeoutRef.current);
        checkingIndicatorTimeoutRef.current = null;
      }
    };
  }, [messageIdentifier]);

  const getCachedResolution = () => {
    const cached = cachedResolutionRef.current;
    if (!cached || cached.expiresAt <= Date.now()) {
      cachedResolutionRef.current = null;
      return null;
    }
    return cached.resolution;
  };

  const resolveMessageReference = () => {
    const cachedResolution = getCachedResolution();
    if (cachedResolution) return Promise.resolve(cachedResolution);
    if (pendingResolutionRef.current) return pendingResolutionRef.current;

    const abortController = new AbortController();
    const requestGeneration = requestGenerationRef.current;
    activeRequestAbortControllerRef.current = abortController;
    let didTimeOut = false;
    const requestTimeout = window.setTimeout(() => {
      didTimeOut = true;
      abortController.abort();
    }, MESSAGE_REFERENCE_REQUEST_TIMEOUT_MS);
    const resolution = fetchInboxItemContext(
      { messageUid: messageIdentifier },
      { signal: abortController.signal },
    )
      .then((response): MessageReferenceResolution => {
        if (requestGenerationRef.current !== requestGeneration) {
          return { kind: MessageReferenceResolutionKind.Abandoned };
        }
        if (response.message == null) {
          setUnavailable(true);
          return { kind: MessageReferenceResolutionKind.Unavailable };
        }
        setUnavailable(false);
        setSummary(summarizeIntelligenceMessage(response.message[0], response.message[1]));
        return { kind: MessageReferenceResolutionKind.Available };
      })
      .catch((error): MessageReferenceResolution => {
        if (requestGenerationRef.current !== requestGeneration) {
          return { kind: MessageReferenceResolutionKind.Abandoned };
        }
        setUnavailable(false);
        return {
          kind: MessageReferenceResolutionKind.Error,
          error: didTimeOut
            ? new Error('Перевірка доступності повідомлення тривала надто довго.')
            : error,
        };
      })
      .then((result): MessageReferenceResolution => {
        if (
          result.kind === MessageReferenceResolutionKind.Abandoned ||
          requestGenerationRef.current !== requestGeneration
        ) {
          return { kind: MessageReferenceResolutionKind.Abandoned };
        }
        cachedResolutionRef.current = {
          resolution: result,
          expiresAt:
            Date.now() +
            (result.kind === MessageReferenceResolutionKind.Error
              ? MESSAGE_REFERENCE_ERROR_RESOLUTION_TTL_MS
              : MESSAGE_REFERENCE_RESOLUTION_TTL_MS),
        };
        return result;
      })
      .finally(() => {
        window.clearTimeout(requestTimeout);
        if (activeRequestAbortControllerRef.current === abortController) {
          activeRequestAbortControllerRef.current = null;
        }
      });
    pendingResolutionRef.current = resolution;
    void resolution.then(() => {
      if (pendingResolutionRef.current === resolution) pendingResolutionRef.current = null;
    });
    return resolution;
  };

  const loadSummary = async () => {
    const resolution = await resolveMessageReference();
    if (resolution.kind === MessageReferenceResolutionKind.Error && !clickCheckPendingRef.current) {
      notify({
        severity: 'error',
        message:
          resolution.error instanceof Error
            ? resolution.error.message
            : 'Не вдалося завантажити попередній перегляд повідомлення.',
      });
    }
    return (
      resolution.kind !== MessageReferenceResolutionKind.Error &&
      resolution.kind !== MessageReferenceResolutionKind.Abandoned
    );
  };

  const openMessageReferenceWindow = () => {
    const openedWindow = window.open(href, '_blank');
    if (!openedWindow) return false;
    openedWindow.opener = null;
    return true;
  };

  const openMessageReference = async (event: MouseEvent<HTMLAnchorElement>) => {
    if (clickCheckPendingRef.current) {
      event.preventDefault();
      return;
    }
    if (getCachedResolution()?.kind === MessageReferenceResolutionKind.Available) return;
    event.preventDefault();
    const requestGeneration = requestGenerationRef.current;
    clickCheckPendingRef.current = true;
    setChecking(true);
    checkingIndicatorTimeoutRef.current = window.setTimeout(() => {
      if (requestGenerationRef.current === requestGeneration) setShowCheckingIndicator(true);
    }, MESSAGE_REFERENCE_PROGRESS_DELAY_MS);

    try {
      const resolution = await resolveMessageReference();
      if (
        resolution.kind === MessageReferenceResolutionKind.Abandoned ||
        requestGenerationRef.current !== requestGeneration
      ) {
        return;
      }
      if (resolution.kind === MessageReferenceResolutionKind.Unavailable) {
        notify({
          severity: 'warning',
          message: 'Повідомлення видалено або у вас немає до нього доступу.',
        });
        return;
      }
      if (resolution.kind === MessageReferenceResolutionKind.Error) {
        notify({
          severity: 'error',
          message: 'Не вдалося перевірити доступність повідомлення. Спробуйте ще раз.',
        });
        return;
      }

      if (openMessageReferenceWindow()) return;
      notify({
        severity: 'warning',
        message: (
          <>
            Не вдалося автоматично відкрити повідомлення.
            <button
              type="button"
              className="ml-2 cursor-pointer border-0 bg-transparent p-0 font-semibold text-inherit underline"
              onClick={() => {
                if (openMessageReferenceWindow()) return;
                notify({
                  severity: 'warning',
                  message:
                    'Не вдалося відкрити повідомлення. Перевірте налаштування браузера та спробуйте ще раз.',
                });
              }}
            >
              Відкрити
            </button>
          </>
        ),
      });
    } finally {
      if (requestGenerationRef.current === requestGeneration) {
        clickCheckPendingRef.current = false;
        setChecking(false);
        setShowCheckingIndicator(false);
        if (checkingIndicatorTimeoutRef.current !== null) {
          window.clearTimeout(checkingIndicatorTimeoutRef.current);
          checkingIndicatorTimeoutRef.current = null;
        }
      }
    }
  };

  const groupName = summary.groupMasterKey
    ? (groupInfos[summary.groupMasterKey]?.name ?? summary.groupMasterKey)
    : null;

  return (
    <MessageSummaryPreview
      summary={summary}
      label="Повідомлення"
      groupName={groupName}
      time={summaryTime(summary)}
      unavailable={unavailable}
      onBeforeOpen={loadSummary}
    >
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="повідомлення"
        aria-busy={checking}
        onMouseEnter={() => void resolveMessageReference()}
        onFocus={() => void resolveMessageReference()}
        onClick={openMessageReference}
        onAuxClick={(event) => {
          if (event.button === 1) void openMessageReference(event);
        }}
        style={{
          color: 'var(--color-action)',
          fontWeight: 600,
          textDecoration: 'none',
        }}
      >
        повідомлення
        {showCheckingIndicator ? (
          <span
            role="progressbar"
            aria-label="Перевіряємо доступність повідомлення"
            className="ml-1 inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-r-transparent align-[-0.125em]"
          />
        ) : null}
      </a>
    </MessageSummaryPreview>
  );
}
