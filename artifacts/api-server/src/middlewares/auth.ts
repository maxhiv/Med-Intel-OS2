import type { Request, Response, NextFunction, RequestHandler } from "express";
import { getAuth } from "@clerk/express";
import { eq } from "drizzle-orm";
import { db, users, accounts, type User, type Account } from "@workspace/db";

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
  const email =
    (sessionClaims?.email || sessionClaims?.primary_email || "").toLowerCase();

  let [user] = await db
    .select()
    .from(users)
    .where(eq(users.clerkUserId, clerkUserId))
    .limit(1);

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
