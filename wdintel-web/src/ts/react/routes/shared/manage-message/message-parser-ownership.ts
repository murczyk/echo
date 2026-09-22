import dayjs from 'dayjs';

import { getCoordinateMgrsText, getCoordinateText } from '../../../../maps/coordinate-format';
import { parseCoordinateBlock, type ParsedCoordinate } from '../../../../maps/coordinate-parser';
import type { DirectSubmitParseResponse } from '../../../services/api/direct-submit';
import {
  normalizeCallsign,
  normalizeMultiValue,
  type MessageFormData,
} from './manage-message-drawer.schema';

export const PARSER_SCALAR_FIELDS = [
  'text',
  'freq',
  'comment',
  'post',
  'unit',
  'network_name',
  'date',
  'time',
] as const;

export const PARSER_LIST_FIELDS = ['coords', 'callsigns', 'locations'] as const;

export type ParserScalarFieldName = (typeof PARSER_SCALAR_FIELDS)[number];
export type ParserListFieldName = (typeof PARSER_LIST_FIELDS)[number];
export type ParserFieldName = ParserScalarFieldName | ParserListFieldName;
export type ParserListItem = { key: string; value: string };

export type ParserSnapshot = {
  scalars: Partial<Record<ParserScalarFieldName, unknown>>;
  lists: Record<ParserListFieldName, ParserListItem[]>;
};

type ParserListOwnership = {
  parsed: ParserListItem[];
  manual: ParserListItem[];
  suppressedKeys: string[];
};

export type ParserOwnershipState = {
  scalarOrigins: Partial<Record<ParserScalarFieldName, 'parsed' | 'manual'>>;
  parsedScalars: Partial<Record<ParserScalarFieldName, unknown>>;
  lists: Record<ParserListFieldName, ParserListOwnership>;
};

export type ParserFeedback = {
  sequence: number;
  changedFields: ParserFieldName[];
  conflictFields: ParserFieldName[];
  emptyCandidateFields?: ParserFieldName[];
};

export type ParserReconcileResult = {
  state: ParserOwnershipState;
  patch: Partial<MessageFormData>;
  changedFields: ParserFieldName[];
  conflictFields: ParserFieldName[];
  emptyCandidateFields: ParserFieldName[];
};

type ParserListAdapter = {
  read: (value: unknown) => ParserListItem[];
  write: (items: ParserListItem[]) => MessageFormData[ParserListFieldName];
};

const STRING_SCALAR_FIELDS = new Set<ParserScalarFieldName>([
  'text',
  'freq',
  'comment',
  'post',
  'unit',
  'network_name',
]);

function deduplicateItems(items: ParserListItem[]): ParserListItem[] {
  const keys = new Set<string>();
  return items.filter(({ key }) => {
    if (keys.has(key)) return false;
    keys.add(key);
    return true;
  });
}

function toCoordinateItem(point: ParsedCoordinate): ParserListItem {
  const value = getCoordinateText('wgs', point);
  const serializedPoint = parseCoordinateBlock(value)[0] ?? point;
  return {
    key: getCoordinateMgrsText(serializedPoint) ?? value,
    value,
  };
}

function toTextItem(value: string): ParserListItem {
  return { key: value, value };
}

const listAdapters: Record<ParserListFieldName, ParserListAdapter> = {
  coords: {
    read: (value) =>
      deduplicateItems(parseCoordinateBlock(String(value ?? '')).map(toCoordinateItem)),
    write: (items) => items.map(({ value }) => value).join('\n'),
  },
  callsigns: {
    read: (value) =>
      deduplicateItems(
        normalizeMultiValue((value as string[] | undefined) ?? [])
          .map(normalizeCallsign)
          .map(toTextItem),
      ),
    write: (items) => items.map(({ value }) => value),
  },
  locations: {
    read: (value) =>
      deduplicateItems(normalizeMultiValue((value as string[] | undefined) ?? []).map(toTextItem)),
    write: (items) => items.map(({ value }) => value),
  },
};

function cloneState(state: ParserOwnershipState): ParserOwnershipState {
  return {
    scalarOrigins: { ...state.scalarOrigins },
    parsedScalars: { ...state.parsedScalars },
    lists: {
      coords: cloneListState(state.lists.coords),
      callsigns: cloneListState(state.lists.callsigns),
      locations: cloneListState(state.lists.locations),
    },
  };
}

