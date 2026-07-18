import { describe, expect, it } from 'vitest';

import { resolveDutyScrollFabPosition } from './duty-scroll-fab-position';

describe('resolveDutyScrollFabPosition', () => {
  it.each([
    [
      { narrowScreen: false, workspaceFabAvoidance: 'none' },
      { bottom: '12px', right: '20px' },
    ],
    [
      { narrowScreen: false, workspaceFabAvoidance: 'left' },
      { bottom: '12px', right: '59px' },
    ],
    [
      { narrowScreen: true, workspaceFabAvoidance: 'above' },
      {
        bottom: 'calc(max(12px, env(safe-area-inset-bottom, 0px)) + 47px)',
        right: 'max(12px, env(safe-area-inset-right, 0px))',
      },
    ],
    [
      { narrowScreen: true, workspaceFabAvoidance: 'none' },
      {
        bottom: 'max(12px, env(safe-area-inset-bottom, 0px))',
        right: 'max(12px, env(safe-area-inset-right, 0px))',
      },
    ],
  ] as const)('resolves %j', (input, expected) => {
    expect(resolveDutyScrollFabPosition(input)).toEqual(expected);
  });
});
