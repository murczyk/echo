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
    expect(hasRole(['Full'], 'DeleteMsg')).toBe(true);
    expect(hasRole(['Admin'], 'NoAutoLogout')).toBe(false);
  });

  it('checks any role through the same hierarchy', () => {
    expect(hasAnyRole(['Admin'], ['AdvancedReports'])).toBe(true);
    expect(hasAnyRole(['Full'], ['UnitsEditor', 'CallsignsEditor'])).toBe(false);
    expect(hasAnyRole(['CallsignsEditor'], ['UnitsEditor', 'CallsignsEditor'])).toBe(true);
  });
});
