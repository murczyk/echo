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
  groupName: null,
  groupMasterKey: null,
  coords: null,
  mediaFileNames: [],
};
const MESSAGE_REFERENCE_RESOLUTION_TTL_MS = 5_000;
const MESSAGE_REFERENCE_ERROR_RESOLUTION_TTL_MS = 1_000;

type MessageReferenceResolution =
  { kind: 'available' } | { kind: 'unavailable' } | { kind: 'error'; error: unknown };

type CachedMessageReferenceResolution = {
  resolution: MessageReferenceResolution;
  expiresAt: number;
};

function summaryTime(summary: IntelligenceReportSummary): string | null {
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
  const pendingResolutionRef = useRef<Promise<MessageReferenceResolution> | null>(null);
  const cachedResolutionRef = useRef<CachedMessageReferenceResolution | null>(null);
  const { notify } = useOptionalPowerSnackbar();

  useEffect(() => {
    setSummary(EMPTY_SUMMARY);
    setUnavailable(false);
    pendingResolutionRef.current = null;
    cachedResolutionRef.current = null;
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

    const resolution = fetchInboxItemContext({ messageUid: messageIdentifier })
      .then((response): MessageReferenceResolution => {
        if (response.message == null) {
          setUnavailable(true);
          return { kind: 'unavailable' };
        }
        setUnavailable(false);
        setSummary(summarizeIntelligenceMessage(response.message[0], response.message[1]));
        return { kind: 'available' };
      })
      .catch((error): MessageReferenceResolution => {
        setUnavailable(false);
        return { kind: 'error', error };
      })
      .then((result) => {
        cachedResolutionRef.current = {
          resolution: result,
          expiresAt:
            Date.now() +
            (result.kind === 'error'
              ? MESSAGE_REFERENCE_ERROR_RESOLUTION_TTL_MS
              : MESSAGE_REFERENCE_RESOLUTION_TTL_MS),
        };
        return result;
      });
    pendingResolutionRef.current = resolution;
    void resolution.then(() => {
      if (pendingResolutionRef.current === resolution) pendingResolutionRef.current = null;
    });
    return resolution;
  };

  const loadSummary = async () => {
    const resolution = await resolveMessageReference();
    if (resolution.kind === 'error') {
      notify({
        severity: 'error',
        message:
          resolution.error instanceof Error
            ? resolution.error.message
            : 'Не вдалося завантажити попередній перегляд повідомлення.',
      });
    }
    return resolution.kind !== 'error';
  };

  const openMessageReference = async (event: MouseEvent<HTMLAnchorElement>) => {
    if (getCachedResolution()?.kind === 'available') return;
    event.preventDefault();
    const resolution = await resolveMessageReference();
    if (resolution.kind === 'unavailable') {
      notify({
        severity: 'warning',
        message: 'Повідомлення видалено або у вас немає до нього доступу.',
      });
      return;
    }
    if (resolution.kind === 'error') {
      notify({
        severity: 'error',
        message: 'Не вдалося перевірити доступність повідомлення. Спробуйте ще раз.',
      });
      return;
    }

    const openedWindow = window.open(href, '_blank');
    if (openedWindow) {
      openedWindow.opener = null;
      return;
    }
    notify({
      severity: 'warning',
      message:
        'Не вдалося відкрити повідомлення у новій вкладці. Перевірте налаштування браузера та спробуйте ще раз.',
    });
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
      </a>
    </MessageSummaryPreview>
  );
}
