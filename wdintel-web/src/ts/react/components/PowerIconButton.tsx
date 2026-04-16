import { IconButton as MuiIconButton, IconButtonProps } from '@mui/material';
import { forwardRef, useRef } from 'react';
import type { ForwardedRef, MouseEvent } from 'react';

export const PowerIconButton = forwardRef(function PowerIconButton(
  props: IconButtonProps,
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

  return <MuiIconButton ref={ref} {...props} onClick={onClick} />;
});
