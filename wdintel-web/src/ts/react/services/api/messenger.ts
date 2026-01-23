import {
  AccountStatusReq,
  AccountsRsp,
  DeleteAccountReq,
  IsAccountLinkedReq,
  IsAccountLinkedRsp,
  LinkAccountReq,
  LinkAccountRsp,
  LinkEchoOperatorReq,
  QrCodeReq,
  QrCodeRsp,
} from '../../../../Bindings';

import { postJson, postVoid } from './client';

type QrCodeReqBody = {
  account_id: number;
};

type IsAccountLinkedReqBody = {
  account_id: number;
};

type AccountStatusReqBody = {
  account_id: number;
  aor_id: number | null;
  is_active: boolean;
  display_name: string;
  description: string | null;
  api_login: string | null;
  api_endpoint: string | null;
};

type DeleteAccountReqBody = {
  account_id: number;
};

type LinkAccountReqBody = {
  phone: string;
  messenger: string;
  display_name: string;
  system_service_name: string;
  description: string | null;
  aor_id: number;
};

type LinkEchoOperatorReqBody = {
  api_login: string;
  api_endpoint: string;
  display_name: string;
  description: string | null;
  aor_id: number;
};

function toQrCodeReqBody(req: QrCodeReq): QrCodeReqBody {
  return { account_id: req.accountId };
}

function toIsAccountLinkedReqBody(req: IsAccountLinkedReq): IsAccountLinkedReqBody {
  return { account_id: req.accountId };
}

function toAccountStatusReqBody(req: AccountStatusReq): AccountStatusReqBody {
  return {
    account_id: req.accountId,
    aor_id: req.aorId,
    is_active: req.isActive,
    display_name: req.displayName,
    description: req.description,
    api_login: req.apiLogin,
    api_endpoint: req.apiEndpoint,
  };
}

function toDeleteAccountReqBody(req: DeleteAccountReq): DeleteAccountReqBody {
  return { account_id: req.accountId };
}

function toLinkAccountReqBody(req: LinkAccountReq): LinkAccountReqBody {
  return {
    phone: req.phone,
    messenger: req.messenger,
    display_name: req.displayName,
    system_service_name: req.systemServiceName,
    description: req.description,
    aor_id: req.aorId,
  };
}

function toLinkEchoOperatorReqBody(req: LinkEchoOperatorReq): LinkEchoOperatorReqBody {
  return {
    api_login: req.apiLogin,
    api_endpoint: req.apiEndpoint,
    display_name: req.displayName,
    description: req.description,
    aor_id: req.aorId,
  };
}

export async function listAccounts(): Promise<AccountsRsp> {
  return postJson<AccountsRsp>('/api/messenger/list', null);
}

export async function getQrCode(req: QrCodeReq): Promise<QrCodeRsp> {
  return postJson<QrCodeRsp>('/api/messenger/qr', toQrCodeReqBody(req));
}

export async function isLinked(req: IsAccountLinkedReq): Promise<IsAccountLinkedRsp> {
  return postJson<IsAccountLinkedRsp>('/api/messenger/is-linked', toIsAccountLinkedReqBody(req));
}

export async function editAccount(req: AccountStatusReq): Promise<void> {
  await postVoid('/api/messenger/edit', toAccountStatusReqBody(req));
}

export async function unlinkAccount(req: DeleteAccountReq): Promise<void> {
  await postVoid('/api/messenger/unlink', toDeleteAccountReqBody(req));
}

export async function linkAccount(req: LinkAccountReq): Promise<LinkAccountRsp> {
  return postJson<LinkAccountRsp>('/api/messenger/link', toLinkAccountReqBody(req));
}

export async function linkOperator(req: LinkEchoOperatorReq): Promise<LinkAccountRsp> {
  return postJson<LinkAccountRsp>('/api/messenger/link-operator', toLinkEchoOperatorReqBody(req));
}
