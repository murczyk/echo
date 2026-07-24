import type { PalitraHighlightBlacklistEntry, PalitraReadV2 } from '../../../../../Bindings';
import { highlightBlacklistLabelKey } from '../../../services/api/palitra';

export type HighlightBlacklistPoint = {
  label: string;
  normalizedLabel: string;
};

export function deriveHighlightBlacklistPoints(
  palitra: PalitraReadV2,
  entries: PalitraHighlightBlacklistEntry[],
): {
  points: HighlightBlacklistPoint[];
  missingEntries: PalitraHighlightBlacklistEntry[];
} {
  const pointsByLabel = new Map<string, HighlightBlacklistPoint>();
  for (const point of palitra.geometries.flatMap((geometry) => geometry.points)) {
    const label = point.label?.trim() ?? '';
    const normalizedLabel = highlightBlacklistLabelKey(label);
    if (normalizedLabel !== '' && !pointsByLabel.has(normalizedLabel)) {
      pointsByLabel.set(normalizedLabel, { label, normalizedLabel });
    }
  }

  const points = [...pointsByLabel.values()].sort((left, right) =>
    left.label.localeCompare(right.label, 'uk-UA'),
  );
  const missingEntries = entries.filter(
    (entry) => !pointsByLabel.has(highlightBlacklistLabelKey(entry.label)),
  );

  return { points, missingEntries };
}
