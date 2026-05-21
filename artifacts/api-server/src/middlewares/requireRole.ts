/**
 * requireRole — role-based access control middleware.
 *
 * Adapted from the handoff's requireRole.js. The handoff assumes a clean
 * rep/tenant_admin/operator vocabulary; this repo's v1.0 `users.role` is
 * free text and currently only ever holds "platform_admin" or "rep"
 * (see middlewares/auth.ts). So the hierarchy maps BOTH vocabularies:
 *
 *   rep            → 0
 *   tenant_admin   → 1
 *   operator       → 2
 *   platform_admin → 2   (v1.0 super-role; satisfies operator + tenant_admin)
 *
 * A higher level satisfies every lower requirement.
 */
import type { Request, Response, NextFunction, RequestHandler } from "express";

export type AppRole = "rep" | "tenant_admin" | "operator";

const ROLE_LEVEL: Record<string, number> = {
  rep: 0,
  tenant_admin: 1,
  operator: 2,
  platform_admin: 2,
};

export function requireRole(...allowedRoles: AppRole[]): RequestHandler {
  if (allowedRoles.length === 0) {
    throw new Error("requireRole requires at least one role");
  }
  const minLevel = Math.min(...allowedRoles.map((r) => ROLE_LEVEL[r]));

  return (req: Request, res: Response, next: NextFunction) => {
    const user = req.currentUser;
    if (!user) {
      res.status(401).json({ error: "unauthenticated" });
      return;
    }
    const level = ROLE_LEVEL[user.role];
    if (level === undefined) {
      res.status(403).json({ error: "invalid_role", role: user.role });
      return;
    }
    if (level < minLevel) {
      res.status(403).json({
        error: "insufficient_role",
        required: allowedRoles,
        current: user.role,
      });
      return;
    }
    next();
  };
}

/** A tenant_admin endpoint — also reachable by operator / platform_admin. */
export const requireTenantAdmin = (): RequestHandler =>
  requireRole("tenant_admin", "operator");

/** An operator-only endpoint — also reachable by platform_admin. */
export const requireOperator = (): RequestHandler => requireRole("operator");

/** Programmatic check for use inside services / route bodies. */
export function hasRole(
  user: { role: string } | null | undefined,
  ...allowedRoles: AppRole[]
): boolean {
  if (!user) return false;
  const level = ROLE_LEVEL[user.role];
  if (level === undefined) return false;
  const minLevel = Math.min(...allowedRoles.map((r) => ROLE_LEVEL[r] ?? Infinity));
  return level >= minLevel;
}
