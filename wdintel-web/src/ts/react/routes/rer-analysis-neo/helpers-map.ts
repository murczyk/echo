import type { InboxMessage, NetworkUnit } from '../../../../Bindings';
import { transformCamelToSnake } from '../../../snake-to-camel';

export function buildMapAttrs(params: {
  dateRange: { startDate: number; endDate: number };
  isLoading: boolean;
  points: Array<{ messageId: number; messageUid: string | null; id: number; lat: number; lng: number; mgrsCoords: string; sk42Coords: string; freq: string | null }>;
  messages: Array<[number, InboxMessage]>;
  networkUnits: NetworkUnit[];
  selectedUnits: string[];
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
    palitras: JSON.stringify([]),
  };
}
