import { createContext, useContext } from 'react';

export const MessageWriteAccessContext = createContext(true);

export function useMessageWriteAccess(): boolean {
  return useContext(MessageWriteAccessContext);
}

export const MessageDeleteAccessContext = createContext(false);

export function useMessageDeleteAccess(): boolean {
  return useContext(MessageDeleteAccessContext);
}
