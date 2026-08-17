import EditIcon from '@mui/icons-material/Edit';
import dayjs from 'dayjs';

import type { SignalGroupEntry } from '../../../../../Bindings';
import { APP_TIME_ZONE } from '../../../utils/misc';
import type { IntelligenceReportSummary } from '../intelligence-reports';
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
  const { groupName, time } = messageSummaryInfo(summary, groupInfos);

  return (
    <>
      <span className="flex items-center gap-1 text-xs font-semibold text-(--color-action)">
        {editable ? <EditIcon sx={{ fontSize: 15 }} aria-hidden /> : null}
        {label}
      </span>
      {summary.isDeleted ? (
        <span className="mt-1 block text-xs text-(--color-action)">Повідомлення видалено</span>
      ) : null}
      {!summary.isDeleted && (groupName || time) ? (
        <span className="mt-1 block text-xs text-(--color-action)">
          {[groupName, time].filter(Boolean).join(' · ')}
        </span>
      ) : null}
    </>
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
  const visibleReports = reports.filter((report) => !report.isDeleted);
  if (visibleReports.length === 0 && parents.length === 0) return null;

  return (
    <div className="flex min-w-0 flex-col items-start gap-2" aria-label="Пов’язані повідомлення">
      {parents.map((parent) => (
        <MessageSummaryPreview
          key={parent.id}
          summary={parent}
          label="Оригінальне повідомлення"
          {...messageSummaryInfo(parent, groupInfos)}
        >
          <article
            className="w-fit max-w-full min-w-0 border-l-4 border-solid border-(--color-divider) py-1 pl-2"
            aria-label="Оригінальне повідомлення"
            tabIndex={parent.isAccessible && !parent.isDeleted ? 0 : undefined}
          >
            <MessageSummaryDetails
              summary={parent}
              label="Оригінальне повідомлення"
              groupInfos={groupInfos}
              editable={false}
            />
          </article>
        </MessageSummaryPreview>
      ))}
      {visibleReports.map((report) => {
        const editReport = report.isAccessible && !report.isDeleted ? onEdit : undefined;

        return (
          <MessageSummaryPreview
            key={report.id}
            summary={report}
            label="Розвіддонесення"
            {...messageSummaryInfo(report, groupInfos)}
          >
            <article
              className="w-fit max-w-full min-w-0 border-l-4 border-solid border-(--color-divider) py-1 pl-2"
              tabIndex={report.isAccessible && !report.isDeleted && !editReport ? 0 : undefined}
            >
              {editReport ? (
                <button
                  type="button"
                  className="block w-full min-w-0 cursor-pointer border-0 bg-transparent p-0 text-left text-inherit"
                  aria-label="Редагувати розвіддонесення"
                  onClick={() => editReport(report.id)}
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
          </MessageSummaryPreview>
        );
      })}
    </div>
  );
}
