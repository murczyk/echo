import type {
  MessengerAlertHistoryReq,
  MessengerAlertHistoryRsp,
  MessengerAlertPreference,
  MessengerAlertSettings,
} from '../../../../Bindings';
import { getJson, postJson, putJson } from './client';

export function getMessengerAlertSettings(signal?: AbortSignal) {
  return getJson<MessengerAlertSettings>('/api/messenger/alerts/settings', { signal });
}

export function saveMessengerAlertSettings(settings: MessengerAlertSettings) {
  return putJson<MessengerAlertSettings>('/api/messenger/alerts/settings', settings);
}

export function listMessengerAlertHistory(req: MessengerAlertHistoryReq, signal?: AbortSignal) {
  return postJson<MessengerAlertHistoryRsp>('/api/messenger/alerts/history', req, { signal });
}

export function getMessengerAlertPreference(signal?: AbortSignal) {
  return getJson<MessengerAlertPreference>('/api/user/messenger-alerts', { signal });
}

export function saveMessengerAlertPreference(preference: MessengerAlertPreference) {
  return putJson<MessengerAlertPreference>('/api/user/messenger-alerts', preference);
}
