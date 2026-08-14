import EditIcon from '@mui/icons-material/Edit';
import dayjs from 'dayjs';

import type { SignalGroupEntry } from '../../../../../Bindings';
import { APP_TIME_ZONE } from '../../../utils/misc';
import type { IntelligenceReportSummary } from '../intelligence-reports';

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

export function MessageCardIntelligenceReports({
  reports,
  groupInfos,
  onEdit,
}: {
  reports: IntelligenceReportSummary[];
  groupInfos: Record<string, SignalGroupEntry>;
  onEdit?: (reportId: number) => void;
}) {
  if (reports.length === 0) return null;

  return (
    <div className="flex flex-col gap-2 min-w-0" aria-label="Розвіддонесення">
      {reports.map((report) => {
        const groupName = report.groupMasterKey
          ? (groupInfos[report.groupMasterKey]?.name ?? report.groupMasterKey)
          : null;
        const time = reportTime(report);
        return (
          <article
            key={report.id}
            className="min-w-0 border-l-4 border-solid border-(--color-divider) pl-2 py-1"
          >
            <div className="whitespace-pre-wrap wrap-break-word font-bold">
              {reportPreview(report.text)}
            </div>
            {groupName || time ? (
              <div className="mt-1 text-xs text-(--color-action)">
                {[groupName, time].filter(Boolean).join(' · ')}
              </div>
            ) : null}
            {onEdit ? (
              <button
                type="button"
                className="mt-1 inline-flex items-center gap-1 border-0 bg-transparent p-0 text-sm text-(--color-action) cursor-pointer"
                onClick={() => onEdit(report.id)}
              >
                <EditIcon sx={{ fontSize: 16 }} aria-hidden />
                Редагувати розвіддонесення
              </button>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}
