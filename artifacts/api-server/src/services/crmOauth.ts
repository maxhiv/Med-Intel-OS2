/**
 * OAuth metadata + token exchange for the CRMs that support a real
 * "Connect" button (HubSpot and Salesforce). GoHighLevel still uses
 * pasted long-lived tokens.
 *
 * Each provider exposes:
 *   - `authorizationUrl(redirectUri, state)`: where to send the rep's browser
 *   - `exchangeCode(code, redirectUri, opts)`: trade auth code for tokens
 *   - `buildStoredCredentials(tokens, opts)`: the JSON blob to encrypt and
 *     persist into sub_accounts.crm_credentials
 *
 * Required env vars (per provider):
 *   HUBSPOT_OAUTH_CLIENT_ID, HUBSPOT_OAUTH_CLIENT_SECRET
 *   SALESFORCE_OAUTH_CLIENT_ID, SALESFORCE_OAUTH_CLIENT_SECRET
 * Optional:
 *   HUBSPOT_OAUTH_SCOPES (space-separated, override default scopes)
 *   SALESFORCE_OAUTH_SCOPES
 */

export type CrmOauthProvider = "hubspot" | "salesforce";

export const SUPPORTED_OAUTH_PROVIDERS: readonly CrmOauthProvider[] = [
  "hubspot",
  "salesforce",
] as const;

export function isOauthProvider(v: string): v is CrmOauthProvider {
  return (SUPPORTED_OAUTH_PROVIDERS as readonly string[]).includes(v);
}

export interface OauthTokenResult {
  accessToken: string;
  refreshToken?: string;
  /** Salesforce-specific */
  instanceUrl?: string;
  /** Some providers return a TTL we don't currently use, kept for logging. */
  expiresIn?: number;
  raw: Record<string, unknown>;
}

export interface ExchangeOpts {
  /** For Salesforce, the login URL the user picked (sandbox vs prod). */
  loginUrl?: string;
}

/**
 * Public base URL the CRM should redirect the browser back to. The CRM
 * developer console requires the redirect URI to be pre-registered, so
 * deployments must set PUBLIC_BASE_URL once they have a stable domain.
 */
export function publicBaseUrl(): string {
  const explicit = process.env.PUBLIC_BASE_URL?.replace(/\/+$/, "");
  if (explicit) return explicit;
  const replit = process.env.REPLIT_DEV_DOMAIN;
  if (replit) return `https://${replit}`;
  throw new Error(
    "PUBLIC_BASE_URL (or REPLIT_DEV_DOMAIN) must be set so OAuth redirect URIs can be built.",
  );
}

export function callbackUri(provider: CrmOauthProvider): string {
  return `${publicBaseUrl()}/api/oauth/crm/${provider}/callback`;
}

/**
 * Where to send the browser after a successful (or failed) callback. The
 * UI inspects the `crmConnected` / `crmConnectError` query params to show
 * a toast and refresh the credentials view.
 */
export function postCallbackRedirect(
  status: "ok" | "error",
  provider: CrmOauthProvider,
  subAccountId: string,
  message?: string,
): string {
  const params = new URLSearchParams({
    provider,
    subAccountId,
    ...(status === "ok"
      ? { crmConnected: "1" }
      : { crmConnectError: message?.slice(0, 200) ?? "unknown_error" }),
  });
  return `${publicBaseUrl()}/admin?${params.toString()}`;
}

const HUBSPOT_DEFAULT_SCOPES = [
  "oauth",
  "crm.objects.contacts.read",
  "crm.objects.contacts.write",
];
const SALESFORCE_DEFAULT_SCOPES = ["api", "refresh_token", "offline_access"];

interface ProviderConfig {
  clientId: string;
  clientSecret: string;
  scopes: string[];
}

function readHubspotConfig(): ProviderConfig {
  const clientId = process.env.HUBSPOT_OAUTH_CLIENT_ID;
  const clientSecret = process.env.HUBSPOT_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "HubSpot OAuth is not configured (set HUBSPOT_OAUTH_CLIENT_ID + HUBSPOT_OAUTH_CLIENT_SECRET).",
    );
  }
  const scopes = (process.env.HUBSPOT_OAUTH_SCOPES?.trim() || HUBSPOT_DEFAULT_SCOPES.join(" "))
    .split(/\s+/)
    .filter(Boolean);
  return { clientId, clientSecret, scopes };
}

