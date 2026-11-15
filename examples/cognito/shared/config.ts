export interface Configuration {
  readonly userPoolId: string;
  readonly clientId: string;
  readonly frontendOrigin: string;
}

/** Restrict CORS to one exact HTTPS origin (HTTP loopback is allowed for development). */
export function validateFrontendOrigin(value: string): string {
  try {
    const url = new URL(value);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.origin !== value || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) {
      throw new Error("Invalid origin");
    }
    return value;
  } catch {
    throw new Error("FRONTEND_ORIGIN must be an exact HTTPS origin (or HTTP loopback), without a path");
  }
}

export function readConfiguration(env: NodeJS.ProcessEnv = process.env): Configuration {
  const required = (name: string) => {
    const value = env[name];
    if (!value?.trim()) throw new Error(`Missing ${name}`);
    return value;
  };
  return {
    userPoolId: required("COGNITO_USER_POOL_ID"),
    clientId: required("COGNITO_CLIENT_ID"),
    frontendOrigin: validateFrontendOrigin(required("FRONTEND_ORIGIN")),
  };
}
