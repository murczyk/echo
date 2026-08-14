import EditIcon from '@mui/icons-material/Edit';
import dayjs from 'dayjs';
import { useEffect, useState } from 'react';

import type { SignalGroupEntry } from '../../../../../Bindings';
import { fetchMessagesByIds } from '../../../services/api/inbox-messages';
import { APP_TIME_ZONE } from '../../../utils/misc';
import {
  summarizeIntelligenceMessage,
  type IntelligenceReportSummary,
} from '../intelligence-reports';

const REPORT_PREVIEW_LENGTH = 240;

function reportPreview(text: string): string {
  const normalized = text.trim();
  if (normalized.length <= REPORT_PREVIEW_LENGTH) return normalized;
  return `${normalized.slice(0, REPORT_PREVIEW_LENGTH).trimEnd()}…`;
}

function reportTime(report: IntelligenceReportSummary): string | null {
  if (report.timestamp != null) {
    return dayjs(report.timestamp).tz(APP_TIME_ZONE).format('DD.MM.YYYY HH:mm');
  }
  return [report.date, report.time].filter(Boolean).join(' ') || null;
}

function useOriginalMessageSummary(
  parentMessageId: number | null,
): IntelligenceReportSummary | null {
  const [loadedSummary, setLoadedSummary] = useState<{
    parentMessageId: number;
    summary: IntelligenceReportSummary;
  } | null>(null);

  useEffect(() => {
    if (parentMessageId == null) return;
    let active = true;

    void fetchMessagesByIds([parentMessageId])
      .then((messages) => {
        if (!active) return;
        const original = messages.find(([id]) => id === parentMessageId);
        if (original) {
          setLoadedSummary({
            parentMessageId,
            summary: summarizeIntelligenceMessage(original[0], original[1]),
          });
        }
      })
      .catch(() => {});

    return () => {
      active = false;
    };
  }, [parentMessageId]);

  return loadedSummary?.parentMessageId === parentMessageId ? loadedSummary.summary : null;
}

function MessageSummaryDetails({
  summary,
  label,
  groupInfos,
  editable,
}: {
  summary: IntelligenceReportSummary;
  label: string;
  groupInfos: Record<string, SignalGroupEntry>;
  editable: boolean;
}) {
  const groupName = summary.groupMasterKey
    ? (groupInfos[summary.groupMasterKey]?.name ?? summary.groupMasterKey)
    : null;
  const time = reportTime(summary);

  return (
    <>
      <span className="flex items-center gap-1 text-xs font-semibold text-(--color-action)">
        {editable ? <EditIcon sx={{ fontSize: 15 }} aria-hidden /> : null}
        {label}
      </span>
      <span className="mt-1 block whitespace-pre-wrap wrap-break-word font-bold">
        {reportPreview(summary.text) || `Повідомлення #${summary.id}`}
      </span>
      {groupName || time ? (
        <span className="mt-1 block text-xs text-(--color-action)">
          {[groupName, time].filter(Boolean).join(' · ')}
        </span>
      ) : null}
    </>
  );
}

export function MessageCardIntelligenceReports({
  reports,
  parentMessageId,
  groupInfos,
  onEdit,
}: {
  reports: IntelligenceReportSummary[];
  parentMessageId: number | null;
  groupInfos: Record<string, SignalGroupEntry>;
  onEdit?: (reportId: number) => void;
}) {
  const originalSummary = useOriginalMessageSummary(parentMessageId);
  if (reports.length === 0 && parentMessageId == null) return null;

  return (
    <div className="flex flex-col gap-2 min-w-0" aria-label="Пов’язані повідомлення">
      {parentMessageId != null ? (
        <article
          className="min-w-0 border-l-4 border-solid border-(--color-divider) pl-2 py-1"
          aria-label="Оригінальне повідомлення"
        >
          <MessageSummaryDetails
            summary={
              originalSummary ?? {
                id: parentMessageId,
                text: '',
                timestamp: null,
                date: null,
                time: null,
                groupMasterKey: null,
              }
            }
            label="Оригінальне повідомлення"
            groupInfos={groupInfos}
            editable={false}
          />
        </article>
      ) : null}
      {reports.map((report) => {
        return (
          <article
            key={report.id}
            className="min-w-0 border-l-4 border-solid border-(--color-divider) pl-2 py-1"
          >
            {onEdit ? (
              <button
                type="button"
                className="block w-full min-w-0 cursor-pointer border-0 bg-transparent p-0 text-left text-inherit"
                aria-label="Редагувати розвіддонесення"
                onClick={() => onEdit(report.id)}
              >
                <MessageSummaryDetails
                  summary={report}
                  label="Розвіддонесення"
                  groupInfos={groupInfos}
                  editable
                />
              </button>
            ) : (
              <MessageSummaryDetails
                summary={report}
                label="Розвіддонесення"
                groupInfos={groupInfos}
                editable={false}
              />
            )}
          </article>
        );
      })}
    </div>
  );
}
