export interface RequestHeaders {
  host?: string;
  origin?: string;
  "sec-fetch-site"?: string;
  "content-type"?: string;
}

export interface GuardResult {
  allowed: boolean;
  status: number;
  reason?: string;
}

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/;

/**
 * Protects the local demo API, which can spend testnet funds and rewrite `.env`, from web pages
 * the user happens to visit and from DNS rebinding. Non-browser clients (curl, scripts) send no
 * Origin header and are allowed, because they already run on this machine.
 */
export function checkApiRequest(method: string | undefined, headers: RequestHeaders): GuardResult {
  const deny = (status: number, reason: string): GuardResult => ({ allowed: false, status, reason });

  // A rebinding attack reaches us under the attacker's hostname, not a local one.
  const host = headers.host ?? "";
  if (!LOCAL_HOST.test(host)) return deny(403, "Unexpected Host header");

  if (headers.origin !== undefined && headers.origin !== `http://${host}`) {
    return deny(403, "Cross-origin request refused");
  }

  const fetchSite = headers["sec-fetch-site"];
  if (fetchSite !== undefined && fetchSite !== "same-origin" && fetchSite !== "none") {
    return deny(403, "Cross-site request refused");
  }

  if (method === "POST") {
    // Requiring JSON forces a CORS preflight for cross-origin callers, which this server never approves.
    const type = (headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    if (type !== "application/json") return deny(415, "Content-Type must be application/json");
  }

  return { allowed: true, status: 200 };
}