function cloneListState(state: ParserListOwnership): ParserListOwnership {
  return {
    parsed: [...state.parsed],
    manual: [...state.manual],
    suppressedKeys: [...state.suppressedKeys],
  };
}

function emptyListState(): ParserListOwnership {
  return { parsed: [], manual: [], suppressedKeys: [] };
}

export function createParserOwnershipState(): ParserOwnershipState {
  return {
    scalarOrigins: {},
    parsedScalars: {},
    lists: {
      coords: emptyListState(),
      callsigns: emptyListState(),
      locations: emptyListState(),
    },
  };
}

export function toParserSnapshot(response: DirectSubmitParseResponse): ParserSnapshot {
  const timestamp = response.timestamp ? dayjs(response.timestamp) : null;
  const coordinateItems = (response.coords ?? []).map(({ lat, lon }) =>
    toCoordinateItem({ lat, lng: lon, format: 'wgs84', source: `${lat}, ${lon}` }),
  );

  return {
    scalars: {
      text: response.text || undefined,
      freq: response.freq || undefined,
      comment: response.comment || undefined,
      post: response.post || undefined,
      network_name: response.unit || undefined,
      unit: response.unit_v2 || undefined,
      date: timestamp?.isValid() ? timestamp : undefined,
      time: timestamp?.isValid() ? (response.is_time_null === true ? null : timestamp) : undefined,
    },
    lists: {
      coords: deduplicateItems(coordinateItems),
      callsigns: listAdapters.callsigns.read(response.to ?? []),
      locations: listAdapters.locations.read(response.locations ?? []),
    },
  };
}

function isListField(field: ParserFieldName): field is ParserListFieldName {
  return (PARSER_LIST_FIELDS as readonly string[]).includes(field);
}

function scalarEmptyValue(field: ParserScalarFieldName): unknown {
  return STRING_SCALAR_FIELDS.has(field) ? '' : null;
}

function scalarValuesEqual(left: unknown, right: unknown): boolean {
  if (dayjs.isDayjs(left) && dayjs.isDayjs(right)) {
    return left.valueOf() === right.valueOf();
  }
  return left === right;
}

function listValuesEqual(left: ParserListItem[], right: ParserListItem[]): boolean {
  return (
    left.length === right.length && left.every((item, index) => item.key === right[index]?.key)
  );
}

function materializeList(state: ParserListOwnership): ParserListItem[] {
  const suppressedKeys = new Set(state.suppressedKeys);
  return deduplicateItems([
    ...state.manual,
    ...state.parsed.filter(({ key }) => !suppressedKeys.has(key)),
  ]);
}

export function recordManualChange(
  state: ParserOwnershipState,
  field: ParserFieldName,
  value: unknown,
  previousForm: MessageFormData,
): ParserOwnershipState {
  const next = cloneState(state);
  if (!isListField(field)) {
    next.scalarOrigins[field] = 'manual';
    return next;
  }

  const adapter = listAdapters[field];
  const previousItems = adapter.read(previousForm[field]);
  const nextItems = adapter.read(value);
  const nextKeys = new Set(nextItems.map(({ key }) => key));
  const parsedKeys = new Set(next.lists[field].parsed.map(({ key }) => key));
  const existingManualKeys = new Set(next.lists[field].manual.map(({ key }) => key));
  const suppressedKeys = new Set(next.lists[field].suppressedKeys);

  previousItems.forEach(({ key }) => {
    if (!nextKeys.has(key) && parsedKeys.has(key)) suppressedKeys.add(key);
  });

  next.lists[field].manual = nextItems.filter(
    ({ key }) => !parsedKeys.has(key) || existingManualKeys.has(key),
  );
  next.lists[field].suppressedKeys = [...suppressedKeys];
  return next;
}

