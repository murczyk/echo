import { afterEach, describe, expect, it } from 'vitest';
import {
  isDutyScrollDebugEnabled,
  registerDutyScrollDebugBellPress,
  setDutyScrollDebugEnabled,
} from './duty-scroll-debug';

describe('duty scroll debug activation', () => {
  afterEach(() => setDutyScrollDebugEnabled(false));

  it('enables after eight presses within four seconds', () => {
    for (let press = 0; press < 8; press += 1) {
      registerDutyScrollDebugBellPress(1000 + press * 400);
    }

    expect(isDutyScrollDebugEnabled()).toBe(true);
  });

  it('does not enable when the eight presses span more than four seconds', () => {
    for (let press = 0; press < 8; press += 1) {
      registerDutyScrollDebugBellPress(1000 + press * 600);
    }

    expect(isDutyScrollDebugEnabled()).toBe(false);
  });
});
