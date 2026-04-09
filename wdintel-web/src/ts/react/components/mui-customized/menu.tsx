import { Menu as MuiMenu, MenuProps as MuiMenuProps } from '@mui/material';
import { forwardRef } from 'react';
import type { ForwardedRef, KeyboardEvent } from 'react';

export const Menu = forwardRef(function Menu(
  { children, MenuListProps, sx, ...props }: MuiMenuProps,
  ref: ForwardedRef<HTMLDivElement>,
) {
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Escape') {
      event.stopPropagation();
    }
  }

  return (
    <MuiMenu
      ref={ref}
      disableAutoFocus
      elevation={3}
      MenuListProps={{
        'aria-labelledby': MenuListProps?.['aria-labelledby'] || 'basic-button',
        ...MenuListProps,
      }}
      sx={{
        ...(sx || {}),
        '& .MuiList-padding:focus': {
          outline: 0,
        },
      }}
      anchorOrigin={
        props.anchorOrigin || {
          vertical: 'center',
          horizontal: 'right',
        }
      }
      transformOrigin={
        props.transformOrigin || {
          vertical: 'center',
          horizontal: -10,
        }
      }
      {...props}
    >
      <div onKeyDown={onKeyDown}>{children}</div>
    </MuiMenu>
  );
});
