import type { InboxMessage, PalitraReadV2, NetworkUnit } from '../../../../Bindings';
import { transformCamelToSnake } from '../../../snake-to-camel';
import type { AnalysisPalitrasLoadState } from './types';

function fallbackGeometryScopedId(palitraId: number): number {
  return -palitraId;
}

function toMapPalitras(palitras: PalitraReadV2[]): unknown[] {
  return palitras.flatMap((palitraRead) => {
    if (palitraRead.geometries.length === 0) {
      return [
        transformCamelToSnake({
          palitra: {
            ...palitraRead.palitra,
            id: fallbackGeometryScopedId(palitraRead.palitra.id),
            apiPalitraId: palitraRead.palitra.id,
          },
          points: [],
        }),
      ];
    }

    return palitraRead.geometries.map((geometry) =>
      transformCamelToSnake({
        palitra: {
          id: geometry.id,
          apiPalitraId: palitraRead.palitra.id,
          name: palitraRead.palitra.name,
          colorHex: geometry.colorHex,
          author: palitraRead.palitra.author,
          sourceFileName: geometry.sourceFileName,
          lastUploadedAtTs: geometry.lastUploadedAtTs,
          geometry: geometry.geometry,
          accessAorId: palitraRead.palitra.accessAorId,
          accessOrganismIds: palitraRead.palitra.accessOrganismIds,
          accessLogins: palitraRead.palitra.accessLogins,
        },
        points: [],
      }),
    );
  });
}

export function buildMapAttrs(params: {
  dateRange: { startDate: number; endDate: number };
  isLoading: boolean;
  points: Array<{ messageId: number; messageUid: string | null; id: number; lat: number; lng: number; mgrsCoords: string; sk42Coords: string; freq: string | null }>;
  messages: Array<[number, InboxMessage]>;
  networkUnits: NetworkUnit[];
  selectedUnits: string[];
  palitras: PalitraReadV2[];
  palitrasLoaded: boolean;
  palitrasLoadState: AnalysisPalitrasLoadState;
}) {
  const allFreqs = params.messages
    .map(([, message]) => message.freq)
    .filter((freq): freq is string => typeof freq === 'string' && freq.length > 0);

  const filteredNetworkUnits = params.networkUnits.filter((unit) =>
    unit.frequencies.some((freq) => allFreqs.includes(freq)),
  );

  const snakeMessages = params.messages.map(([id, message]) => [id, transformCamelToSnake(message)]);

  return {
    daterange: JSON.stringify(params.dateRange),
    daterangeLoading: JSON.stringify(params.isLoading),
    points: JSON.stringify(params.points),
    messages: JSON.stringify({
      networkUnits: filteredNetworkUnits,
      messages: snakeMessages,
    }),
    selectedUnits: JSON.stringify(params.selectedUnits),
    palitras: JSON.stringify(toMapPalitras(params.palitras)),
    palitrasLoaded: JSON.stringify(params.palitrasLoaded),
    palitrasLoadState: params.palitrasLoadState,
  };
}
