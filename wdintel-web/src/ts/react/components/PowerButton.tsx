import { ButtonProps, Button as MuiButton } from '@mui/material';
import { forwardRef, useRef } from 'react';
import type { ForwardedRef, MouseEvent } from 'react';

export const PowerButton = forwardRef(function PowerButton(
  props: ButtonProps,
  ref: ForwardedRef<HTMLButtonElement>,
) {
  const isSubmitting = useRef(false);

  function onClick(event: MouseEvent<HTMLButtonElement>) {
    if (isSubmitting.current) return;
    isSubmitting.current = true;

    props.onClick?.(event);

    setTimeout(() => {
      isSubmitting.current = false;
    }, 400);
  }

  return (
    <MuiButton
      ref={ref}
      style={{ whiteSpace: 'nowrap', ...props.style }}
      {...props}
      onClick={onClick}
    />
  );
});
