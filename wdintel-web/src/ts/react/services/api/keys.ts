import { postJson, postVoid } from './client';

type SigintKeySharePolicyLike = {
  id?: number;
  grantFrom?: number;
  grant_from?: number;
  grantTo?: number;
  grant_to?: number;
  author?: string;
  createdAt?: number;
  created_at?: number;
};

export type SigintKeySharePolicy = {
  id: number;
  grantFrom: number;
  grantTo: number;
  author: string;
  createdAt: number;
};

export type CreateSigintKeySharePolicyReq = {
  grantFrom: number;
  grantTo: number;
};

type CreateSigintKeySharePolicyReqBody = {
  grant_from: number;
  grant_to: number;
};

export type DeleteSigintKeySharePolicyReq = {
  id: number;
};

type DeleteSigintKeySharePolicyReqBody = {
  id: number;
};

function normalizePolicy(raw: SigintKeySharePolicyLike): SigintKeySharePolicy {
  return {
    id: raw.id ?? 0,
    grantFrom: raw.grantFrom ?? raw.grant_from ?? 0,
    grantTo: raw.grantTo ?? raw.grant_to ?? 0,
    author: raw.author ?? '',
    createdAt: raw.createdAt ?? raw.created_at ?? 0,
  };
}

function toCreateReqBody(req: CreateSigintKeySharePolicyReq): CreateSigintKeySharePolicyReqBody {
  return {
    grant_from: req.grantFrom,
    grant_to: req.grantTo,
  };
}

function toDeleteReqBody(req: DeleteSigintKeySharePolicyReq): DeleteSigintKeySharePolicyReqBody {
  return { id: req.id };
}

export async function listKeySharePolicies(): Promise<SigintKeySharePolicy[]> {
  const data = await postJson<SigintKeySharePolicyLike[]>(
    '/api/sigint/key-share-policy/list',
    null,
  );
  return (data || []).map(normalizePolicy);
}

export async function createKeySharePolicy(
  req: CreateSigintKeySharePolicyReq,
): Promise<SigintKeySharePolicy> {
  const data = await postJson<SigintKeySharePolicyLike>(
    '/api/sigint/key-share-policy/create',
    toCreateReqBody(req),
  );
  return normalizePolicy(data || {});
}

export async function deleteKeySharePolicy(req: DeleteSigintKeySharePolicyReq): Promise<void> {
  await postVoid('/api/sigint/key-share-policy/delete', toDeleteReqBody(req));
}