function readSalesforceConfig(): ProviderConfig {
  const clientId = process.env.SALESFORCE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.SALESFORCE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "Salesforce OAuth is not configured (set SALESFORCE_OAUTH_CLIENT_ID + SALESFORCE_OAUTH_CLIENT_SECRET).",
    );
  }
  const scopes = (process.env.SALESFORCE_OAUTH_SCOPES?.trim() || SALESFORCE_DEFAULT_SCOPES.join(" "))
    .split(/\s+/)
    .filter(Boolean);
  return { clientId, clientSecret, scopes };
}

export function isProviderConfigured(provider: CrmOauthProvider): boolean {
  try {
    if (provider === "hubspot") readHubspotConfig();
    else readSalesforceConfig();
    return true;
  } catch {
    return false;
  }
}

export function authorizationUrl(
  provider: CrmOauthProvider,
  state: string,
  opts: ExchangeOpts = {},
): string {
  const redirectUri = callbackUri(provider);
  if (provider === "hubspot") {
    const cfg = readHubspotConfig();
    const params = new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: redirectUri,
      scope: cfg.scopes.join(" "),
      state,
    });
    return `https://app.hubspot.com/oauth/authorize?${params.toString()}`;
  }
  const cfg = readSalesforceConfig();
  const base = (opts.loginUrl ?? "https://login.salesforce.com").replace(/\/+$/, "");
  const params = new URLSearchParams({
    response_type: "code",
    client_id: cfg.clientId,
    redirect_uri: redirectUri,
    scope: cfg.scopes.join(" "),
    state,
  });
  return `${base}/services/oauth2/authorize?${params.toString()}`;
}

async function postForm(
  url: string,
  body: Record<string, string>,
): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(body).toString(),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    const detail =
      parsed && typeof parsed === "object"
        ? JSON.stringify(parsed)
        : String(parsed ?? "");
    throw new Error(`OAuth token exchange failed (${res.status}): ${detail.slice(0, 300)}`);
  }
  return (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
}

export async function exchangeCode(
  provider: CrmOauthProvider,
  code: string,
  opts: ExchangeOpts = {},
): Promise<OauthTokenResult> {
  const redirectUri = callbackUri(provider);
  if (provider === "hubspot") {
    const cfg = readHubspotConfig();
    const raw = await postForm("https://api.hubapi.com/oauth/v1/token", {
      grant_type: "authorization_code",
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: redirectUri,
      code,
    });
    const accessToken = String(raw.access_token ?? "");
    if (!accessToken) {
      throw new Error("HubSpot token exchange returned no access_token");
    }
    return {
      accessToken,
      refreshToken: typeof raw.refresh_token === "string" ? raw.refresh_token : undefined,
      expiresIn: typeof raw.expires_in === "number" ? raw.expires_in : undefined,
      raw,
    };
  }
  const cfg = readSalesforceConfig();
  const base = (opts.loginUrl ?? "https://login.salesforce.com").replace(/\/+$/, "");
  const raw = await postForm(`${base}/services/oauth2/token`, {
    grant_type: "authorization_code",
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: redirectUri,
    code,
  });
  const accessToken = String(raw.access_token ?? "");
  if (!accessToken) {
    throw new Error("Salesforce token exchange returned no access_token");
  }
  const instanceUrl =
    typeof raw.instance_url === "string" ? raw.instance_url.replace(/\/+$/, "") : "";
  if (!instanceUrl) {
    throw new Error("Salesforce token exchange returned no instance_url");
  }
  return {
    accessToken,
    refreshToken: typeof raw.refresh_token === "string" ? raw.refresh_token : undefined,
    instanceUrl,
    raw,
  };
}

/**
 * Shape the token-exchange result into the credentials JSON we already
 * persist via the existing CRM adapters. For Salesforce we inject the
 * connected-app client id/secret so the auto-refresh path in the
 * Salesforce adapter works without re-prompting the user.
 */
export function buildStoredCredentials(
  provider: CrmOauthProvider,
  tokens: OauthTokenResult,
  opts: ExchangeOpts = {},
): Record<string, unknown> {
  if (provider === "hubspot") {
    const cfg = readHubspotConfig();
    const out: Record<string, unknown> = { accessToken: tokens.accessToken };
    if (tokens.refreshToken) out.refreshToken = tokens.refreshToken;
    out.clientId = cfg.clientId;
    out.clientSecret = cfg.clientSecret;
    return out;
  }
  const cfg = readSalesforceConfig();
  const out: Record<string, unknown> = {
    accessToken: tokens.accessToken,
    instanceUrl: tokens.instanceUrl,
    apiVersion: "v60.0",
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
  };
  if (tokens.refreshToken) out.refreshToken = tokens.refreshToken;
  if (opts.loginUrl) out.loginUrl = opts.loginUrl;
  return out;
}
