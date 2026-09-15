import { createContext, useContext, type ReactNode } from 'react';

const MessageDeviceAccessContext = createContext(false);

export function MessageDeviceAccessProvider({
  allowed,
  children,
}: {
  allowed: boolean;
  children: ReactNode;
}) {
  return (
    <MessageDeviceAccessContext.Provider value={allowed}>
      {children}
    </MessageDeviceAccessContext.Provider>
  );
}

export function useMessageDeviceAccess(): boolean {
  return useContext(MessageDeviceAccessContext);
}
