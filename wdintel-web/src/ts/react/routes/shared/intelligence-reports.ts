import type { InboxMessage, InboxMessageSummary } from '../../../../Bindings';
import { formatCoordinateLocality } from '../../../maps/coordinate-locality';

export type IntelligenceReportSummary = InboxMessageSummary & {
  coords?: string | null;
  mediaFileNames?: string[] | null;
};

export function summarizeIntelligenceMessage(
  id: number,
  message: InboxMessage,
): IntelligenceReportSummary {
  const mediaFileNames = (message.media ?? [])
    .map((m) => (m ? (m.fileName ?? (m as any).file_name ?? '').trim() : ''))
    .filter((name) => name !== '');

  const coords =
    message.coords?.trim() ||
    message.location?.trim() ||
    (message.coordsWithLocality && message.coordsWithLocality.length > 0
      ? message.coordsWithLocality
          .map((c) =>
            c.locality
              ? formatCoordinateLocality(c.locality)
              : c.coords
                ? `${c.coords.lat}, ${c.coords.lon}`
                : '',
          )
          .filter(Boolean)
          .join(', ')
      : null);

  return {
    id,
    isAccessible: true,
    isDeleted: false,
    text: message.text,
    attachmentsCount: message.media.length,
    timestamp: message.timestamp,
    date: message.date,
    time: message.time,
    isTimeNull: message.isTimeNull,
    groupName: null,
    groupMasterKey: message.groupMasterKey,
    coords,
    mediaFileNames,
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
  return getParentMessages(message).length > 0 && message.groupMasterKey == null;
}
