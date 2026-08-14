import type { InboxMessage, InboxMessageSummary } from '../../../../Bindings';

export type IntelligenceReportSummary = InboxMessageSummary;

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

export function getParentMessages(message: InboxMessage): InboxMessageSummary[] {
  return message.parentMessages ?? [];
}

export function getIntelligenceReports(message: InboxMessage): InboxMessageSummary[] {
  return message.intelligenceReports ?? [];
}

export function isIntelligenceReport(message: InboxMessage): boolean {
  return getParentMessages(message).length > 0;
}
