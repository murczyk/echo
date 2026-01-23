import { ListLoginsReq, ListLoginsRsp } from '../../../../Bindings';

import { postJson } from './client';

type ListLoginsReqBody = {
  sort_by: ListLoginsReq['sortBy'];
  filter_by_roles: ListLoginsReq['filterByRoles'];
};

function toListLoginsReqBody(req: ListLoginsReq): ListLoginsReqBody {
  return { sort_by: req.sortBy, filter_by_roles: req.filterByRoles };
}

export async function listLogins(req: ListLoginsReq): Promise<ListLoginsRsp> {
  return postJson<ListLoginsRsp>('/api/logins', toListLoginsReqBody(req));
}
