import { describe, expect, it } from 'vitest';
import { canReadDevices, hasAnyRole, hasRole, resolveDevicesCapabilities } from './roles';

describe('roles', () => {
  it('keeps the frontend hierarchy aligned with backend role checks', () => {
    expect(hasRole(['Admin'], 'Rer')).toBe(true);
    expect(hasRole(['Full'], 'Rer')).toBe(true);
    expect(hasRole(['Rer'], 'Basic')).toBe(true);
    expect(hasRole(['Bpla'], 'Basic')).toBe(true);
    expect(hasRole(['Full'], 'UnitsEditor')).toBe(false);
    expect(hasRole(['Admin'], 'UnitsEditor')).toBe(true);
    expect(hasRole(['Cyber'], 'Cyber')).toBe(true);
    expect(hasRole(['DeviceSource'], 'Cyber')).toBe(false);
    expect(hasRole(['DeviceSource'], 'DeviceSource')).toBe(true);
    expect(hasRole(['Admin'], 'Cyber')).toBe(true);
    expect(hasRole(['Admin'], 'DeviceSource')).toBe(true);
    expect(hasRole(['Api'], 'Cyber')).toBe(false);
    expect(hasRole(['Full'], 'Cyber')).toBe(false);
    expect(hasRole(['Rer'], 'Cyber')).toBe(false);
    expect(canReadDevices(['Cyber'])).toBe(true);
    expect(canReadDevices(['DeviceSource'])).toBe(true);
    expect(canReadDevices(['Admin'])).toBe(true);
    expect(canReadDevices(['Api'])).toBe(false);
    expect(hasRole(['Full'], 'DeleteMsg')).toBe(true);
    expect(hasRole(['Admin'], 'NoAutoLogout')).toBe(false);
    expect(hasRole(['No2FA'], 'No2FA')).toBe(true);
    expect(hasRole(['Admin'], 'No2FA')).toBe(false);
  });

  it('resolves Devices capabilities by action instead of role inheritance', () => {
    expect(resolveDevicesCapabilities(['Cyber'])).toEqual({
      canRead: true,
      canCreate: true,
      canWriteSourceData: true,
      canWriteAnalyticalData: false,
    });
    expect(resolveDevicesCapabilities(['DeviceSource'])).toEqual({
      canRead: true,
      canCreate: true,
      canWriteSourceData: true,
      canWriteAnalyticalData: true,
    });
    expect(resolveDevicesCapabilities(['Cyber', 'DeviceSource'])).toEqual({
      canRead: true,
      canCreate: true,
      canWriteSourceData: true,
      canWriteAnalyticalData: true,
    });
    expect(resolveDevicesCapabilities(['Admin'])).toEqual({
      canRead: true,
      canCreate: true,
      canWriteSourceData: true,
      canWriteAnalyticalData: true,
    });
  });

  it('checks any role through the same hierarchy', () => {
    expect(hasAnyRole(['Admin'], ['AdvancedReports'])).toBe(true);
    expect(hasAnyRole(['Full'], ['UnitsEditor', 'CallsignsEditor'])).toBe(false);
    expect(hasAnyRole(['CallsignsEditor'], ['UnitsEditor', 'CallsignsEditor'])).toBe(true);
    expect(hasAnyRole(['DeviceSource'], ['Cyber', 'DeviceSource'])).toBe(true);
    expect(hasAnyRole(['Api'], ['Cyber', 'DeviceSource'])).toBe(false);
  });
});
