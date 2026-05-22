import type {
  OrganismKeywordSetDto,
  OrganismKeywordSetInflectReq,
  OrganismKeywordSetInflectRsp,
  OrganismKeywordSetUpsertReq,
} from '../../../../Bindings';

import { transformCamelToSnake, transformSnakeToCamel } from '../../../snake-to-camel';

import { deleteVoid, getJson, postJson, putJson } from './client';

export const ORGANISM_KEYWORD_SET_DEFAULT_DISPLAY_NAME = 'Стандартний';
export const ORGANISM_KEYWORD_SET_NEW_NAME_PREFIX = 'Новий набір';

export function suggestNewKeywordSetName(sets: readonly OrganismKeywordSetDto[]): string {
  const taken = new Set(sets.map((s) => s.name.trim()));
  let n = 1;
  while (true) {
    const candidate =
      n === 1 ? ORGANISM_KEYWORD_SET_NEW_NAME_PREFIX : `${ORGANISM_KEYWORD_SET_NEW_NAME_PREFIX} ${n}`;
    if (!taken.has(candidate)) return candidate;
    n += 1;
  }
}

export function keywordSetDisplayName(set: OrganismKeywordSetDto): string {
  return set.isSystemDefault ? ORGANISM_KEYWORD_SET_DEFAULT_DISPLAY_NAME : set.name;
}

export async function fetchOrganismKeywordSets(): Promise<OrganismKeywordSetDto[]> {
  const raw = await getJson<unknown>('/api/organism/keyword-sets');
  return transformSnakeToCamel<OrganismKeywordSetDto[]>(raw);
}

export async function upsertOrganismKeywordSet(
  req: OrganismKeywordSetUpsertReq,
): Promise<OrganismKeywordSetDto> {
  const raw = await putJson<unknown>('/api/organism/keyword-sets', transformCamelToSnake(req));
  return transformSnakeToCamel<OrganismKeywordSetDto>(raw);
}

export async function deleteOrganismKeywordSet(id: number): Promise<void> {
  return deleteVoid(`/api/organism/keyword-sets/${id}`);
}

export async function inflectOrganismKeywordForms(
  req: OrganismKeywordSetInflectReq,
): Promise<OrganismKeywordSetInflectRsp> {
  const raw = await postJson<unknown>('/api/organism/keyword-sets/inflect', transformCamelToSnake(req));
  return transformSnakeToCamel<OrganismKeywordSetInflectRsp>(raw);
}

export function defaultKeywordSetId(sets: OrganismKeywordSetDto[]): number | null {
  const d = sets.find((s) => s.isSystemDefault);
  return d?.id ?? null;
}

export function resolveKeywordSetId(
  sets: OrganismKeywordSetDto[],
  setId: number | null | undefined,
): number | null {
  const defaultId = defaultKeywordSetId(sets);
  if (setId == null) return defaultId;
  if (sets.some((s) => s.id === setId)) return setId;
  return defaultId;
}
