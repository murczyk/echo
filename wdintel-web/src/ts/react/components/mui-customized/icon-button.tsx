import { IconButton as MuiIconButton, IconButtonProps } from '@mui/material';
import React from 'react';

export const IconButton = React.forwardRef(function IconButton(
  props: IconButtonProps,
  ref: React.ForwardedRef<HTMLButtonElement>,
) {
  const isSubmitting = React.useRef(false);

  function onClick(event: React.MouseEvent<HTMLButtonElement>) {
    if (isSubmitting.current) return;
    isSubmitting.current = true;

    props.onClick?.(event);

    setTimeout(() => {
      isSubmitting.current = false;
    }, 400);
  }

  return <MuiIconButton ref={ref} {...props} onClick={onClick} />;
});
