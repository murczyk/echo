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
  | 'DeviceSource'
  | 'DeviceAnalyst'
  | 'AdvancedReports'
  | 'Orbit'
  | 'NoAutoLogout';

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
      return has('Admin') || has('Full') || has('Bpla') || has('Rer') || has('Basic');
    case 'UnitsEditor':
      return has('Admin') || has('UnitsEditor');
    case 'NetworkEditor':
      return has('Admin') || has('NetworkEditor');
    case 'CallsignsEditor':
      return has('Admin') || has('CallsignsEditor');
    case 'Cyber':
      return has('Admin') || has('Cyber');
    case 'DeviceSource':
      return has('Admin') || has('DeviceSource') || has('DeviceAnalyst');
    case 'DeviceAnalyst':
      return has('Admin') || has('DeviceAnalyst');
    case 'AdvancedReports':
      return has('Admin') || has('AdvancedReports');
    case 'Orbit':
      return has('Admin') || has('Orbit');
    case 'NoAutoLogout':
      return has('NoAutoLogout');
  }
}

export function canReadDevices(roles: readonly string[] | null | undefined): boolean {
  return hasAnyRole(roles, ['Cyber', 'DeviceSource', 'DeviceAnalyst']);
}

export type DevicesCapabilities = {
  canRead: boolean;
  canWriteSourceData: boolean;
  canWriteAnalyticalData: boolean;
};

export function resolveDevicesCapabilities(
  roles: readonly string[] | null | undefined,
): DevicesCapabilities {
  const hasAssignedRole = (role: 'Admin' | 'DeviceSource' | 'DeviceAnalyst') =>
    Boolean(roles?.includes(role));

  return {
    canRead: canReadDevices(roles),
    canWriteSourceData:
      hasAssignedRole('Admin') ||
      hasAssignedRole('DeviceSource') ||
      hasAssignedRole('DeviceAnalyst'),
    canWriteAnalyticalData: hasAssignedRole('Admin') || hasAssignedRole('DeviceAnalyst'),
  };
}

export function hasAnyRole(
  roles: readonly string[] | null | undefined,
  requiredRoles: readonly UserRole[],
): boolean {
  return requiredRoles.some((role) => hasRole(roles, role));
}
