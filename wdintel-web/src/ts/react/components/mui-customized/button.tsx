import { ButtonProps, Button as MuiButton } from '@mui/material';
import React from 'react';

export const Button = React.forwardRef(function Button(props: ButtonProps, ref: React.ForwardedRef<HTMLButtonElement>) {
  const isSubmitting = React.useRef(false);

  function onClick(event: React.MouseEvent<HTMLButtonElement>) {
    if (isSubmitting.current) return;
    isSubmitting.current = true;

    props.onClick?.(event);

    setTimeout(() => {
      isSubmitting.current = false;
    }, 400);
  }

  return <MuiButton ref={ref} style={{ whiteSpace: 'nowrap', ...props.style }} {...props} onClick={onClick} />;
});
