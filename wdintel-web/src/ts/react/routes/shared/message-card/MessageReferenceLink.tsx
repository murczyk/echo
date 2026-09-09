import dayjs from 'dayjs';
import { useEffect, useState } from 'react';

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
  const { notify } = useOptionalPowerSnackbar();

  useEffect(() => {
    setSummary(EMPTY_SUMMARY);
    setUnavailable(false);
  }, [messageIdentifier]);

  const loadSummary = async () => {
    try {
      const response = await fetchInboxItemContext({ messageUid: messageIdentifier });
      if (response.message == null) {
        setUnavailable(true);
        return true;
      }
      setUnavailable(false);
      setSummary(summarizeIntelligenceMessage(response.message[0], response.message[1]));
      return true;
    } catch (error) {
      setUnavailable(true);
      notify({
        severity: 'error',
        message:
          error instanceof Error
            ? error.message
            : 'Не вдалося завантажити попередній перегляд повідомлення.',
      });
      return true;
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
