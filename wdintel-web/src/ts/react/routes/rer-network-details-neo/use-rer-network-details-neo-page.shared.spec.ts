import { describe, expect, it } from 'vitest';

import type { User } from '../../../../Bindings';
import {
  canDeleteNetwork,
  canEditNetwork,
  canManageDescriptions,
  canManageNetworkCallsignActions,
} from './use-rer-network-details-neo-page.shared';

function makeUser(roles: string[]): User {
  return { roles } as User;
}

describe('rer-network-details neo permissions', () => {
  it('allows network mutations only for admin or Rer-equivalent UnitsEditor users', () => {
    expect(canEditNetwork(makeUser(['Admin']))).toBe(true);
    expect(canDeleteNetwork(makeUser(['Admin']))).toBe(true);
    expect(canEditNetwork(makeUser(['Rer', 'UnitsEditor']))).toBe(true);
    expect(canDeleteNetwork(makeUser(['Rer', 'UnitsEditor']))).toBe(true);
    expect(canEditNetwork(makeUser(['Full', 'UnitsEditor']))).toBe(true);
    expect(canDeleteNetwork(makeUser(['Full', 'UnitsEditor']))).toBe(true);

    expect(canEditNetwork(makeUser(['UnitsEditor']))).toBe(false);
    expect(canDeleteNetwork(makeUser(['UnitsEditor']))).toBe(false);
    expect(canEditNetwork(makeUser(['Rer']))).toBe(false);
    expect(canDeleteNetwork(makeUser(['Rer']))).toBe(false);
  });

  it('keeps subordinate network actions aligned with network mutation permissions', () => {
    expect(canManageDescriptions(makeUser(['Full', 'UnitsEditor']))).toBe(true);
    expect(canManageNetworkCallsignActions(makeUser(['Full', 'UnitsEditor']))).toBe(true);
    expect(canManageDescriptions(makeUser(['UnitsEditor']))).toBe(false);
    expect(canManageNetworkCallsignActions(makeUser(['UnitsEditor']))).toBe(false);
  });
});
