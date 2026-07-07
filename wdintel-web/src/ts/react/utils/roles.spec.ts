import { describe, expect, it } from 'vitest';
import { hasAnyRole, hasRole } from './roles';

describe('roles', () => {
  it('keeps the frontend hierarchy aligned with backend role checks', () => {
    expect(hasRole(['Admin'], 'Rer')).toBe(true);
    expect(hasRole(['Full'], 'Rer')).toBe(true);
    expect(hasRole(['Rer'], 'Basic')).toBe(true);
    expect(hasRole(['Bpla'], 'Basic')).toBe(true);
    expect(hasRole(['Full'], 'UnitsEditor')).toBe(false);
    expect(hasRole(['Admin'], 'UnitsEditor')).toBe(true);
    expect(hasRole(['Admin'], 'Orbit')).toBe(true);
    expect(hasRole(['Orbit'], 'Orbit')).toBe(true);
    expect(hasRole(['Full'], 'Orbit')).toBe(false);
    expect(hasRole(['Cyber'], 'Cyber')).toBe(true);
    expect(hasRole(['DevicesEditor'], 'DevicesEditor')).toBe(true);
    expect(hasRole(['Admin'], 'Cyber')).toBe(true);
    expect(hasRole(['Admin'], 'DevicesEditor')).toBe(true);
    expect(hasRole(['Api'], 'Cyber')).toBe(false);
    expect(hasRole(['Api'], 'DevicesEditor')).toBe(false);
    expect(hasRole(['Full'], 'Cyber')).toBe(false);
    expect(hasRole(['Full'], 'DevicesEditor')).toBe(false);
    expect(hasRole(['Rer'], 'Cyber')).toBe(false);
    expect(hasRole(['Rer'], 'DevicesEditor')).toBe(false);
    expect(hasRole(['Full'], 'DeleteMsg')).toBe(true);
    expect(hasRole(['Admin'], 'NoAutoLogout')).toBe(false);
  });

  it('checks any role through the same hierarchy', () => {
    expect(hasAnyRole(['Admin'], ['AdvancedReports'])).toBe(true);
    expect(hasAnyRole(['Full'], ['UnitsEditor', 'CallsignsEditor'])).toBe(false);
    expect(hasAnyRole(['CallsignsEditor'], ['UnitsEditor', 'CallsignsEditor'])).toBe(true);
    expect(hasAnyRole(['DevicesEditor'], ['Cyber', 'DevicesEditor'])).toBe(true);
    expect(hasAnyRole(['Api'], ['Cyber', 'DevicesEditor'])).toBe(false);
  });
});
