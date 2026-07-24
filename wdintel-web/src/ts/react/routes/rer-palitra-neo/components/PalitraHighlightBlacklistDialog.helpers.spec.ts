import { describe, expect, it } from 'vitest';

import type { PalitraHighlightBlacklistEntry } from '../../../../../Bindings';
import { deriveHighlightBlacklistPoints } from './PalitraHighlightBlacklistDialog.helpers';
import { highlightBlacklistLabelKey } from '../../../services/api/palitra';

function entry(id: number, label: string): PalitraHighlightBlacklistEntry {
  return {
    id,
    palitraId: 42,
    label,
    createdByLoginId: 'login-id',
    createdByLogin: 'operator',
  };
}

describe('deriveHighlightBlacklistPoints', () => {
  it('trims, deduplicates case-insensitively, and sorts labels', () => {
    const result = deriveHighlightBlacklistPoints(
      {
        palitra: {} as never,
        geometries: [
          {
            id: 1,
            colorHex: '#fff',
            sourceFileName: null,
            lastUploadedAtTs: null,
            geometry: null,
            points: [
              { label: '  Яблуко ', coords: {} as never, color: null },
              { label: 'яблуко', coords: {} as never, color: null },
              { label: ' ', coords: {} as never, color: null },
              { label: 'Борщ', coords: {} as never, color: null },
            ],
          },
        ],
      },
      [entry(4, ' ЯБЛУКО ')],
    );

    expect(result.points.map((point) => point.label)).toEqual(['Борщ', 'Яблуко']);
    expect(result.missingEntries).toEqual([]);
  });

  it('keeps blacklist entries whose points are no longer present', () => {
    const result = deriveHighlightBlacklistPoints({ palitra: {} as never, geometries: [] }, [
      entry(7, 'Зникла точка'),
    ]);

    expect(result.missingEntries).toEqual([entry(7, 'Зникла точка')]);
  });

  it('matches backend trimmed lowercase identity for Unicode labels', () => {
    expect(highlightBlacklistLabelKey('  ЇЖАК ')).toBe(highlightBlacklistLabelKey('їжак'));
    expect(highlightBlacklistLabelKey('Єдність')).toBe('єдність');
    expect(highlightBlacklistLabelKey('  Ґрунт')).toBe('ґрунт');
  });
});
