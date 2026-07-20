import {
  POWER_FLOATING_CONTROL_DESKTOP_RIGHT_INSET,
  POWER_FLOATING_CONTROL_EDGE_INSET,
  POWER_FLOATING_CONTROL_GAP,
  POWER_FLOATING_CONTROL_RIGHT_CLEARANCE,
  POWER_FLOATING_CONTROL_SIZE,
} from '../shared/manage-message/floating-control-geometry';

export type DutyWorkspaceFabAvoidance = 'none' | 'above' | 'left';

export const DUTY_SCROLL_FAB_SIZE = POWER_FLOATING_CONTROL_SIZE;
export const DUTY_SCROLL_FAB_GAP = POWER_FLOATING_CONTROL_GAP;
export const DUTY_SCROLL_FAB_STACK_OFFSET = DUTY_SCROLL_FAB_SIZE + DUTY_SCROLL_FAB_GAP;

const DUTY_SAFE_BOTTOM = `max(${POWER_FLOATING_CONTROL_EDGE_INSET}px, env(safe-area-inset-bottom, 0px))`;
const DUTY_SAFE_RIGHT = `max(${POWER_FLOATING_CONTROL_EDGE_INSET}px, env(safe-area-inset-right, 0px))`;

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
    return {
      bottom: `${POWER_FLOATING_CONTROL_EDGE_INSET}px`,
      right: `${POWER_FLOATING_CONTROL_RIGHT_CLEARANCE}px`,
    };
  }

  return narrowScreen
    ? { bottom: DUTY_SAFE_BOTTOM, right: DUTY_SAFE_RIGHT }
    : {
        bottom: `${POWER_FLOATING_CONTROL_EDGE_INSET}px`,
        right: `${POWER_FLOATING_CONTROL_DESKTOP_RIGHT_INSET}px`,
      };
}
