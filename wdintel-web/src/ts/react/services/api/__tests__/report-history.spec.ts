import { describe, expect, it } from 'vitest';

import { isCancelledReportHistory, isCancelledReportHistoryError } from '../report-history';

describe('isCancelledReportHistory', () => {
  it('accepts exact and prefixed cancel errors', () => {
    expect(
      isCancelledReportHistory({
        status: 'failed',
        lastError: 'Скасовано користувачем',
        isCancelled: false,
      }),
    ).toBe(true);

    expect(
      isCancelledReportHistory({
        status: 'failed',
        lastError: 'Скасовано користувачем: worker cleanup already ran',
        isCancelled: false,
      }),
    ).toBe(true);

    expect(
      isCancelledReportHistory({
        status: 'failed',
        lastError: 'BL { msg: "Скасовано користувачем" }',
        isCancelled: false,
      }),
    ).toBe(true);
  });

  it('prefers the backend marker when present', () => {
    expect(
      isCancelledReportHistory({
        status: 'failed',
        lastError: null,
        isCancelled: true,
      }),
    ).toBe(true);
  });

  it('does not mark unrelated failures as cancelled', () => {
    expect(
      isCancelledReportHistory({
        status: 'failed',
        lastError: 'Some other failure',
        isCancelled: false,
      }),
    ).toBe(false);
  });
});

describe('isCancelledReportHistoryError', () => {
  it('matches debug-formatted cancellation errors', () => {
    expect(isCancelledReportHistoryError('BL { msg: "Скасовано користувачем" }')).toBe(true);
    expect(isCancelledReportHistoryError('Some other failure')).toBe(false);
    expect(isCancelledReportHistoryError(null)).toBe(false);
  });
});
