import useMediaQuery from '@mui/material/useMediaQuery';

import { designTokens } from '../../../../design-system/design-tokens';

export function useDeviceMobileLayout() {
  return useMediaQuery(`(width < ${designTokens.breakpoint.lg})`);
}
