import { Menu as MuiMenu, MenuProps as MuiMenuProps } from '@mui/material';
import { forwardRef } from 'react';
import type { ForwardedRef, KeyboardEvent } from 'react';

export const Menu = forwardRef(function Menu(
  { children, slotProps, sx, ...props }: MuiMenuProps,
  ref: ForwardedRef<HTMLDivElement>,
) {
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Escape') {
      event.stopPropagation();
    }
  }

  const legacyMenuListProps = (props as { MenuListProps?: Record<string, unknown> }).MenuListProps;
  const { MenuListProps: _ignoredMenuListProps, ...restProps } = props as MuiMenuProps & { MenuListProps?: Record<string, unknown> };

  return (
    <MuiMenu
      ref={ref}
      elevation={3}
      slotProps={{
        ...slotProps,
        list: {
          'aria-labelledby': slotProps?.list?.['aria-labelledby'] || legacyMenuListProps?.['aria-labelledby'] || 'basic-button',
          ...legacyMenuListProps,
          ...slotProps?.list,
        },
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
      {...restProps}
    >
      <div onKeyDown={onKeyDown}>{children}</div>
    </MuiMenu>
  );
});
