import type { Authenticate } from "./auth";

export interface ApiOptions {
  readonly authenticate: Authenticate;
  readonly frontendOrigin: string;
}

interface CorsRequest {
  readonly method: string;
  readonly origin?: string;
  readonly requestedMethod?: string;
  readonly requestedHeaders?: string;
}

/** CORS is a browser permission policy, not authentication. Non-browser callers still need tokens. */
export function corsPolicy(request: CorsRequest, frontendOrigin: string) {
  const headers: Record<string, string> = { Vary: "Origin", "Cache-Control": "no-store" };
  if (request.origin === frontendOrigin) headers["Access-Control-Allow-Origin"] = frontendOrigin;
  if (request.method !== "OPTIONS") return { headers, preflightStatus: undefined };

  headers.Vary = "Origin, Access-Control-Request-Method, Access-Control-Request-Headers";
  const allowedHeaders = ["authorization", "content-type"];
  const requestedHeaders = (request.requestedHeaders ?? "")
    .split(",").map(header => header.trim().toLowerCase()).filter(Boolean);
  if (request.origin !== frontendOrigin || request.requestedMethod !== "GET" ||
      requestedHeaders.some(header => !allowedHeaders.includes(header))) {
    return { headers, preflightStatus: 403 };
  }
  headers["Access-Control-Allow-Methods"] = "GET, OPTIONS";
  headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type";
  headers["Access-Control-Max-Age"] = "600";
  return { headers, preflightStatus: 204 };
}
