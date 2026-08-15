import EditIcon from '@mui/icons-material/Edit';
import { Tooltip } from '@mui/material';
import dayjs from 'dayjs';
import type { ReactElement } from 'react';

import type { SignalGroupEntry } from '../../../../../Bindings';
import { APP_TIME_ZONE } from '../../../utils/misc';
import type { IntelligenceReportSummary } from '../intelligence-reports';

const MESSAGE_SUMMARY_TOOLTIP_DELAY_MS = 700;

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

function MessageSummaryTooltip({
  summary,
  groupInfos,
  children,
}: {
  summary: IntelligenceReportSummary;
  groupInfos: Record<string, SignalGroupEntry>;
  children: ReactElement;
}) {
  if (!summary.isAccessible || summary.isDeleted) return children;

  const { groupName, time } = messageSummaryInfo(summary, groupInfos);

  return (
    <Tooltip
      arrow
      enterDelay={MESSAGE_SUMMARY_TOOLTIP_DELAY_MS}
      enterNextDelay={MESSAGE_SUMMARY_TOOLTIP_DELAY_MS}
      placement="top-start"
      slotProps={{
        tooltip: {
          sx: {
            maxWidth: 448,
            p: 1.5,
            color: 'text.primary',
            bgcolor: 'background.paper',
            border: '1px solid',
            borderColor: 'divider',
            boxShadow: 6,
          },
        },
        arrow: { sx: { color: 'background.paper' } },
      }}
      title={
        <div data-testid={`message-summary-tooltip-${summary.id}`}>
          <div className="max-h-60 overflow-y-auto whitespace-pre-wrap wrap-break-word text-sm leading-5">
            {summary.text.trim() || `Повідомлення #${summary.id}`}
          </div>
          <dl className="mt-3 grid gap-1 text-xs">
            <div className="flex gap-1">
              <dt className="font-semibold">Група:</dt>
              <dd className="m-0 wrap-break-word">{groupName ?? 'Без групи'}</dd>
            </div>
            <div className="flex gap-1">
              <dt className="font-semibold">Дата і час:</dt>
              <dd className="m-0">{time ?? 'Не вказано'}</dd>
            </div>
            <div className="flex gap-1">
              <dt className="font-semibold">Вкладення:</dt>
              <dd className="m-0">{summary.attachmentsCount}</dd>
            </div>
          </dl>
        </div>
      }
    >
      {children}
    </Tooltip>
  );
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
    <div className="flex flex-col gap-2 min-w-0" aria-label="Пов’язані повідомлення">
      {parents.map((parent) => (
        <MessageSummaryTooltip key={parent.id} summary={parent} groupInfos={groupInfos}>
          <article
            className="min-w-0 border-l-4 border-solid border-(--color-divider) pl-2 py-1"
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
        </MessageSummaryTooltip>
      ))}
      {visibleReports.map((report) => {
        const editReport = report.isAccessible && !report.isDeleted ? onEdit : undefined;

        return (
          <MessageSummaryTooltip key={report.id} summary={report} groupInfos={groupInfos}>
            <article
              className="min-w-0 border-l-4 border-solid border-(--color-divider) pl-2 py-1"
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
          </MessageSummaryTooltip>
        );
      })}
    </div>
  );
}