export function reconcileParserSnapshot(
  state: ParserOwnershipState,
  currentForm: MessageFormData,
  snapshot: ParserSnapshot,
): ParserReconcileResult {
  const next = cloneState(state);
  const patch: Partial<MessageFormData> = {};
  const changedFields: ParserFieldName[] = [];
  const conflictFields: ParserFieldName[] = [];
  const emptyCandidateFields: ParserFieldName[] = [];

  PARSER_SCALAR_FIELDS.forEach((field) => {
    const candidate = snapshot.scalars[field];
    const candidatePresent = candidate !== undefined;
    const desired = candidatePresent ? candidate : scalarEmptyValue(field);
    next.parsedScalars[field] = candidate;

    if (next.scalarOrigins[field] === 'manual') {
      if (!scalarValuesEqual(currentForm[field], desired)) {
        conflictFields.push(field);
        if (!candidatePresent) emptyCandidateFields.push(field);
      }
      return;
    }

    if (next.scalarOrigins[field] !== 'parsed' && !candidatePresent) return;

    next.scalarOrigins[field] = 'parsed';
    if (!scalarValuesEqual(currentForm[field], desired)) {
      Object.assign(patch, { [field]: desired });
      changedFields.push(field);
    }
  });

  PARSER_LIST_FIELDS.forEach((field) => {
    const adapter = listAdapters[field];
    const currentState = next.lists[field];
    const previousParsed = currentState.parsed;
    const incoming = deduplicateItems(snapshot.lists[field]);
    const wasParserOwned = previousParsed.length > 0 || currentState.suppressedKeys.length > 0;
    currentState.parsed = incoming;

    const suppressedKeys = new Set(currentState.suppressedKeys);
    if (incoming.some(({ key }) => suppressedKeys.has(key))) conflictFields.push(field);

    if (incoming.length === 0 && !wasParserOwned && currentState.manual.length === 0) return;

    const currentItems = adapter.read(currentForm[field]);
    const desiredItems = materializeList(currentState);
    if (!listValuesEqual(currentItems, desiredItems)) {
      Object.assign(patch, { [field]: adapter.write(desiredItems) });
      changedFields.push(field);
    }
  });

  return { state: next, patch, changedFields, conflictFields, emptyCandidateFields };
}

export function clearParserOwnedValues(
  state: ParserOwnershipState,
  currentForm: MessageFormData,
): ParserReconcileResult {
  const next = cloneState(state);
  const patch: Partial<MessageFormData> = {};
  const changedFields: ParserFieldName[] = [];

  PARSER_SCALAR_FIELDS.forEach((field) => {
    next.parsedScalars[field] = undefined;
    if (next.scalarOrigins[field] !== 'parsed') return;
    const desired = scalarEmptyValue(field);
    if (!scalarValuesEqual(currentForm[field], desired)) {
      Object.assign(patch, { [field]: desired });
      changedFields.push(field);
    }
  });

  PARSER_LIST_FIELDS.forEach((field) => {
    const adapter = listAdapters[field];
    const listState = next.lists[field];
    if (listState.parsed.length === 0) return;
    listState.parsed = [];
    const desiredItems = materializeList(listState);
    if (!listValuesEqual(adapter.read(currentForm[field]), desiredItems)) {
      Object.assign(patch, { [field]: adapter.write(desiredItems) });
      changedFields.push(field);
    }
  });

  return { state: next, patch, changedFields, conflictFields: [], emptyCandidateFields: [] };
}

export function acceptParsedCandidate(
  state: ParserOwnershipState,
  currentForm: MessageFormData,
  field: ParserFieldName,
): ParserReconcileResult {
  const next = cloneState(state);
  const patch: Partial<MessageFormData> = {};
  const changedFields: ParserFieldName[] = [];

  if (!isListField(field)) {
    const candidate = next.parsedScalars[field];
    const desired = candidate === undefined ? scalarEmptyValue(field) : candidate;
    next.scalarOrigins[field] = 'parsed';
    if (!scalarValuesEqual(currentForm[field], desired)) {
      Object.assign(patch, { [field]: desired });
      changedFields.push(field);
    }
    return { state: next, patch, changedFields, conflictFields: [], emptyCandidateFields: [] };
  }

  const listState = next.lists[field];
  const parsedKeys = new Set(listState.parsed.map(({ key }) => key));
  listState.suppressedKeys = listState.suppressedKeys.filter((key) => !parsedKeys.has(key));
  const adapter = listAdapters[field];
  const desiredItems = materializeList(listState);
  if (!listValuesEqual(adapter.read(currentForm[field]), desiredItems)) {
    Object.assign(patch, { [field]: adapter.write(desiredItems) });
    changedFields.push(field);
  }
  return { state: next, patch, changedFields, conflictFields: [], emptyCandidateFields: [] };
}
