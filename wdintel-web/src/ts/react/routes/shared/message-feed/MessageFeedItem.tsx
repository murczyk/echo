import { createContext, useContext, type HTMLAttributes, type ReactNode } from 'react';
import type { MessageFeedId, WindowedFeedScrollHandle } from './message-feed.types';

const ItemRegistrationContext = createContext<
  WindowedFeedScrollHandle<MessageFeedId>['setItemRef'] | null
>(null);

export function MessageFeedItemRegistration({
  setItemRef,
  children,
}: {
  setItemRef: WindowedFeedScrollHandle<MessageFeedId>['setItemRef'];
  children: ReactNode;
}) {
  return (
    <ItemRegistrationContext.Provider value={setItemRef}>
      {children}
    </ItemRegistrationContext.Provider>
  );
}

export function MessageFeedItem({
  id,
  children,
  ...props
}: Omit<HTMLAttributes<HTMLDivElement>, 'id'> & { id: MessageFeedId }) {
  const setItemRef = useContext(ItemRegistrationContext);
  if (!setItemRef) throw new Error('MessageFeedItem must be inside MessageFeed');
  return (
    <div {...props} ref={setItemRef(id)}>
      {children}
    </div>
  );
}
