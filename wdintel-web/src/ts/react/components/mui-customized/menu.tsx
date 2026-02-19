import { Menu as MuiMenu, MenuProps as MuiMenuProps } from '@mui/material';
import React from 'react';

export const Menu = React.forwardRef(function Menu(
  { children, ...props }: MuiMenuProps,
  ref: React.ForwardedRef<HTMLDivElement>,
) {
  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
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
        'aria-labelledby': 'basic-button',
      }}
      sx={{
        '& .MuiList-padding:focus': {
          outline: 0,
        },
        '& .MuiMenu-list': {
          paddingTop: 0,
          paddingBottom: 0,
        },
        '& .MuiList-root': {
          paddingTop: 0,
          paddingBottom: 0,
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
