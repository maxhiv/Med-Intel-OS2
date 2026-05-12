import type { RequestHandler } from "express";
import { withRLS } from "@workspace/db";

/**
 * Wrap each authenticated, account-scoped request in a Postgres transaction
 * with `SET LOCAL app.account_id = <caller account>`, so RLS policies on
 * tenant tables enforce isolation as a hard database guarantee — not just an
 * application-filter promise.
 *
 * Skipped when:
 *  - no `currentAccount` is loaded (unauthenticated / pre-auth routes), or
 *  - the caller is a platform admin (admin endpoints legitimately query
 *    across tenants; engaging RLS here would hide other accounts' data).
 */
export const rlsTransactionMiddleware: RequestHandler = (req, res, next) => {
  if (!req.currentAccount || req.isPlatformAdmin) {
    return next();
  }
  const accountId = req.currentAccount.id;

  // Bridge Express's callback-style middleware to `withRLS`'s async scope:
  // we resolve the inner promise only after the response has finished, so
  // BEGIN/COMMIT bracket the entire request lifecycle.
  let resolveDone!: () => void;
  let rejectDone!: (err: unknown) => void;
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  let settled = false;
  const finish = (err?: unknown) => {
    if (settled) return;
    settled = true;
    if (err) rejectDone(err);
    // Rollback if the response indicates a server error; otherwise commit.
    else if (res.statusCode >= 500) rejectDone(new Error("rls_rollback_5xx"));
    else resolveDone();
  };

  res.on("finish", () => finish());
  res.on("close", () => finish());

  withRLS(accountId, () => {
    // Hand control to the next middleware/route inside the RLS async scope.
    next();
    return done;
  }).catch((err) => {
    // Swallow the synthetic 5xx-rollback marker — response is already sent.
    if ((err as Error)?.message === "rls_rollback_5xx") return;
    if (!res.headersSent) {
      next(err);
    }
  });
};
