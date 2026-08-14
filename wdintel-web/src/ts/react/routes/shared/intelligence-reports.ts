import type { InboxMessage } from '../../../../Bindings';

export type IntelligenceReportSummary = {
  id: number;
  text: string;
  timestamp: number | null;
  date: string | null;
  time: string | null;
  groupMasterKey: string | null;
};

export function summarizeIntelligenceMessage(
  id: number,
  message: InboxMessage,
): IntelligenceReportSummary {
  return {
    id,
    text: message.text,
    timestamp: message.timestamp,
    date: message.date,
    time: message.time,
    groupMasterKey: message.groupMasterKey,
  };
}

type InboxMessageReportFields = {
  parentSignalMessageId?: number | null;
  intelligenceReports?: unknown;
};

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeReportSummary(value: unknown): IntelligenceReportSummary | null {
  const tuple = Array.isArray(value) && value.length === 2 ? value : null;
  const tupleId = optionalNumber(tuple?.[0]);
  const candidate = tuple?.[1] ?? value;
  if (candidate == null || typeof candidate !== 'object') return null;

  const report = candidate as Record<string, unknown>;
  const id =
    tupleId ??
    optionalNumber(report.id) ??
    optionalNumber(report.signalMessageId) ??
    optionalNumber(report.messageId);
  if (id == null) return null;

  return {
    id,
    text: typeof report.text === 'string' ? report.text : '',
    timestamp: optionalNumber(report.timestamp),
    date: optionalString(report.date),
    time: optionalString(report.time),
    groupMasterKey: optionalString(report.groupMasterKey),
  };
}

export function getParentSignalMessageId(message: InboxMessage): number | null {
  return optionalNumber((message as InboxMessage & InboxMessageReportFields).parentSignalMessageId);
}

export function getIntelligenceReports(message: InboxMessage): IntelligenceReportSummary[] {
  const reports = (message as InboxMessage & InboxMessageReportFields).intelligenceReports;
  if (!Array.isArray(reports)) return [];
  return reports.flatMap((report) => {
    const normalized = normalizeReportSummary(report);
    return normalized == null ? [] : [normalized];
  });
}
