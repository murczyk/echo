/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import './logo-coin';

describe('logo coin lifecycle', () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does not scan unrelated DOM additions for logo coins', async () => {
    const querySelectorAll = vi.spyOn(Element.prototype, 'querySelectorAll');

    document.body.append(document.createElement('div'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      querySelectorAll.mock.calls.filter(([selector]) => selector === '.logo-coin'),
    ).toHaveLength(0);
  });

  it('owns the automatic flip timer for its mounted lifetime', () => {
    vi.useFakeTimers();
    const coin = document.createElement('echo-logo-coin');
    coin.className = 'logo-coin logo-coin--auto';
    coin.innerHTML = '<div class="logo-coin__disc"></div>';

    document.body.append(coin);

    expect(coin.dataset.logoCoinSide).toBe('front');
    expect(vi.getTimerCount()).toBe(1);

    coin.remove();

    expect(vi.getTimerCount()).toBe(0);
  });
});
