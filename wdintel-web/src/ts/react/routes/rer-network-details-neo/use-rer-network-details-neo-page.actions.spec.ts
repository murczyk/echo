/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';

import { buildMainInfoCopyText } from './use-rer-network-details-neo-page.actions';

describe('buildMainInfoCopyText', () => {
  it('skips empty values and keeps the visible ones', () => {
    const text = buildMainInfoCopyText({
      unitNames: ['  ', 'Підрозділ 7'],
      location: '  ',
      aorLabels: [],
      aorCollapsedCount: 0,
      callsignCount: null,
      activityLabel: 'Неактивна',
    });

    expect(text).toBe(['Підрозділ: Підрозділ 7', 'Активність: Неактивна'].join('\n'));
  });

  it('includes the active window when present', () => {
    const text = buildMainInfoCopyText({
      unitNames: ['Підрозділ 1'],
      location: 'ЯКЕСЬ МІСТО',
      aorLabels: ['АОР 1', 'АОР 2'],
      aorCollapsedCount: 3,
      callsignCount: 100500,
      activityLabel: '24.02.22 — досі',
    });

    expect(text).toContain('Підрозділ: Підрозділ 1');
    expect(text).toContain('Район функціонування: ЯКЕСЬ МІСТО');
    expect(text).toContain('Смуги: АОР 1, АОР 2 (+3)');
    expect(text).toContain('Склад кореспондентів: 100500');
    expect(text).toContain('Активність: 24.02.22 — досі');
  });
});
