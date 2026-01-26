import {
  AorCoordinates,
  AreaOfResponsibility,
  AreaOfResponsibilityInsert,
  DeleteAreaOfResponsibilityReq,
  ListAreasOfResponsibilityReq,
  UpdateAreaOfResponsibilityReq,
} from '../../../../Bindings';

import { postJson, postVoid } from './client';

type ListAreasOfResponsibilityReqBody = {
  sort_by: ListAreasOfResponsibilityReq['sortBy'];
};

function toListAreasOfResponsibilityReqBody(req: ListAreasOfResponsibilityReq): ListAreasOfResponsibilityReqBody {
  return { sort_by: req.sortBy };
}

type AorCoordinatesBody = {
  latitude: number;
  longitude: number;
  settlement: string | null;
};

type AorCoordinatesLike = {
  latitude?: number | string | null;
  longitude?: number | string | null;
  settlement?: string | null;
};

type AreaOfResponsibilityLike = {
  id?: number;
  name?: string;
  description?: string | null;
  isTopLevel?: boolean;
  is_top_level?: boolean;
  leftBound?: number | string | null;
  left_bound?: number | string | null;
  rightBound?: number | string | null;
  right_bound?: number | string | null;
  leftCoordinates?: AorCoordinatesLike | null;
  left_coordinates?: AorCoordinatesLike | null;
  rightCoordinates?: AorCoordinatesLike | null;
  right_coordinates?: AorCoordinatesLike | null;
  createdAt?: number;
  created_at?: number;
};

type AreaOfResponsibilityInsertBody = {
  name: string;
  description: string | null;
  is_top_level: boolean;
  left_bound: number;
  right_bound: number;
  left_coordinates: AorCoordinatesBody | null;
  right_coordinates: AorCoordinatesBody | null;
};

type UpdateAreaOfResponsibilityReqBody = {
  id: number;
  insert: AreaOfResponsibilityInsertBody;
};

type DeleteAreaOfResponsibilityReqBody = {
  id: number;
};

function normalizeNumber(value: number | string | null | undefined): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return 0;
}

function normalizeCoordinates(coords: AorCoordinatesLike | null | undefined): AorCoordinates | null {
  if (!coords) return null;

  return {
    latitude: normalizeNumber(coords.latitude),
    longitude: normalizeNumber(coords.longitude),
    settlement: coords.settlement ?? null,
  };
}

function normalizeAor(raw: AreaOfResponsibilityLike): AreaOfResponsibility {
  return {
    id: raw.id ?? 0,
    name: raw.name ?? '',
    description: raw.description ?? null,
    isTopLevel: raw.isTopLevel ?? raw.is_top_level ?? false,
    leftBound: normalizeNumber(raw.leftBound ?? raw.left_bound),
    rightBound: normalizeNumber(raw.rightBound ?? raw.right_bound),
    leftCoordinates: normalizeCoordinates(raw.leftCoordinates ?? raw.left_coordinates),
    rightCoordinates: normalizeCoordinates(raw.rightCoordinates ?? raw.right_coordinates),
    createdAt: raw.createdAt ?? raw.created_at ?? 0,
  };
}

function toAorCoordinatesBody(coords: AorCoordinates | null): AorCoordinatesBody | null {
  if (!coords) return null;

  return {
    latitude: coords.latitude,
    longitude: coords.longitude,
    settlement: coords.settlement,
  };
}

function toAreaOfResponsibilityInsertBody(req: AreaOfResponsibilityInsert): AreaOfResponsibilityInsertBody {
  return {
    name: req.name,
    description: req.description,
    is_top_level: req.isTopLevel,
    left_bound: req.leftBound,
    right_bound: req.rightBound,
    left_coordinates: toAorCoordinatesBody(req.leftCoordinates),
    right_coordinates: toAorCoordinatesBody(req.rightCoordinates),
  };
}

function toUpdateAreaOfResponsibilityReqBody(req: UpdateAreaOfResponsibilityReq): UpdateAreaOfResponsibilityReqBody {
  return {
    id: req.id,
    insert: toAreaOfResponsibilityInsertBody(req.insert),
  };
}

function toDeleteAreaOfResponsibilityReqBody(req: DeleteAreaOfResponsibilityReq): DeleteAreaOfResponsibilityReqBody {
  return { id: req.id };
}

export async function listAors(req: ListAreasOfResponsibilityReq): Promise<AreaOfResponsibility[]> {
  const data = await postJson<AreaOfResponsibilityLike[]>('/api/sigint/aor', toListAreasOfResponsibilityReqBody(req));
  return (data || []).map(normalizeAor);
}

export async function createAor(req: AreaOfResponsibilityInsert): Promise<AreaOfResponsibility> {
  const data = await postJson<AreaOfResponsibilityLike>('/api/sigint/aor/create', toAreaOfResponsibilityInsertBody(req));
  return normalizeAor(data);
}

export async function updateAor(req: UpdateAreaOfResponsibilityReq): Promise<AreaOfResponsibility> {
  const data = await postJson<AreaOfResponsibilityLike>('/api/sigint/aor/update', toUpdateAreaOfResponsibilityReqBody(req));
  return normalizeAor(data);
}

export async function deleteAor(req: DeleteAreaOfResponsibilityReq): Promise<void> {
  await postVoid('/api/sigint/aor/delete', toDeleteAreaOfResponsibilityReqBody(req));
}
