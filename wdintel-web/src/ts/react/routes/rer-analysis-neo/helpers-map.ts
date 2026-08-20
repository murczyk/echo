import type { InboxMessage, MapSettlement, PalitraReadV2, NetworkUnit } from '../../../../Bindings';
import { transformCamelToSnake } from '../../../snake-to-camel';
import { isNullOrUndefined } from '../../utils/misc';
import type { AnalysisPalitrasLoadState } from './types';

const CONTENT_NODE_VARIANT_KEY_MAP: Record<string, string> = {
  _c_n_text_c: 'CNTextC',
  _c_n_newline_c: 'CNNewlineC',
  _c_n_callsign_c: 'CNCallsignC',
  _c_n_highlight_c: 'CNHighlightC',
  _c_n_signal_c: 'CNSignalC',
  _c_n_point_c: 'CNPointC',
};

function fallbackGeometryScopedId(palitraId: number): number {
  return -palitraId;
}

function restoreContentNodeVariantKeys<T>(value: T): T {
  if (isNullOrUndefined(value)) return value;
  if (Array.isArray(value)) {
    return value.map((item) => restoreContentNodeVariantKeys(item)) as T;
  }
  if (typeof value !== 'object') return value;

  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    const restoredKey = CONTENT_NODE_VARIANT_KEY_MAP[key] ?? key;
    out[restoredKey] = restoreContentNodeVariantKeys(obj[key]);
  }
  return out as T;
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
          folder: palitraRead.palitra.folder,
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
  points: Array<{
    messageId: number;
    messageUid: string | null;
    id: number;
    lat: number;
    lng: number;
    mgrsCoords: string;
    sk42Coords: string;
    freq: string | null;
  }>;
  settlements: MapSettlement[];
  canShowSettlements: boolean;
  showSettlements: boolean;
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

  const snakeMessages = restoreContentNodeVariantKeys(transformCamelToSnake(params.messages));

  return {
    daterange: JSON.stringify(params.dateRange),
    daterangeLoading: JSON.stringify(params.isLoading),
    points: JSON.stringify(transformCamelToSnake(params.points)),
    settlements: JSON.stringify(transformCamelToSnake(params.settlements)),
    canShowSettlements: String(params.canShowSettlements),
    showSettlements: String(params.showSettlements),
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
