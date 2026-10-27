import { describe, expect, it } from 'vitest';
import {
  canReadDevices,
  canWriteMessages,
  canUseMessageDevices,
  hasAnyRole,
  canUseRadioFeatures,
  hasRerOrCyber,
  hasRole,
  resolveDevicesCapabilities,
} from '../roles';
describe('roles', () => {
  it('keeps the frontend hierarchy aligned with backend role checks', () => {
    expect(hasRole(['Admin'], 'Rer')).toBe(true);
    expect(hasRole(['Full'], 'Rer')).toBe(true);
    expect(hasRole(['Rer'], 'Basic')).toBe(true);
    expect(hasRole(['Bpla'], 'Basic')).toBe(true);
    expect(hasRole(['Full'], 'UnitsEditor')).toBe(false);
    expect(hasRole(['Admin'], 'UnitsEditor')).toBe(true);
    expect(hasRole(['Cyber'], 'Cyber')).toBe(true);
    expect(hasRole(['Admin'], 'Cyber')).toBe(true);
    expect(hasRole(['Api'], 'Cyber')).toBe(false);
    expect(hasRole(['Full'], 'Cyber')).toBe(false);
    expect(hasRole(['Rer'], 'Cyber')).toBe(false);
    expect(canReadDevices(['Cyber'])).toBe(true);
    expect(canReadDevices(['Admin'])).toBe(true);
    expect(canReadDevices(['Api'])).toBe(false);
    expect(canUseMessageDevices(['Cyber'], true)).toBe(true);
    expect(canUseMessageDevices(['Admin'], true)).toBe(true);
    expect(canUseMessageDevices(['Cyber'], false)).toBe(false);
    expect(hasRole(['Full'], 'DeleteMsg')).toBe(true);
    expect(hasRole(['Admin'], 'NoAutoLogout')).toBe(false);
    expect(hasRole(['No2FA'], 'No2FA')).toBe(true);
    expect(hasRole(['Admin'], 'No2FA')).toBe(false);
  });

  it.each([
    [['Cyber'], false],
    [['Cyber', 'UnitsEditor', 'NetworkEditor', 'CallsignsEditor'], false],
    [['Rer'], true],
    [['Rer', 'Cyber'], true],
    [['Admin'], true],
    [['Full', 'Cyber'], true],
    [null, false],
  ] as const)('#3568 resolves radio access for %j', (roles, expected) => {
    expect(canUseRadioFeatures(roles)).toBe(expected);
  });

  it('#3568 admits Rer or Cyber while keeping their permissions distinct', () => {
    for (const roles of [['Rer'], ['Cyber'], ['Rer', 'Cyber'], ['Admin'], ['Full']]) {
      expect(hasRerOrCyber(roles)).toBe(true);
      expect(hasRole(roles, 'Basic')).toBe(true);
    }
    for (const roles of [[], ['Basic'], ['Api'], ['ApiAgent'], null, undefined]) {
      expect(hasRerOrCyber(roles)).toBe(false);
    }
    expect(hasRole(['Cyber'], 'Rer')).toBe(false);
    expect(hasRole(['Cyber'], 'UnitsEditor')).toBe(false);
    expect(hasRole(['Cyber'], 'CallsignsEditor')).toBe(false);
    expect(hasRole(['Rer'], 'Cyber')).toBe(false);
  });

  it.each(['Cyber', 'Admin'])('grants full Devices capabilities to %s', (role) => {
    expect(resolveDevicesCapabilities([role])).toEqual({
      canRead: true,
      canCreate: true,
      canWriteSourceData: true,
      canWriteAnalyticalData: true,
    });
    expect(canWriteMessages([role])).toBe(true);
  });

  it.each([{ roles: ['DeviceSource'] }])('denies access from removed roles $roles', ({ roles }) => {
    expect(hasRole(roles, 'Basic')).toBe(false);
    expect(hasRerOrCyber(roles)).toBe(false);
    expect(canReadDevices(roles)).toBe(false);
    expect(canUseMessageDevices(roles, true)).toBe(false);
    expect(canWriteMessages(roles)).toBe(false);
    expect(resolveDevicesCapabilities(roles)).toEqual({
      canRead: false,
      canCreate: false,
      canWriteSourceData: false,
      canWriteAnalyticalData: false,
    });
  });

  it.each([['CyberViewer'], ['DeviceSource', 'CyberViewer']])(
    '#3569 restores viewer access without message or analytical writes: %j',
    (...roles) => {
      expect(hasRole(roles, 'Basic')).toBe(true);
      expect(hasRole(roles, 'CyberViewer')).toBe(true);
      expect(hasRole(roles, 'Cyber')).toBe(false);
      expect(hasRerOrCyber(roles)).toBe(true);
      expect(canUseRadioFeatures(roles)).toBe(false);
      expect(canUseMessageDevices(roles, true)).toBe(true);
      expect(canUseMessageDevices(roles, false)).toBe(false);
      expect(canWriteMessages(roles)).toBe(false);
      expect(hasRole(roles, 'DeleteMsg')).toBe(false);
      expect(resolveDevicesCapabilities(roles)).toEqual({
        canRead: true,
        canCreate: true,
        canWriteSourceData: true,
        canWriteAnalyticalData: false,
      });
    },
  );

  it.each(['Cyber', 'Rer', 'Full', 'Admin'])(
    '#3569 preserves additional write permissions for CyberViewer with %s',
    (role) => {
      expect(canWriteMessages(['CyberViewer', role])).toBe(true);
    },
  );

  it('grants restricted viewers the shared permissions without any device capability', () => {
    const roles = ['CyberViewerRestricted'];
    expect(hasRole(roles, 'Basic')).toBe(true);
    expect(hasRerOrCyber(roles)).toBe(true);
    expect(hasRole(roles, 'CyberViewer')).toBe(false);
    expect(canUseRadioFeatures(roles)).toBe(false);
    expect(canWriteMessages(roles)).toBe(false);
    expect(canUseMessageDevices(roles, true)).toBe(false);
    expect(resolveDevicesCapabilities(roles)).toEqual({
      canRead: false,
      canCreate: false,
      canWriteSourceData: false,
      canWriteAnalyticalData: false,
    });
  });

  it.each(['Rer', 'Full', 'CyberViewer', 'Cyber', 'Admin'])(
    'keeps restricted viewer permissions additive with %s',
    (role) => {
      const roles = ['CyberViewerRestricted', role];
      expect(hasRerOrCyber(roles)).toBe(true);
      expect(canUseMessageDevices(roles, true)).toBe(canUseMessageDevices([role], true));
      expect(resolveDevicesCapabilities(roles)).toEqual(resolveDevicesCapabilities([role]));
      expect(canWriteMessages(roles)).toBe(canWriteMessages([role]));
    },
  );

  it('checks any role through the same hierarchy', () => {
    expect(hasAnyRole(['Admin'], ['AdvancedReports'])).toBe(true);
    expect(hasAnyRole(['Full'], ['UnitsEditor', 'CallsignsEditor'])).toBe(false);
    expect(hasAnyRole(['CallsignsEditor'], ['UnitsEditor', 'CallsignsEditor'])).toBe(true);
    expect(hasAnyRole(['Cyber'], ['Cyber', 'Rer'])).toBe(true);
    expect(hasAnyRole(['Api'], ['Cyber', 'Rer'])).toBe(false);
  });
});
