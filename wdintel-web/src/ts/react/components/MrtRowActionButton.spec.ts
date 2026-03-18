/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';

import { mrtRowActionsColumnSize } from './MrtRowActionButton';

describe('mrtRowActionsColumnSize', () => {
  it('uses compact fixed widths for grid and single-action layouts', () => {
    expect(mrtRowActionsColumnSize(1)).toBe(48);
    expect(mrtRowActionsColumnSize(5, 'grid')).toBe(84);
  });

  it('grows row layout width predictably with the number of actions', () => {
    expect(mrtRowActionsColumnSize(2)).toBe(78);
    expect(mrtRowActionsColumnSize(3)).toBe(108);
    expect(mrtRowActionsColumnSize(4)).toBe(138);
  });
});
