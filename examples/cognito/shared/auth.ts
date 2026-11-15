import { CognitoJwtVerifier } from "aws-jwt-verify";

export interface AuthenticatedUser {
  readonly userId: string;
  readonly groups: string[];
}

export type Authenticate = (authorization: string | undefined) => Promise<AuthenticatedUser | null>;

export function createCognitoAuth(config: { userPoolId: string; clientId: string }) {
  // One verifier per server: signing keys are cached and rotated by the library.
  const verifier = CognitoJwtVerifier.create({
    userPoolId: config.userPoolId,
    clientId: config.clientId,
    tokenUse: "access",
  });

  const authenticate: Authenticate = async (authorization) => {
    const match = /^Bearer\s+(\S+)$/i.exec(authorization ?? "");
    if (!match) return null;
    try {
      const claims = await verifier.verify(match[1]!);
      return { userId: claims.sub, groups: claims["cognito:groups"] ?? [] };
    } catch {
      // Fail closed. Never return JWT contents or verification details to callers.
      return null;
    }
  };

  return { verifier, authenticate };
}
