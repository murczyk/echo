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
import { postJson, postVoid } from './client';

function rerDutyQueryStateWfToSnake(
  w: RerDutyFeedFilterState,
): Record<string, string[] | number | boolean | null> {
  return {
    groups_selected: w.groupsSelected,
    groups_denied: w.groupsDenied,
    senders_selected: w.sendersSelected,
    denied_senders: w.deniedSenders,
    freqs_selected: w.freqsSelected,
    freqs_denied: w.freqsDenied,
    posts_selected: w.postsSelected,
    posts_denied: w.postsDenied,
    units_selected: w.unitsSelected,
    units_denied: w.unitsDenied,
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
    req: r.req as RerDutyFeedFilterState,
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
    req: r.req as RerDutyFeedFilterState,
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
