/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';

import { syncTableWatermarks } from './table-watermark';

describe('syncTableWatermarks', () => {
  it('uses the nearest app shell watermark for each paper', () => {
    document.body.innerHTML = `
      <div class="app-shell" data-auth-user-name="anonymous">
        <div data-table-watermark=""></div>
      </div>
      <div class="app-shell" data-auth-user-name="First User">
        <div data-table-watermark=""></div>
      </div>
      <div class="app-shell" data-auth-user-name="">
        <div class="app-shell" data-auth-user-name="Second User">
          <div data-table-watermark=""></div>
        </div>
      </div>
    `;

    syncTableWatermarks();

    const watermarks = Array.from(document.querySelectorAll<HTMLElement>('[data-table-watermark]')).map((element) =>
      element.getAttribute('data-table-watermark'),
    );

    expect(watermarks).toEqual(['', 'First User', 'Second User']);
  });
});
