import type {
  NotificationListReq,
  NotificationListRsp,
  NotificationReadAllRsp,
  NotificationReadAllReq,
  NotificationReadReq,
  NotificationUnreadCountRsp,
} from '../../../../Bindings';
import { transformSnakeToCamel } from '../../../snake-to-camel';
import { getJson, postJson } from './client';

export const NOTIFICATION_POLL_INTERVAL_MS = 30_000;

export async function listNotifications(req: NotificationListReq): Promise<NotificationListRsp> {
  return transformSnakeToCamel<NotificationListRsp>(
    await postJson<unknown>('/api/notifications/list', {
      cursor: req.cursor,
      boundary_id: req.boundaryId,
      panel_id: req.panelId,
      known_receipt_ids: req.knownReceiptIds,
    }),
  );
}

export async function notificationUnreadCount(): Promise<number> {
  return transformSnakeToCamel<NotificationUnreadCountRsp>(
    await getJson<unknown>('/api/notifications/unread-count'),
  ).unreadCount;
}

export async function readNotification(req: NotificationReadReq): Promise<number> {
  return transformSnakeToCamel<NotificationUnreadCountRsp>(
    await postJson<unknown>('/api/notifications/read', { receipt_id: req.receiptId }),
  ).unreadCount;
}

export async function readAllNotifications(
  req: NotificationReadAllReq,
): Promise<NotificationReadAllRsp> {
  return transformSnakeToCamel<NotificationReadAllRsp>(
    await postJson<unknown>('/api/notifications/read-all', {
      boundary_receipt_id: req.boundaryReceiptId,
    }),
  );
}
