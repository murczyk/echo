import type { InboxMessagesReq } from '../../../../Bindings';
import { fetchInboxMessages } from '../../services/api/inbox';
import { buildMessageCardDisplayLabels } from '../shared/message-card/message-card-labels';
import {
  DutyNotificationPreviewResultKind,
  type DutyNotificationPreviewResult,
} from './notifications';
import { withDutyFeedRequestDeadline } from './dutyFeedRequestDeadline';
import { messageOrderTimestamp } from './utils';

const PREVIEW_DEADLINE_MS = 3_000;

function shortenBody(body: string | null | undefined): string | null {
  const normalized = body?.trim().replaceAll(/\s+/g, ' ') ?? '';
  if (normalized === '') return null;
  const points = Array.from(normalized);
  return points.length <= 160 ? normalized : `${points.slice(0, 159).join('')}…`;
}

export async function loadDutyNotificationPreview(
  req: InboxMessagesReq,
  isCurrent: () => boolean,
): Promise<DutyNotificationPreviewResult> {
  if (!isCurrent()) return { kind: DutyNotificationPreviewResultKind.Stale };
  try {
    const response = await withDutyFeedRequestDeadline(PREVIEW_DEADLINE_MS, (signal) =>
      fetchInboxMessages(req, { signal }),
    );
    if (!isCurrent()) return { kind: DutyNotificationPreviewResultKind.Stale };
    const groups = Object.fromEntries(
      response.signalGroups.map((group) => [group.masterKey, group]),
    );
    const newest = [...new Map(response.inboxItems).entries()]
      .map(([messageId, message]) => ({
        messageId,
        message,
        orderTimestamp: messageOrderTimestamp(message),
      }))
      .sort(
        (a, b) => (b.orderTimestamp ?? 0) - (a.orderTimestamp ?? 0) || b.messageId - a.messageId,
      )[0];
    if (!newest) return { kind: DutyNotificationPreviewResultKind.Unavailable };
    const labels = buildMessageCardDisplayLabels(newest.message, {
      groupInfos: groups,
      profiles: response.signalProfiles,
    });
    const preview = shortenBody(newest.message.noHeadersBody?.body);
    const fallback =
      newest.message.media.length > 0 || newest.message.images.length > 0
        ? 'Вкладення'
        : 'Нове повідомлення';
    const title = labels.senderName ?? labels.groupName ?? 'Нове повідомлення';
    const body =
      labels.groupName && labels.senderName
        ? `${labels.groupName}\n${preview ?? fallback}`
        : (preview ?? fallback);
    return {
      kind: DutyNotificationPreviewResultKind.Ready,
      preview: {
        messageId: newest.messageId,
        orderTimestamp: newest.orderTimestamp ?? null,
        title,
        body,
      },
    };
  } catch {
    return isCurrent()
      ? { kind: DutyNotificationPreviewResultKind.Unavailable }
      : { kind: DutyNotificationPreviewResultKind.Stale };
  }
}
