import type { InboxMessage, InboxMessageSummary } from '../../../../Bindings';

export type IntelligenceReportSummary = InboxMessageSummary;

export function summarizeIntelligenceMessage(
  id: number,
  message: InboxMessage,
): IntelligenceReportSummary {
  return {
    id,
    isAccessible: true,
    isDeleted: false,
    text: message.text,
    attachmentsCount: message.media.length,
    timestamp: message.timestamp,
    date: message.date,
    time: message.time,
    groupName: null,
    groupMasterKey: message.groupMasterKey,
  };
}

export function getParentMessages(message: InboxMessage): InboxMessageSummary[] {
  return message.parentMessages ?? [];
}

export function getAccessibleParentMessages(message: InboxMessage): InboxMessageSummary[] {
  return getParentMessages(message).filter((parent) => parent.isAccessible && !parent.isDeleted);
}

export function getIntelligenceReports(message: InboxMessage): InboxMessageSummary[] {
  return message.intelligenceReports ?? [];
}

export function isIntelligenceReport(message: InboxMessage): boolean {
  return getAccessibleParentMessages(message).length > 0;
}
