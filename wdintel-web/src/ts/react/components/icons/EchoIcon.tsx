import { SvgIcon } from '@mui/material';
import type { SvgIconProps } from '@mui/material';

export function EchoIcon(props: SvgIconProps) {
  const { titleAccess, ...svgProps } = props;

  return (
    <SvgIcon viewBox="0 0 24 24" titleAccess={titleAccess} {...svgProps}>
      <g
        fill="none"
        stroke="currentColor"
        strokeLinecap="butt"
        strokeLinejoin="miter"
        strokeWidth="1.45"
      >
        <path d="M1.2 12H9.05" />
        <path d="M4.15 4.55L9.15 12L4.15 19.45" />
        <path d="M14.85 4.55L10.15 12L14.85 19.45" />
        <path d="M17.95 4.55L13.25 12L17.95 19.45" />
        <path d="M21.05 4.55L16.35 12L21.05 19.45" />
      </g>
    </SvgIcon>
  );
}
