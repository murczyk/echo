/**
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { listGoiAdminIntegrations, upsertGoiAdminIntegration } from './goi-admin';

const loginId = '019c8a6e-c110-7a34-a87b-f849afd2edfa';

describe('GOI admin login identifiers', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // @test-scope parser: GOI integration maintainer UUID response compatibility fixture
  it('reads the maintainer UUID from the backend field', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            items: [
              {
                id: 1,
                owner_organism_id: 2,
                maintainer_login_id: loginId,
                access_logins: [loginId],
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    await expect(listGoiAdminIntegrations()).resolves.toMatchObject([
      { maintainerLoginId: loginId, accessLogins: [loginId] },
    ]);
  });

  // @test-scope safeguard: prevents GOI integration saves from dropping maintainer access through a legacy field name
  it('writes the maintainer UUID to the backend field', async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (_input, init: RequestInit) => {
        body = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ maintainer_login_id: loginId }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );

    await upsertGoiAdminIntegration({
      id: null,
      ownerOrganismId: 2,
      integrationType: 'full',
      sshHost: '',
      sshUser: '',
      sshPort: 22,
      path: '/etc/goi/data/palettes',
      apiHost: '',
      apiPort: 8088,
      apiLogin: '',
      apiPassword: '',
      disableGoiToEchoPalitraSync: true,
      pauseWorker: false,
      maintainerLoginId: loginId,
      accessOrganismIds: [],
      accessLogins: [loginId],
    });

    expect(body).toMatchObject({
      maintainer_login_id: loginId,
      access_logins: [loginId],
    });
    expect(body).not.toHaveProperty('maintainer_login');
  });
});
