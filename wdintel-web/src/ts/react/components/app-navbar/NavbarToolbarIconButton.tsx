import { IconButton, type IconButtonProps } from '@mui/material';
import { forwardRef } from 'react';

export const NavbarToolbarIconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function NavbarToolbarIconButton({ className, ...props }, ref) {
    return (
      <IconButton
        {...props}
        ref={ref}
        className={`!h-[40px] !w-[40px] !rounded-sm !p-2 text-white transition-colors hover:bg-black/10 focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-1 aria-[expanded=true]:bg-black/15 ${className ?? ''}`}
      />
    );
  },
);
