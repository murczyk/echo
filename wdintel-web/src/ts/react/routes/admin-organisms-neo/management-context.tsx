import { createContext, useContext } from 'react';

export const OrganismManagementContext = createContext({ globalAdmin: false });
export const useOrganismManagement = () => useContext(OrganismManagementContext);
export const protectedOrganismRole = (role: string) =>
  ['Admin', 'Api', 'ApiAgent', 'MessengerIngest', 'No2FA', 'NoAutoLogout'].includes(role);
