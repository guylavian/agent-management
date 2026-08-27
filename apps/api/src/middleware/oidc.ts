import type { RequestIdentity } from "@sre/auth";
import type { OidcClient } from "@sre/auth";
import type { FastifyReply, FastifyRequest } from "fastify";

declare module "fastify" {
  interface FastifyRequest { identity?: RequestIdentity }
}

export function oidcAuthenticationMiddleware(oidc: OidcClient) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) {
      await reply.code(401).send({ requestId: request.id, code: "AUTHN_FAILED", message: "Authentication required" });
      return;
    }
    try {
      request.identity = await oidc.verify(authorization.slice(7), request.id);
    } catch {
      await reply.code(401).send({ requestId: request.id, code: "AUTHN_FAILED", message: "Authentication failed" });
    }
  };
}
