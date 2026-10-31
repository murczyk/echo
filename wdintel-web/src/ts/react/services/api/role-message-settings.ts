import type {
  MessageCreationSettings,
  RoleMessageSettings,
  RoleMessageSettingsListRsp,
} from '../../../../Bindings';
import { getJson, postJson } from './client';

export function listRoleMessageSettings(): Promise<RoleMessageSettingsListRsp> {
  return postJson('/api/admin/role-message-settings/list');
}

export function saveRoleMessageSettings(
  settings: RoleMessageSettings,
  editing: boolean,
): Promise<RoleMessageSettings> {
  return postJson(`/api/admin/role-message-settings/${editing ? 'update' : 'create'}`, settings);
}

export function deleteRoleMessageSettings(role: string): Promise<void> {
  return postJson('/api/admin/role-message-settings/delete', { role });
}

export function getMessageCreationSettings(signal?: AbortSignal): Promise<MessageCreationSettings> {
  return getJson('/api/1.1/submit-direct/settings', { signal });
}
