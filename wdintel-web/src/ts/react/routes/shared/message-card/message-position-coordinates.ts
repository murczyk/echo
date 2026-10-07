import type { CnPosition, InboxMessage } from '../../../../../Bindings';
import { parseCoordinateInput } from '../../../../maps/coordinate-search';
import type { CoordinatePreviewPoint } from './message-coordinate-preview';

const KIND_LABELS: Record<string, string> = {
  position: 'Позиція',
  crew: 'Розрахунок',
  callsign: 'Позивний',
};

export function resolvePositionCoordinatePreviewPoints(
  position: CnPosition,
): CoordinatePreviewPoint[] {
  const coordinates =
    position.mgrs.length > 0 ? position.mgrs : position.knownMgrs ? [position.knownMgrs] : [];
  return coordinates.flatMap((coordinate) => {
    const point = parseCoordinateInput(coordinate);
    if (point == null) return [];
    const knownAt =
      position.knownAt == null
        ? ''
        : `, станом на ${new Date(position.knownAt).toLocaleDateString('uk-UA')}`;
    return [
      {
        source: 'position' as const,
        lat: point.lat,
        lng: point.lng,
        label: `${KIND_LABELS[position.kind] ?? 'Позиція'} «${position.text}»`,
        coordinateSources: (position.coordinateSources ?? []).filter(
          (source) => source.mgrs === coordinate,
        ),
        description:
          position.mgrs.length > 0
            ? coordinate
            : `Відомо з інших повідомлень: ${coordinate}${knownAt}${position.knownConflicting ? ' (є розбіжності)' : ''}`,
      },
    ];
  });
}

export function resolveMessagePositionCoordinatePreviewPoints(
  message: InboxMessage,
): CoordinatePreviewPoint[] {
  const bodyPositions = (message.textMarked ?? []).flatMap((node) =>
    typeof node !== 'string' && 'CNPositionC' in node ? [node.CNPositionC] : [],
  );
  return [
    ...bodyPositions,
    ...(message.media ?? []).flatMap((media) => media.positions ?? []),
  ].flatMap(resolvePositionCoordinatePreviewPoints);
}
