import { mockServices } from '@backstage/backend-test-utils';
import { HttpRuntimeManagementClient, readRuntimeManagementClientOptions } from './RuntimeManagementClient';

describe('readRuntimeManagementClientOptions', () => {
  it('treats an OIDC block with only unset placeholders as unconfigured', () => {
    const config = mockServices.rootConfig({
      data: { sreAgent: { managementApi: { oidc: {} } } },
    });

    expect(readRuntimeManagementClientOptions(config)).toEqual({
      baseUrl: undefined,
      token: undefined,
    });
  });

  it('reads a complete OIDC configuration', () => {
    const config = mockServices.rootConfig({
      data: {
        sreAgent: {
          managementApi: {
            baseUrl: 'http://runtime',
            oidc: {
              tokenUrl: 'http://keycloak/token',
              clientId: 'portal',
              clientSecret: 'secret',
              username: 'operator',
              password: 'password',
            },
          },
        },
      },
    });

    expect(readRuntimeManagementClientOptions(config)).toEqual({
      baseUrl: 'http://runtime',
      token: undefined,
      oidc: {
        tokenUrl: 'http://keycloak/token',
        clientId: 'portal',
        clientSecret: 'secret',
        username: 'operator',
        password: 'password',
      },
    });
  });

  it('rejects a partially configured OIDC credential', () => {
    const config = mockServices.rootConfig({
      data: {
        sreAgent: {
          managementApi: {
            oidc: { clientId: 'portal' },
          },
        },
      },
    });

    expect(() => readRuntimeManagementClientOptions(config)).toThrow(
      'incomplete sreAgent.managementApi.oidc configuration; missing: tokenUrl, clientSecret, username, password',
    );
  });
});

describe('HttpRuntimeManagementClient dev token', () => {
  it('mints a token from the runtime dev route, caches it, and sends it as a bearer', async () => {
    const calls: Array<{ url: string; auth?: string }> = [];
    const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, auth: (init?.headers as Record<string, string> | undefined)?.authorization });
      if (url.endsWith('/dev/token/alice')) return { ok: true, status: 200, json: async () => ({ token: 'fresh' }) };
      return { ok: true, status: 200, json: async () => ({ agents: [] }) };
    });
    const realFetch = global.fetch;
    global.fetch = fetchMock as never;
    try {
      const client = new HttpRuntimeManagementClient({ baseUrl: 'http://runtime', token: 'stale', devTokenUrl: 'http://runtime/dev/token/alice' });
      await client.get('/management/agents');
      await client.get('/management/agents');
      // one mint, two authenticated calls, and the pasted token is never sent
      expect(calls.filter(call => call.url.endsWith('/dev/token/alice'))).toHaveLength(1);
      expect(calls.filter(call => call.auth === 'Bearer fresh')).toHaveLength(2);
      expect(calls.some(call => call.auth === 'Bearer stale')).toBe(false);
    } finally {
      global.fetch = realFetch;
    }
  });

  it('re-mints once when a cached token is rejected (runtime restarted)', async () => {
    let minted = 0;
    let rejectFirst = true;
    const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/dev/token/alice')) { minted += 1; return { ok: true, status: 200, json: async () => ({ token: `t${minted}` }) }; }
      const auth = (init?.headers as Record<string, string>).authorization;
      if (auth === 'Bearer t1' && rejectFirst) { rejectFirst = false; return { ok: false, status: 401, json: async () => ({}) }; }
      return { ok: true, status: 200, json: async () => ({ agents: [] }) };
    });
    const realFetch = global.fetch;
    global.fetch = fetchMock as never;
    try {
      const client = new HttpRuntimeManagementClient({ baseUrl: 'http://runtime', devTokenUrl: 'http://runtime/dev/token/alice' });
      await client.get('/management/agents');
      // the runtime restarts: t1 is now rejected, t2 is minted and used
      rejectFirst = true;
      await expect(client.get('/management/agents')).resolves.toEqual({ agents: [] });
      expect(minted).toBe(2);
    } finally {
      global.fetch = realFetch;
    }
  });
});
