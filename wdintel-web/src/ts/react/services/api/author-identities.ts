import type {
  AuthorIdentitiesReq,
  AuthorIdentitiesRsp,
  AuthorIdentity,
  DisplayNameSaveReq,
} from '../../../../Bindings';
import { postJson, putJson } from './client';

type AuthorIdentityWire = {
  id: string;
  login: string;
  display_name: string | null;
  delta_login: string | null;
};

function normalizeAuthor(author: AuthorIdentityWire): AuthorIdentity {
  return {
    id: author.id,
    login: author.login,
    displayName: author.display_name,
    deltaLogin: author.delta_login,
  };
}

export async function fetchAuthorIdentities(
  req: AuthorIdentitiesReq,
): Promise<AuthorIdentitiesRsp> {
  const rsp = await postJson<{ authors: AuthorIdentityWire[] }>('/api/user/author-identities', {
    logins: req.logins,
    ids: req.ids,
  });
  return { authors: rsp.authors.map(normalizeAuthor) };
}

export async function saveDisplayName(req: DisplayNameSaveReq): Promise<AuthorIdentity> {
  return normalizeAuthor(
    await putJson<AuthorIdentityWire>('/api/user/display-name', {
      display_name: req.displayName,
    }),
  );
}
