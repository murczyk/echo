export type UserRole =
  | 'Admin'
  | 'Api'
  | 'ApiAgent'
  | 'Full'
  | 'DeleteMsg'
  | 'Rer'
  | 'Bpla'
  | 'Basic'
  | 'UnitsEditor'
  | 'NetworkEditor'
  | 'CallsignsEditor'
  | 'Cyber'
  | 'CyberViewer'
  | 'CyberViewerRestricted'
  | 'AdvancedReports'
  | 'NoAutoLogout'
  | 'No2FA'
  | 'MessengerIngest'
  | 'CyberMessengers';

export function hasRole(roles: readonly string[] | null | undefined, role: UserRole): boolean {
  const has = (target: UserRole) => Boolean(roles?.includes(target));

  switch (role) {
    case 'Admin':
      return has('Admin');
    case 'Api':
      return has('Api');
    case 'ApiAgent':
      return has('ApiAgent');
    case 'Full':
      return has('Admin') || has('Full');
    case 'DeleteMsg':
      return has('Admin') || has('Full') || has('DeleteMsg');
    case 'Rer':
      return has('Admin') || has('Full') || has('Rer');
    case 'Bpla':
      return has('Admin') || has('Full') || has('Bpla');
    case 'Basic':
      return (
        has('Admin') ||
        has('Full') ||
        has('Bpla') ||
        has('Rer') ||
        has('Cyber') ||
        has('CyberViewer') ||
        has('CyberViewerRestricted') ||
        has('Basic')
      );
    case 'UnitsEditor':
      return has('Admin') || has('UnitsEditor');
    case 'NetworkEditor':
      return has('Admin') || has('NetworkEditor');
    case 'CallsignsEditor':
      return has('Admin') || has('CallsignsEditor');
    case 'Cyber':
      return has('Admin') || has('Cyber');
    case 'CyberViewer':
      return has('Admin') || has('Cyber') || has('CyberViewer');
    case 'CyberViewerRestricted':
      return hasRole(roles, 'CyberViewer') || has('CyberViewerRestricted');
    case 'AdvancedReports':
      return has('Admin') || has('AdvancedReports');
    case 'NoAutoLogout':
      return has('NoAutoLogout');
    case 'No2FA':
      return has('No2FA');
    case 'MessengerIngest':
      return has('MessengerIngest');
    case 'CyberMessengers':
      return has('CyberMessengers'); // TODO: ADD ADMIN ONCE ANALYSIS MESSENGERS FEATURE IS FULLY COVERED
  }
}

export function canUseRadioFeatures(roles: readonly string[] | null | undefined): boolean {
  return hasRole(roles, 'Rer');
}

export function hasRerOrCyber(roles: readonly string[] | null | undefined): boolean {
  return hasAnyRole(roles, ['Rer', 'CyberViewerRestricted']);
}

export function canReadDevices(roles: readonly string[] | null | undefined): boolean {
  return hasRole(roles, 'CyberViewer');
}

export function canUseMessageDevices(
  roles: readonly string[] | null | undefined,
  devicesSectionEnabled: boolean,
): boolean {
  return devicesSectionEnabled && hasRole(roles, 'CyberViewer');
}

export type DevicesCapabilities = {
  canRead: boolean;
  canCreate: boolean;
  canWriteSourceData: boolean;
  canWriteAnalyticalData: boolean;
};

export function resolveDevicesCapabilities(
  roles: readonly string[] | null | undefined,
): DevicesCapabilities {
  const hasDeviceAccess = canReadDevices(roles);

  return {
    canRead: hasDeviceAccess,
    canCreate: hasDeviceAccess,
    canWriteSourceData: hasDeviceAccess,
    canWriteAnalyticalData: hasRole(roles, 'Cyber'),
  };
}

export function hasAnyRole(
  roles: readonly string[] | null | undefined,
  requiredRoles: readonly UserRole[],
): boolean {
  return requiredRoles.some((role) => hasRole(roles, role));
}

export function canWriteMessages(roles: readonly string[] | null | undefined): boolean {
  return hasAnyRole(roles, ['Rer', 'Cyber']);
}
