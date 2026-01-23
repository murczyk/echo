import { AreaOfResponsibility, ListAreasOfResponsibilityReq } from '../../../../Bindings';

import { postJson } from './client';

type ListAreasOfResponsibilityReqBody = {
  sort_by: ListAreasOfResponsibilityReq['sortBy'];
};

function toListAreasOfResponsibilityReqBody(req: ListAreasOfResponsibilityReq): ListAreasOfResponsibilityReqBody {
  return { sort_by: req.sortBy };
}

export async function listAors(req: ListAreasOfResponsibilityReq): Promise<AreaOfResponsibility[]> {
  return postJson<AreaOfResponsibility[]>('/api/sigint/aor', toListAreasOfResponsibilityReqBody(req));
}
