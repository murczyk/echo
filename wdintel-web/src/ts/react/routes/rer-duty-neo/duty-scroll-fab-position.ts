export type DutyWorkspaceFabAvoidance = 'none' | 'above' | 'left';

export const DUTY_SCROLL_FAB_SIZE = 35;
export const DUTY_SCROLL_FAB_GAP = 12;
export const DUTY_SCROLL_FAB_STACK_OFFSET = DUTY_SCROLL_FAB_SIZE + DUTY_SCROLL_FAB_GAP;

const DUTY_SAFE_BOTTOM = 'max(12px, env(safe-area-inset-bottom, 0px))';
const DUTY_SAFE_RIGHT = 'max(12px, env(safe-area-inset-right, 0px))';

export function resolveDutyScrollFabPosition({
  narrowScreen,
  workspaceFabAvoidance = 'none',
}: {
  narrowScreen: boolean;
  workspaceFabAvoidance?: DutyWorkspaceFabAvoidance;
}): { bottom: number | string; right: number | string } {
  if (workspaceFabAvoidance === 'above') {
    return {
      bottom: `calc(${DUTY_SAFE_BOTTOM} + ${DUTY_SCROLL_FAB_STACK_OFFSET}px)`,
      right: DUTY_SAFE_RIGHT,
    };
  }

  if (workspaceFabAvoidance === 'left') {
    return { bottom: '12px', right: '59px' };
  }

  return narrowScreen
    ? { bottom: DUTY_SAFE_BOTTOM, right: DUTY_SAFE_RIGHT }
    : { bottom: '12px', right: '20px' };
}
