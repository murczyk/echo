import { forwardRef } from 'react';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';

export type MessageCardDisabledControlCursorWrapperProps = ComponentPropsWithoutRef<'span'> & {
  disabled: boolean;
  children: ReactNode;
};

export const MessageCardDisabledControlCursorWrapper = forwardRef<
  HTMLSpanElement,
  MessageCardDisabledControlCursorWrapperProps
>(function MessageCardDisabledControlCursorWrapper({ disabled, children, style, ...props }, ref) {
  return (
    <span
      {...props}
      ref={ref}
      data-disabled-control-cursor-wrapper
      data-disabled={disabled ? 'true' : undefined}
      style={{
        display: 'inline-flex',
        ...(disabled ? { cursor: 'not-allowed' } : {}),
        ...style,
      }}
    >
      {children}
    </span>
  );
});
