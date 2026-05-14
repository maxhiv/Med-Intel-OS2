import type { Request, Response, NextFunction, RequestHandler } from "express";
import { getAuth, clerkClient } from "@clerk/express";
import { eq } from "drizzle-orm";
import { db, users, accounts, subAccounts, type User, type Account } from "@workspace/db";

declare global {
  namespace Express {
    interface Request {
      currentUser?: User;
      currentAccount?: Account;
      isPlatformAdmin?: boolean;
    }
  }
}

const PLATFORM_ADMIN_EMAIL =
  process.env.PLATFORM_ADMIN_EMAIL || "max@hansenholdingsllc.com";

async function loadUserContext(req: Request): Promise<void> {
  const auth = getAuth(req);
  if (!auth?.userId) return;

  const clerkUserId = auth.userId;
  const sessionClaims = auth.sessionClaims as
    | { email?: string; primary_email?: string }
    | undefined;
  let email =
    (sessionClaims?.email || sessionClaims?.primary_email || "").toLowerCase();

  let [user] = await db
    .select()
    .from(users)
    .where(eq(users.clerkUserId, clerkUserId))
    .limit(1);

  // Session claims may not include email (depends on Clerk JWT template).
  // Fall back to Clerk's backend API to get the primary email address so the
  // email-based lookup and JIT provisioning below work correctly.
  if (!user && !email) {
    try {
      const clerkUser = await clerkClient.users.getUser(clerkUserId);
      email =
        clerkUser.emailAddresses.find((e) => e.id === clerkUser.primaryEmailAddressId)
          ?.emailAddress?.toLowerCase() ??
        clerkUser.emailAddresses[0]?.emailAddress?.toLowerCase() ??
        "";
    } catch {
      // Clerk API unavailable — continue without email (will 401 below)
    }
  }

  if (!user && email) {
    const [byEmail] = await db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    if (byEmail) {
      const [updated] = await db
        .update(users)
        .set({ clerkUserId, lastLoginAt: new Date() })
        .where(eq(users.id, byEmail.id))
        .returning();
      user = updated;
    }
  }

  if (!user && email) {
    const role = email === PLATFORM_ADMIN_EMAIL ? "platform_admin" : "rep";
    const [created] = await db
      .insert(users)
      .values({
        email,
        role,
        clerkUserId,
        firstName: null,
        lastName: null,
      })
      .returning();
    user = created;
  }

  if (!user) return;

  req.currentUser = user;
  req.isPlatformAdmin =
    user.role === "platform_admin" || user.email === PLATFORM_ADMIN_EMAIL;

  if (user.accountId) {
    const [acct] = await db
      .select()
      .from(accounts)
      .where(eq(accounts.id, user.accountId))
      .limit(1);
    if (acct) req.currentAccount = acct;
  }

  // Auto-attach platform admin to Hansen Holdings
  if (req.isPlatformAdmin && !req.currentAccount) {
    const [hansen] = await db
      .select()
      .from(accounts)
      .where(eq(accounts.slug, "hansen-holdings"))
      .limit(1);
    if (hansen) {
      await db
        .update(users)
        .set({ accountId: hansen.id })
        .where(eq(users.id, user.id));
      req.currentAccount = hansen;
    }
  }
}

export const userContext: RequestHandler = async (req, _res, next) => {
  try {
    await loadUserContext(req);
    next();
  } catch (err) {
    next(err);
  }
};

export const requireAuth: RequestHandler = (req, res, next) => {
  if (!req.currentUser) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  next();
};

export const requireAccount: RequestHandler = (req, res, next) => {
  if (!req.currentUser) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  if (!req.currentAccount) {
    res.status(403).json({ error: "no_account_assigned" });
    return;
  }
  next();
};

/**
 * Resolves the sub-account on `req.params.id` (or `req.params.subAccountId`)
 * and lets through:
 *   - platform admins
 *   - any authenticated user whose `accountId` matches the sub-account's
 *     parent account (i.e. an account owner / rep self-serving for their
 *     own sub-account)
 *
 * Stashes the loaded row on `res.locals.subAccount` so route handlers
 * don't have to re-query.
 */
export const requireSubAccountAccess: RequestHandler = async (req, res, next) => {
  try {
    if (!req.currentUser) {
      res.status(401).json({ error: "unauthenticated" });
      return;
    }
    const id = String(req.params.id ?? req.params.subAccountId ?? "");
    if (!id) {
      res.status(400).json({ error: "sub_account_id_required" });
      return;
    }
    const [sub] = await db
      .select()
      .from(subAccounts)
      .where(eq(subAccounts.id, id))
      .limit(1);
    if (!sub) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const isOwner =
      req.currentAccount?.id != null && req.currentAccount.id === sub.accountId;
    if (!req.isPlatformAdmin && !isOwner) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    res.locals.subAccount = sub;
    next();
  } catch (err) {
    next(err);
  }
};

export const requirePlatformAdmin: RequestHandler = (req, res, next) => {
  if (!req.currentUser) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  if (!req.isPlatformAdmin) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  next();
};
