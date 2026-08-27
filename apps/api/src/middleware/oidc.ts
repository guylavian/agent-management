import type { NextFunction, Request, Response } from "express";
import type { OidcClient, RequestIdentity } from "@sre/auth";

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      identity?: RequestIdentity;
    }
  }
}

export function oidcAuthenticationMiddleware(oidc: OidcClient) {
  return async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) {
      response.status(401).json({ requestId: request.requestId, code: "AUTHN_FAILED", message: "Authentication required" });
      return;
    }
    try {
      request.identity = await oidc.verify(authorization.slice(7), request.requestId);
      next();
    } catch {
      response.status(401).json({ requestId: request.requestId, code: "AUTHN_FAILED", message: "Authentication failed" });
    }
  };
}
