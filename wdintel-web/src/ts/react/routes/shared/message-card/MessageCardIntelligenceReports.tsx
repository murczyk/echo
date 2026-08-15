import EditIcon from '@mui/icons-material/Edit';
import dayjs from 'dayjs';

import type { SignalGroupEntry } from '../../../../../Bindings';
import { APP_TIME_ZONE } from '../../../utils/misc';
import type { IntelligenceReportSummary } from '../intelligence-reports';

function reportTime(report: IntelligenceReportSummary): string | null {
  if (report.timestamp != null) {
    return dayjs(report.timestamp).tz(APP_TIME_ZONE).format('DD.MM.YYYY HH:mm');
  }
  return [report.date, report.time].filter(Boolean).join(' ') || null;
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
  parents,
  groupInfos,
  onEdit,
}: {
  reports: IntelligenceReportSummary[];
  parents: IntelligenceReportSummary[];
  groupInfos: Record<string, SignalGroupEntry>;
  onEdit?: (reportId: number) => void;
}) {
  if (reports.length === 0 && parents.length === 0) return null;

  return (
    <div className="flex flex-col gap-2 min-w-0" aria-label="Пов’язані повідомлення">
      {parents.map((parent) => (
        <article
          key={parent.id}
          className="min-w-0 border-l-4 border-solid border-(--color-divider) pl-2 py-1"
          aria-label="Оригінальне повідомлення"
        >
          <MessageSummaryDetails
            summary={parent}
            label="Оригінальне повідомлення"
            groupInfos={groupInfos}
            editable={false}
          />
        </article>
      ))}
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
