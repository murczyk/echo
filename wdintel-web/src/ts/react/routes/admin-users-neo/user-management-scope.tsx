import { createContext, useContext } from 'react';
import type { Login, Organism } from '../../../../Bindings';
import { protectedOrganismRole } from '../admin-organisms-neo/management-context';
import { ROLE_OPTIONS } from './user-types';

export const UserManagementScope = createContext<Organism | null>(null);
export const useUserManagementScope = () => useContext(UserManagementScope);

export function userRoleOptions(organism: Organism | null) {
  return organism
    ? ROLE_OPTIONS.filter(
        (role) =>
          !protectedOrganismRole(role) &&
          (role === 'OrganismAdmin' || organism.roles.includes(role)),
      )
    : ROLE_OPTIONS;
}

export function canManageUser(organism: Organism | null, user: Login) {
  return !organism || (user.organismId === organism.id && !user.roles.some(protectedOrganismRole));
}
