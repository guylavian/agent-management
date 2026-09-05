/**
 * Verifies RFC 8693 token exchange against a REAL Keycloak instance.
 *
 * Tests the three conditions necessary for token exchange:
 * 1. The actor client has `standard.token.exchange.enabled` = "true"
 * 2. The subject token's `aud` includes the actor client id
 * 3. The actor can mint the requested audience via audience mapper
 *
 * Creates a disposable realm for testing and deletes it on completion.
 *
 *   KEYCLOAK_URL, KEYCLOAK_REALM, KEYCLOAK_ADMIN, KEYCLOAK_ADMIN_PASSWORD
 *   npm run verify:token-exchange
 *
 * Reads Keycloak credentials from the environment and never logs or prints them.
 */

interface TokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

interface RealmRepresentation {
  id?: string;
  realm: string;
  enabled: boolean;
}

interface ClientRepresentation {
  id?: string;
  clientId: string;
  name: string;
  enabled: boolean;
  publicClient: boolean;
  serviceAccountsEnabled: boolean;
  standardFlowEnabled: boolean;
  directAccessGrantsEnabled: boolean;
  protocol: string;
  attributes?: Record<string, string>;
  optionalClientScopes?: string[];
  redirectUris?: string[];
}

interface UserRepresentation {
  id?: string;
  username: string;
  email: string;
  firstName: string;
  lastName: string;
  emailVerified: boolean;
  enabled: boolean;
  credentials?: Array<{ type: string; value: string; temporary: boolean }>;
}

interface ClientScope {
  id?: string;
  name: string;
  protocol: string;
  attributes?: Record<string, string>;
  protocolMappers?: Array<{
    name: string;
    protocol: string;
    protocolMapper: string;
    config: Record<string, string>;
  }>;
}

type DecodedToken = Record<string, unknown>;

const baseUrl = (process.env.KEYCLOAK_URL ?? "").replace(/\/$/u, "");
const realm = process.env.KEYCLOAK_REALM ?? "sre-test";
const adminRealm = process.env.KEYCLOAK_ADMIN_REALM ?? "master";
const username = process.env.KEYCLOAK_ADMIN ?? "";
const password = process.env.KEYCLOAK_ADMIN_PASSWORD ?? "";

if (!baseUrl || !username || !password) {
  console.error("KEYCLOAK_URL, KEYCLOAK_ADMIN and KEYCLOAK_ADMIN_PASSWORD are required");
  process.exit(1);
}

// Set up TLS support for self-signed certificates
const caCertPath = `${process.env.HOME ?? "/root"}/.sre-agent/keycloak-ca.crt`;
let fetchOptions: RequestInit = {};
if (process.env.NODE_EXTRA_CA_CERTS) {
  // Using NODE_EXTRA_CA_CERTS environment variable is handled by Node.js automatically
  fetchOptions = {};
}

const results: Array<{ name: string; state: "PASS" | "FAIL"; detail: string }> = [];
function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, state: ok ? "PASS" : "FAIL", detail });
}

