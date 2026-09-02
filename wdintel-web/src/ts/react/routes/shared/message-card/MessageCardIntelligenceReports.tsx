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
  editable,
}: {
  summary: IntelligenceReportSummary;
  editable: boolean;
}) {
  const textToShow = getSummaryDisplayText(summary);

  return (
    <span className="flex min-w-0 items-center gap-1 text-xs font-semibold text-(--color-action)">
      {editable ? <EditIcon sx={{ fontSize: 15, flexShrink: 0 }} aria-hidden /> : null}
      <span className="truncate min-w-0">{textToShow}</span>
    </span>
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
              className="w-fit max-w-full min-w-0 border-l-4 border-solid border-(--color-divider) py-1 pl-2"
              aria-label="Оригінальне повідомлення"
              tabIndex={0}
            >
              <MessageSummaryDetails summary={currentParent} editable={false} />
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
                  className="w-fit max-w-full min-w-0 border-l-4 border-solid border-(--color-divider) py-1 pl-2"
                  tabIndex={!editReport ? 0 : undefined}
                >
                  {editReport ? (
                    <button
                      type="button"
                      className="block w-full min-w-0 cursor-pointer border-0 bg-transparent p-0 text-left text-inherit"
                      aria-label="Редагувати розвіддонесення"
                      onClick={() => editReport(currentReport.id)}
                    >
                      <MessageSummaryDetails summary={currentReport} editable />
                    </button>
                  ) : (
                    <MessageSummaryDetails summary={currentReport} editable={false} />
                  )}
                </article>
              );
            }}
          </RefreshableMessageSummaryPreview>
        );
      })}
    </div>
  );
}
