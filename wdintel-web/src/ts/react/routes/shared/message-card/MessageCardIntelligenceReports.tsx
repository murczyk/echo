import EditIcon from '@mui/icons-material/Edit';
import dayjs from 'dayjs';
import { useEffect, useState, type ReactElement } from 'react';

import type { SignalGroupEntry } from '../../../../../Bindings';
import { useOptionalPowerSnackbar } from '../../../components/PowerSnackbar';
import { fetchMessagesByIds } from '../../../services/api/inbox-messages';
import { APP_TIME_ZONE } from '../../../utils/misc';
import {
  summarizeIntelligenceMessage,
  type IntelligenceReportSummary,
} from '../intelligence-reports';
import { MessageSummaryPreview } from './MessageSummaryPreview';

function reportTime(report: IntelligenceReportSummary): string | null {
  if (report.isTimeNull === true) {
    return (
      report.date ??
      (report.timestamp == null
        ? null
        : dayjs(report.timestamp).tz(APP_TIME_ZONE).format('DD.MM.YYYY'))
    );
  }
  if (report.timestamp != null) {
    return dayjs(report.timestamp).tz(APP_TIME_ZONE).format('DD.MM.YYYY HH:mm');
  }
  return [report.date, report.time].filter(Boolean).join(' ') || null;
}

function messageSummaryInfo(
  summary: IntelligenceReportSummary,
  groupInfos: Record<string, SignalGroupEntry>,
) {
  return {
    groupName:
      summary.groupName ??
      (summary.groupMasterKey
        ? (groupInfos[summary.groupMasterKey]?.name ?? summary.groupMasterKey)
        : null),
    time: reportTime(summary),
  };
}

export function getSummaryDisplayText(summary: IntelligenceReportSummary): string {
  const text = summary.text.trim();
  if (text !== '') return text;

  const fileNames = summary.mediaFileNames?.filter((name) => name.trim() !== '') ?? [];
  const coords = summary.coords?.trim();

  if (fileNames.length > 0 && coords) {
    return `${fileNames.join(', ')} · ${coords}`;
  }
  if (fileNames.length > 0) {
    return fileNames.join(', ');
  }
  if (coords) {
    return coords;
  }
  if (summary.attachmentsCount > 0) {
    return summary.attachmentsCount === 1 ? 'Вкладення' : `Вкладення (${summary.attachmentsCount})`;
  }
  return 'Без тексту';
}

export function hasVisibleMessageCardIntelligenceReports(
  reports: IntelligenceReportSummary[],
  parents: IntelligenceReportSummary[],
): boolean {
  return (
    parents.some((parent) => parent.isAccessible && !parent.isDeleted) ||
    reports.some((report) => !report.isDeleted)
  );
}

function MessageSummaryDetails({
  summary,
  onEdit,
  isParent = false,
}: {
  summary: IntelligenceReportSummary;
  onEdit?: () => void;
  isParent?: boolean;
}) {
  const textToShow = getSummaryDisplayText(summary);

  return (
    <div
      className={`flex min-w-0 items-start gap-1 text-base font-normal leading-[1.43] ${
        isParent ? 'text-(--color-action)' : 'text-(--echo-color-text)'
      }`}
    >
      {onEdit ? (
        <button
          type="button"
          className="message-card-intelligence-report-edit"
          aria-label="Редагувати розвіддонесення"
          onClick={(e) => {
            e.stopPropagation();
            onEdit();
          }}
        >
          <EditIcon aria-hidden />
        </button>
      ) : null}
      <span className="line-clamp-3 min-w-0 whitespace-pre-wrap wrap-break-word overflow-hidden">
        {textToShow}
      </span>
    </div>
  );
}

function RefreshableMessageSummaryPreview({
  summary,
  label,
  groupInfos,
  children,
}: {
  summary: IntelligenceReportSummary;
  label: string;
  groupInfos: Record<string, SignalGroupEntry>;
  children: (currentSummary: IntelligenceReportSummary) => ReactElement;
}) {
  const [currentSummary, setCurrentSummary] = useState(summary);
  const { notify } = useOptionalPowerSnackbar();

  useEffect(() => setCurrentSummary(summary), [summary]);

  const refreshSummary = async () => {
    try {
      const [message] = await fetchMessagesByIds([summary.id]);
      if (!message) throw new Error('Пов’язане повідомлення не знайдено.');
      setCurrentSummary(summarizeIntelligenceMessage(message[0], message[1]));
      return true;
    } catch (error) {
      notify({
        severity: 'error',
        message:
          error instanceof Error
            ? error.message
            : 'Не вдалося оновити попередній перегляд повідомлення.',
      });
      return false;
    }
  };
  const info = messageSummaryInfo(currentSummary, groupInfos);

  return (
    <MessageSummaryPreview
      summary={currentSummary}
      label={label}
      {...info}
      onBeforeOpen={refreshSummary}
    >
      {children(currentSummary)}
    </MessageSummaryPreview>
  );
}

export function MessageCardIntelligenceReports({
  reports,
  parents,
  groupInfos,
  onEdit,
}: {
  reports: IntelligenceReportSummary[];
  parents: IntelligenceReportSummary[];
  groupInfos: Record<string, SignalGroupEntry>;
  onEdit?: (reportId: number) => void;
}) {
  const visibleParents = parents.filter((parent) => parent.isAccessible && !parent.isDeleted);
  const visibleReports = reports.filter((report) => !report.isDeleted);

  if (visibleParents.length === 0 && visibleReports.length === 0) return null;

  return (
    <div className="flex min-w-0 flex-col items-start gap-2" aria-label="Пов’язані повідомлення">
      {visibleParents.map((parent) => (
        <RefreshableMessageSummaryPreview
          key={parent.id}
          summary={parent}
          label="Оригінальне повідомлення"
          groupInfos={groupInfos}
        >
          {(currentParent) => (
            <article
              className="message-card-intelligence-report"
              data-message-card-intelligence-report="true"
              aria-label="Оригінальне повідомлення"
              tabIndex={0}
            >
              <MessageSummaryDetails summary={currentParent} isParent />
            </article>
          )}
        </RefreshableMessageSummaryPreview>
      ))}
      {visibleReports.map((report) => {
        return (
          <RefreshableMessageSummaryPreview
            key={report.id}
            summary={report}
            label="Розвіддонесення"
            groupInfos={groupInfos}
          >
            {(currentReport) => {
              const editReport =
                currentReport.isAccessible && !currentReport.isDeleted ? onEdit : undefined;

              return (
                <article
                  className="message-card-intelligence-report"
                  data-message-card-intelligence-report="true"
                  tabIndex={0}
                >
                  <MessageSummaryDetails
                    summary={currentReport}
                    onEdit={editReport ? () => editReport(currentReport.id) : undefined}
                  />
                </article>
              );
            }}
          </RefreshableMessageSummaryPreview>
        );
      })}
    </div>
  );
}
