import type { EchoAccountF1 } from '../../../../Bindings';

type EchoAccountLegacy = {
  id: number;
  area_of_responsibility: EchoAccountF1['areaOfResponsibility'];
  status: string;
  created_at: number;
  client_id: number | null;
  display_name: string;
  system_service_name: string | null;
  description: string | null;
  messenger: string;
  phone_number: string;
  api_login: string | null;
  api_endpoint: string | null;
  can_read_messages?: boolean | null;
  can_send_messages?: boolean | null;
  is_linked: boolean;
  is_imported: boolean;
  signal_port: string | null;
  process_name: string | null;
  attachments_path: string | null;
  echo_client_id: string | null;
  echo_account_id: string | null;
  echo_client_lock_id: string | null;
};

export function transformAccounts(
  accounts: Array<EchoAccountF1 | EchoAccountLegacy>,
): EchoAccountF1[] {
  // transform objects from BE model to FE model
  return accounts.map((account) => ({
    id: account.id,
    areaOfResponsibility:
      'areaOfResponsibility' in account
        ? account.areaOfResponsibility
        : account.area_of_responsibility,
    status: account.status,
    createdAt: 'createdAt' in account ? account.createdAt : account.created_at,
    clientId: 'clientId' in account ? account.clientId : account.client_id,
    displayName: 'displayName' in account ? account.displayName : account.display_name,
    systemServiceName:
      'systemServiceName' in account ? account.systemServiceName : account.system_service_name,
    canReadMessages:
      'canReadMessages' in account ? account.canReadMessages : (account.can_read_messages ?? null),
    canSendMessages:
      'canSendMessages' in account ? account.canSendMessages : (account.can_send_messages ?? null),
    description: account.description,
    messenger: account.messenger,
    phoneNumber: 'phoneNumber' in account ? account.phoneNumber : account.phone_number,
    apiLogin: 'apiLogin' in account ? account.apiLogin : account.api_login,
    apiEndpoint: 'apiEndpoint' in account ? account.apiEndpoint : account.api_endpoint,
    isLinked: 'isLinked' in account ? account.isLinked : account.is_linked,
    isImported: 'isImported' in account ? account.isImported : account.is_imported,
    signalPort: 'signalPort' in account ? account.signalPort : account.signal_port,
    processName: 'processName' in account ? account.processName : account.process_name,
    attachmentsPath:
      'attachmentsPath' in account ? account.attachmentsPath : account.attachments_path,
    echoClientId: 'echoClientId' in account ? account.echoClientId : account.echo_client_id,
    echoAccountId: 'echoAccountId' in account ? account.echoAccountId : account.echo_account_id,
    echoClientLockId:
      'echoClientLockId' in account ? account.echoClientLockId : account.echo_client_lock_id,
  }));
}