async function adminToken(): Promise<string> {
  const response = await fetch(`${baseUrl}/realms/${adminRealm}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "password", client_id: "admin-cli", username, password }),
    signal: AbortSignal.timeout(10_000),
    ...fetchOptions,
  });
  if (!response.ok) throw new Error(`Keycloak admin authentication failed (${response.status})`);
  const payload = (await response.json()) as TokenResponse;
  if (!payload.access_token) throw new Error("Keycloak admin authentication returned no token");
  return payload.access_token;
}

async function adminCallRealm<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await adminToken();
  const response = await fetch(`${baseUrl}/admin/realms${path}`, {
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers },
    signal: AbortSignal.timeout(10_000),
    ...init,
    ...fetchOptions,
  });
  if (!response.ok && response.status !== 409) {
    throw new Error(`admin ${init.method ?? "GET"} ${path} failed (${response.status})`);
  }
  if (response.status === 204 || response.status === 409 || response.status === 201) {
    return {} as T;
  }
  const text = await response.text();
  if (!text) return {} as T;
  return JSON.parse(text) as T;
}

async function adminCall<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await adminToken();
  const response = await fetch(`${baseUrl}/admin/realms/${verifyRealmName}${path}`, {
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers },
    signal: AbortSignal.timeout(10_000),
    ...init,
    ...fetchOptions,
  });
  if (!response.ok && response.status !== 409) {
    throw new Error(`admin ${init.method ?? "GET"} ${path} failed (${response.status})`);
  }
  if (response.status === 204 || response.status === 409 || response.status === 201) {
    return {} as T;
  }
  const text = await response.text();
  if (!text) return {} as T;
  return JSON.parse(text) as T;
}

function decodeToken(token: string): DecodedToken {
  const segment = token.split(".")[1];
  if (!segment) throw new Error("Invalid token format");
  const padded = segment.padEnd(segment.length + (4 - (segment.length % 4)) % 4, "=");
  return JSON.parse(Buffer.from(padded, "base64url").toString("utf8")) as DecodedToken;
}

async function createRealm(realmName: string): Promise<void> {
  await adminCallRealm(
    "",
    {
      method: "POST",
      body: JSON.stringify({
        realm: realmName,
        enabled: true,
        accessTokenLifespan: 300,
      } as RealmRepresentation),
    }
  );
}

async function deleteRealm(realmName: string): Promise<void> {
  await adminCallRealm(`/${realmName}`, { method: "DELETE" });
}

async function createClient(clientId: string, name: string, attributes?: Record<string, string>, audiences: string[] = []): Promise<string> {
  const result = await adminCall<{ id?: string }>(
    "/clients",
    {
      method: "POST",
      body: JSON.stringify({
        clientId,
        name,
        enabled: true,
        publicClient: false,
        serviceAccountsEnabled: true,
        standardFlowEnabled: false,
        directAccessGrantsEnabled: true,
        protocol: "openid-connect",
        attributes: attributes ?? {},
        /*
         * An inline audience mapper, not an attached client scope. Condition 3
         * is that the ACTOR can mint the requested audience; a scope only
         * applies when it is requested or default, and relying on that made the
         * exchanged token come back with no target audience at all.
         */
        protocolMappers: audiences.map((audience) => ({
          name: `aud-${audience}`,
          protocol: "openid-connect",
          protocolMapper: "oidc-audience-mapper",
          config: { "included.client.audience": audience, "access.token.claim": "true", "id.token.claim": "false" },
        })),
      } as ClientRepresentation),
    }
  );

  // Fetch the created client to get its ID
  const created = await adminCall<ClientRepresentation[]>(`/clients?clientId=${encodeURIComponent(clientId)}`);
  const client = created[0];
  if (!client?.id) throw new Error(`client ${clientId} not created`);
  return client.id;
}

async function getClient(clientId: string): Promise<ClientRepresentation | undefined> {
  const result = await adminCall<ClientRepresentation[]>(`/clients?clientId=${encodeURIComponent(clientId)}`);
  return result[0];
}

async function getClientSecret(clientId: string): Promise<string> {
  const client = await getClient(clientId);
  if (!client?.id) throw new Error(`client ${clientId} not found`);
  const secret = await adminCall<{ value: string }>(`/clients/${client.id}/client-secret`);
  return secret.value;
}

async function createClientScope(scopeName: string, audience: string): Promise<void> {
  await adminCall(
    "/client-scopes",
    {
      method: "POST",
      body: JSON.stringify({
        name: scopeName,
        protocol: "openid-connect",
        attributes: { "include.in.token.scope": "true", "display.on.consent.screen": "false" },
        protocolMappers: [
          {
            name: `audience-${scopeName}`,
            protocol: "openid-connect",
            protocolMapper: "oidc-audience-mapper",
            config: { "included.custom.audience": audience, "access.token.claim": "true", "id.token.claim": "false" },
          },
        ],
      } as ClientScope),
    }
  );
}


async function attachClientScope(clientIdOrUuid: string, scopeName: string): Promise<void> {
  // Handle both UUID and clientId
  let clientUuid = clientIdOrUuid;
  if (!clientIdOrUuid.includes("-")) {
    // It's a clientId, not a UUID
    const client = await getClient(clientIdOrUuid);
    if (!client?.id) throw new Error(`client ${clientIdOrUuid} not found`);
    clientUuid = client.id;
  }
  const scopes = await adminCall<Array<{ id: string; name: string }>>("/client-scopes");
  const scope = scopes.find((s) => s.name === scopeName);
  if (!scope?.id) throw new Error(`client scope ${scopeName} not found`);
  await adminCall(`/clients/${clientUuid}/optional-client-scopes/${scope.id}`, { method: "PUT" });
}

async function createUser(username: string, password: string): Promise<string> {
  const result = await adminCall<{ id?: string }>(
    "/users",
    {
      method: "POST",
      body: JSON.stringify({
        username,
        email: `${username}@example.com`,
        firstName: "Test",
        lastName: "User",
        emailVerified: true,
        enabled: true,
        credentials: [{ type: "password", value: password, temporary: false }],
      } as UserRepresentation),
    }
  );

  // Fetch the created user to get its ID
  const created = await adminCall<UserRepresentation[]>(`/users?username=${encodeURIComponent(username)}`);
  const user = created[0];
  if (!user?.id) throw new Error(`user ${username} not created`);
  return user.id;
}

async function getUserToken(
  clientId: string,
  clientSecret: string,
  username: string,
  password: string,
  scope?: string
): Promise<{ ok: boolean; token?: string; error?: string }> {
  const params = new URLSearchParams({
    grant_type: "password",
    client_id: clientId,
    client_secret: clientSecret,
    username,
    password,
  });
  if (scope) params.set("scope", scope);
  const response = await fetch(`${baseUrl}/realms/${verifyRealmName}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params,
    signal: AbortSignal.timeout(10_000),
    ...fetchOptions,
  });
  const payload = (await response.json()) as TokenResponse;
  if (!payload.access_token) return { ok: false, error: payload.error_description ?? payload.error };
  return { ok: true, token: payload.access_token };
}

