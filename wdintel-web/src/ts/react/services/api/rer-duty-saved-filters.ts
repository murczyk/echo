import type {
  RerDutyQueryState,
  RerDutyQueryStateWf as RerDutyFeedFilterState,
  RerDutyShortStateCreateRsp,
  RerDutyShortStateGetRsp,
  SavedFilterDuty,
  SavedFilterRenameReq,
  SavedFilterDutyUpsertReq,
} from '../../../../Bindings';
import { transformCamelToSnake, transformSnakeToCamel } from '../../../snake-to-camel';
import { normalizeRerDutyQueryStateWf } from '../../../rer-duty-filter-normalizer';
import { postJson, postVoid } from './client';
import { getCanonicalUnitIdValue } from '../../utils/unit-search';

function partitionUnitValues(
  values: string[] | null,
  storedUnitIds: number[] | null,
): { legacyValues: string[] | null; unitIds: number[] | null } {
  const legacyValues: string[] = [];
  const unitIds = new Set(storedUnitIds ?? []);
  for (const value of values ?? []) {
    const unitId = getCanonicalUnitIdValue(value);
    if (unitId === null) legacyValues.push(value);
    else unitIds.add(unitId);
  }
  return {
    legacyValues: legacyValues.length > 0 ? legacyValues : null,
    unitIds: unitIds.size > 0 ? [...unitIds] : null,
  };
}

function rerDutyQueryStateWfToSnake(
  w: RerDutyFeedFilterState,
): Record<string, string[] | number[] | number | boolean | null> {
  const selectedUnits = partitionUnitValues(w.unitsSelected, w.selectedUnitIds);
  const deniedUnits = partitionUnitValues(w.unitsDenied, w.deniedUnitIds);
  return {
    groups_selected: w.groupsSelected,
    groups_denied: w.groupsDenied,
    senders_selected: w.sendersSelected,
    denied_senders: w.deniedSenders,
    freqs_selected: w.freqsSelected,
    freqs_denied: w.freqsDenied,
    posts_selected: w.postsSelected,
    posts_denied: w.postsDenied,
    units_selected: selectedUnits.legacyValues,
    units_denied: deniedUnits.legacyValues,
    selected_unit_ids: selectedUnits.unitIds,
    denied_unit_ids: deniedUnits.unitIds,
    units_exact_match_only: w.unitsExactMatchOnly,
    last_viewed_message_id: w.lastViewedMessageId,
  };
}

export async function savedFiltersList(): Promise<SavedFilterDuty[]> {
  const raw = await postJson<Array<{ id: number; name: string; req: unknown }>>(
    '/api/rer/duty/saved-filters',
    {},
  );
  return (raw || []).map((r) => ({
    id: r.id,
    name: r.name,
    req: normalizeRerDutyQueryStateWf((r.req as Record<string, unknown>) ?? {}),
  }));
}

export async function savedFilterUpsert(req: SavedFilterDutyUpsertReq): Promise<SavedFilterDuty[]> {
  const body = {
    name: req.name,
    req: rerDutyQueryStateWfToSnake(req.req),
  };
  const raw = await postJson<Array<{ id: number; name: string; req: unknown }>>(
    '/api/rer/duty/saved-filter-upsert',
    body,
  );
  return (raw || []).map((r) => ({
    id: r.id,
    name: r.name,
    req: normalizeRerDutyQueryStateWf((r.req as Record<string, unknown>) ?? {}),
  }));
}

export async function savedFilterDelete(filterId: number): Promise<void> {
  await postVoid('/api/rer/duty/saved-filter-delete', filterId);
}

export async function savedFilterRename(req: SavedFilterRenameReq): Promise<void> {
  await postVoid('/api/rer/duty/saved-filter-rename', transformCamelToSnake(req));
}

export async function rerDutyShortStateCreate(
  state: RerDutyQueryState,
): Promise<RerDutyShortStateCreateRsp> {
  const body = { state: transformCamelToSnake(state) };
  return postJson<RerDutyShortStateCreateRsp>('/api/rer-duty/filters/create', body as any);
}

export async function rerDutyShortStateGet(id: string): Promise<RerDutyShortStateGetRsp> {
  const raw = await postJson<{ state?: unknown } | null>('/api/rer-duty/filters/get', { id });
  const state =
    (raw?.state ?? null) ? (transformSnakeToCamel(raw?.state ?? {}) as RerDutyQueryState) : null;
  return { state: state ?? { waterfalls: [] } };
}
