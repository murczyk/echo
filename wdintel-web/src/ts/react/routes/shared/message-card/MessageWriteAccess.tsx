import { createContext, useContext } from 'react';

export const MessageWriteAccessContext = createContext(true);

export function useMessageWriteAccess(): boolean {
  return useContext(MessageWriteAccessContext);
}