async function exchangeToken(
  actorClientId: string,
  actorClientSecret: string,
  subjectToken: string,
  requestedAudience: string
): Promise<{ ok: boolean; token?: string; error?: string }> {
  const response = await fetch(`${baseUrl}/realms/${verifyRealmName}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      client_id: actorClientId,
      client_secret: actorClientSecret,
      subject_token: subjectToken,
      subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      requested_audience: requestedAudience,
    }),
    signal: AbortSignal.timeout(10_000),
    ...fetchOptions,
  });
  const payload = (await response.json()) as TokenResponse;
  if (!payload.access_token) return { ok: false, error: payload.error_description ?? payload.error };
  return { ok: true, token: payload.access_token };
}

// Disposable realm name
const verifyRealmName = "sre-tx-verify";

try {
  // Clean up any stale test realm from a previous failure
  try {
    await deleteRealm(verifyRealmName);
  } catch {
    // Ignore if it doesn't exist
  }

  // Create the disposable realm
  await createRealm(verifyRealmName);

  // Create the target client (what the actor will exchange tokens FOR)
  const targetId = await createClient("probe-target", "Token Exchange Target");

  // Create the actor client WITH the exchange attribute (the workload identity)
  // Do this before creating the login client so we can reference its client ID
  const actorId = await createClient("probe-actor", "Token Exchange Actor", {
    "standard.token.exchange.enabled": "true",
    "access.token.lifespan": "60",
  }, ["test-target"]);

  // Create client scopes for test audiences
  // The test-actor-scope should include the ACTOR CLIENT ID as the audience
  // so token exchange can verify the subject token includes the actor
  await createClientScope("test-target-scope", "test-target");
  await createClientScope("test-actor-scope", "probe-actor"); // Use actor client ID as audience

  // Create the login client (used by the user to get a subject token)
  const loginId = await createClient("probe-login", "Login Client", {
    "access.token.lifespan": "300",
  });
  // Attach audience mappers for both target and actor to the login client's tokens
  await attachClientScope(loginId, "test-target-scope");
  await attachClientScope(loginId, "test-actor-scope");

  // the actor was already created above, before the login client, so its id
  // could be named in that client's audience mapper — condition 2
  await attachClientScope(actorId, "test-target-scope");

  // Create a control actor WITHOUT the exchange attribute to test the negative case
  const controlId = await createClient("probe-control", "Control (No Exchange)", {
    "access.token.lifespan": "60",
  });
  await attachClientScope(controlId, "test-target-scope");

  // Create a test user with complete profile
  const userId = await createUser("alice", "password123");

  // Get client secrets
  const loginSecret = await getClientSecret("probe-login");
  const actorSecret = await getClientSecret("probe-actor");
  const controlSecret = await getClientSecret("probe-control");

  // Get a subject token for the user (login as user via the login client)
  // Request the actor scope so the token carries the actor audience
  const userTokenResult = await getUserToken("probe-login", loginSecret, "alice", "password123", "test-actor-scope");
  record("obtain user access token", userTokenResult.ok, userTokenResult.ok ? "success" : userTokenResult.error ?? "unknown error");
  if (!userTokenResult.ok || !userTokenResult.token) {
    throw new Error("Failed to obtain user token for testing");
  }

  const userToken = userTokenResult.token;
  const userClaims = decodeToken(userToken);

  // Verify the user token carries both actor and target in its audience
  const userAud = ([] as string[]).concat((userClaims.aud as string | string[] | undefined) ?? []);
  record(
    "subject token aud includes the actor",
    // the actor client is `probe-actor`; Keycloak refuses the exchange unless
    // the SUBJECT token's audience already names the client doing the exchanging
    userAud.includes("probe-actor"),
    `aud=${JSON.stringify(userAud)}`
  );

  // Exchange the token via the actor client
  const exchangeResult = await exchangeToken("probe-actor", actorSecret, userToken, "test-target");
  record(
    "token exchange returns HTTP 200",
    exchangeResult.ok,
    exchangeResult.ok ? "success" : exchangeResult.error ?? "unknown error"
  );

  if (exchangeResult.ok && exchangeResult.token) {
    const exchangedClaims = decodeToken(exchangeResult.token);

    // Verify the subject survives the exchange
    record(
      "exchanged token sub equals user id",
      exchangedClaims.sub === userId,
      `sub=${String(exchangedClaims.sub)}, user_id=${userId}`
    );

    /*
     * The requested target is present, and no OTHER exchange target leaked in.
     * Not "exactly one": Keycloak always adds its own `account` audience, so an
     * equality check would fail against a correct token and teach the reader
     * the wrong invariant. What matters is that one tool audience was granted
     * and the others were not.
     */
    const exchangedAud = ([] as string[]).concat((exchangedClaims.aud as string | string[] | undefined) ?? []);
    const otherTargets = exchangedAud.filter((entry) => entry.startsWith("probe-") || (entry.startsWith("test-") && entry !== "test-target"));
    record(
      "exchanged token aud grants the requested target and no other",
      exchangedAud.includes("test-target") && otherTargets.length === 0,
      `aud=${JSON.stringify(exchangedAud)}`
    );

    // Verify azp is the actor client
    record(
      "exchanged token azp is the actor client",
      exchangedClaims.azp === "probe-actor",
      `azp=${String(exchangedClaims.azp)}`
    );
  }

  // Negative control: same exchange without the attribute should fail
  const controlExchange = await exchangeToken("probe-control", controlSecret, userToken, "test-target");
  record(
    "exchange without standard.token.exchange.enabled is refused",
    !controlExchange.ok,
    controlExchange.ok ? `GRANTED (FAILURE) — azp=${String((controlExchange.token ? decodeToken(controlExchange.token) : {}).azp)}` : `denied: ${controlExchange.error}`
  );

  // Report results
  const failures = results.filter((result) => result.state === "FAIL");
  for (const result of results) console.log(`${result.state === "PASS" ? "PASS" : "FAIL"}  ${result.name}\n      ${result.detail}`);
  console.log(`\n${results.length - failures.length} PASS, ${failures.length} FAIL`);

  if (failures.length > 0) {
    process.exit(1);
  }
} finally {
  // Always clean up the disposable realm
  try {
    await deleteRealm(verifyRealmName);
  } catch (error) {
    // Log but don't fail on cleanup error
    console.error(`Warning: failed to clean up test realm: ${error instanceof Error ? error.message : String(error)}`);
  }
}
