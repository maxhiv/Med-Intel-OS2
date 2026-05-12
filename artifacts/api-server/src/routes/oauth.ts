/**
 * Guided OAuth "Connect" flow for HubSpot and Salesforce. Lets a sub-account
 * owner self-serve a CRM connection without an admin pasting long-lived
 * tokens into the credentials editor.
 *
 * Surfaces:
 *   GET  /sub-accounts/:id/crm/connection
 *        Connection status (which provider, whether a refresh token is
 *        present). Authenticated; sub-account owners + platform admins.
 *
 *   GET  /sub-accounts/:id/crm/oauth/start?provider=hubspot|salesforce
 *        Returns `{ authorizationUrl }` for the SPA to redirect to.
 *
 *   DELETE /sub-accounts/:id/crm/credentials
 *        Wipes stored credentials (the "Disconnect" button).
 *
 *   GET  /oauth/crm/:provider/callback?code&state
 *        Public callback hit by the CRM after the rep grants consent.
 *        Verifies the signed state, exchanges the code for tokens, and
 *        encrypts + persists the result via the existing encryption helper.
 *        Then 302s back to the admin UI with a success/error query param.
 */
import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, subAccounts, type SubAccount } from "@workspace/db";
import { requireAuth, requireSubAccountAccess } from "../middlewares/auth";
import {
  authorizationUrl,
  buildStoredCredentials,
  callbackUri,
  exchangeCode,
  isOauthProvider,
  isProviderConfigured,
  postCallbackRedirect,
  publicBaseUrl,
  SUPPORTED_OAUTH_PROVIDERS,
  type CrmOauthProvider,
} from "../services/crmOauth";
import { signState, verifyState } from "../services/oauthState";
import { encryptJson, isEncryptedBlob } from "../services/encryption";
import { logger } from "../lib/logger";

const router: IRouter = Router();

router.get(
  "/sub-accounts/:id/crm/connection",
  requireAuth,
  requireSubAccountAccess,
  (_req, res) => {
    const sub = res.locals.subAccount as SubAccount;
    const stored = (sub.crmCredentials ?? {}) as Record<string, unknown>;
    const encrypted = isEncryptedBlob(stored);
    // We don't decrypt here just to detect a refresh token — the UI only
    // needs to know "is something stored at all". The presence flag is
    // enough to drive the Connect/Disconnect button state.
    res.json({
      subAccountId: sub.id,
      crmType: sub.crmType,
      connected: encrypted,
      callbackUri: (() => {
        try {
          return publicBaseUrl();
        } catch {
          return null;
        }
      })(),
      providers: SUPPORTED_OAUTH_PROVIDERS.map((p) => ({
        provider: p,
        configured: isProviderConfigured(p),
      })),
    });
  },
);

router.get(
  "/sub-accounts/:id/crm/oauth/:provider/start",
  requireAuth,
  requireSubAccountAccess,
  (req, res) => {
    const sub = res.locals.subAccount as SubAccount;
    const providerRaw = String(req.params.provider ?? "");
    if (!isOauthProvider(providerRaw)) {
      res.status(400).json({ error: "unsupported_provider" });
      return;
    }
    if (!isProviderConfigured(providerRaw)) {
      res.status(503).json({
        error: "provider_not_configured",
        message: `OAuth client credentials for ${providerRaw} are not configured on the server.`,
      });
      return;
    }
    let url: string;
    try {
      const state = signState({
        subAccountId: sub.id,
        userId: req.currentUser!.id,
        provider: providerRaw,
      });
      url = authorizationUrl(providerRaw, state);
    } catch (err) {
      logger.error({ err, provider: providerRaw }, "oauth_start_failed");
      res.status(500).json({ error: "oauth_start_failed", message: (err as Error).message });
      return;
    }
    res.json({ authorizationUrl: url, redirectUri: callbackUri(providerRaw) });
  },
);

router.delete(
  "/sub-accounts/:id/crm/credentials",
  requireAuth,
  requireSubAccountAccess,
  async (_req, res) => {
    const sub = res.locals.subAccount as SubAccount;
    const [updated] = await db
      .update(subAccounts)
      .set({ crmCredentials: {}, updatedAt: new Date() })
      .where(eq(subAccounts.id, sub.id))
      .returning();
    res.json({ subAccountId: updated.id, cleared: true });
  },
);

/**
 * Public callback. Authentication is enforced by the signed state token
 * — Clerk session cookies are not required here because the user is
 * arriving back from a third-party redirect and may not have cookies
 * forwarded depending on the browser flow.
 */
router.get("/oauth/crm/:provider/callback", async (req, res) => {
  const providerRaw = String(req.params.provider ?? "");
  if (!isOauthProvider(providerRaw)) {
    res.status(400).send("Unsupported OAuth provider");
    return;
  }
  const provider: CrmOauthProvider = providerRaw;
  const stateRaw = String(req.query.state ?? "");
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const errorParam = typeof req.query.error === "string" ? req.query.error : "";

  const verified = verifyState(stateRaw);
  if (!verified || verified.provider !== provider) {
    res.status(400).send("Invalid or expired OAuth state");
    return;
  }
  // Even if the user denied consent we still want to land them back in
  // the UI with a clear error.
  if (errorParam || !code) {
    const url = postCallbackRedirect(
      "error",
      provider,
      verified.subAccountId,
      errorParam || "missing_code",
    );
    res.redirect(302, url);
    return;
  }

  try {
    const tokens = await exchangeCode(provider, code, { loginUrl: verified.loginUrl });
    const creds = buildStoredCredentials(provider, tokens, { loginUrl: verified.loginUrl });
    const encrypted = encryptJson(creds);
    const [updated] = await db
      .update(subAccounts)
      .set({
        crmType: provider,
        crmCredentials: encrypted,
        updatedAt: new Date(),
      })
      .where(eq(subAccounts.id, verified.subAccountId))
      .returning();
    if (!updated) {
      logger.warn(
        { subAccountId: verified.subAccountId, provider },
        "oauth_callback_sub_account_missing",
      );
      res.redirect(
        302,
        postCallbackRedirect("error", provider, verified.subAccountId, "sub_account_missing"),
      );
      return;
    }
    logger.info(
      {
        subAccountId: verified.subAccountId,
        provider,
        userId: verified.userId,
        hasRefreshToken: Boolean(tokens.refreshToken),
      },
      "crm_oauth_connected",
    );
    res.redirect(302, postCallbackRedirect("ok", provider, verified.subAccountId));
  } catch (err) {
    logger.error(
      { err, provider, subAccountId: verified.subAccountId },
      "oauth_callback_exchange_failed",
    );
    res.redirect(
      302,
      postCallbackRedirect(
        "error",
        provider,
        verified.subAccountId,
        (err as Error).message ?? "exchange_failed",
      ),
    );
  }
});

export default router;
