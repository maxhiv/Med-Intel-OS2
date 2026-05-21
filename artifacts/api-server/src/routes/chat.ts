/**
 * Chat routes — the v2.0 ProspectingAgent surface.
 *
 * Mounted after rlsTransactionMiddleware, so every handler runs inside the
 * request's RLS scope (account-isolated `db`). The message endpoint streams
 * the agent's progress as Server-Sent Events; it's request-scoped (runs the
 * agent, then closes) so a per-request transaction is fine — unlike the
 * forever-open /stream/signals poller.
 */
import { Router, type IRouter } from "express";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod/v4";
import {
  db,
  chatSessions,
  chatMessages,
  chatSessionProspects,
  opportunities,
} from "@workspace/db";
import { requireAccount } from "../middlewares/auth";
import { logger } from "../lib/logger";
import { ProspectingAgent } from "../services/agent/prospectingAgent";

const router: IRouter = Router();

// ─── POST /chat/sessions — start a new session ──────────────────────────────
const createBody = z.object({ title: z.string().max(200).optional() });

router.post("/chat/sessions", requireAccount, async (req, res) => {
  const parsed = createBody.safeParse(req.body ?? {});
  const [row] = await db
    .insert(chatSessions)
    .values({
      accountId: req.currentAccount!.id,
      userId: req.currentUser!.id,
      title: parsed.success ? (parsed.data.title ?? null) : null,
    })
    .returning({ id: chatSessions.id, createdAt: chatSessions.createdAt });
  res.status(201).json({ sessionId: row.id, createdAt: row.createdAt });
});

// ─── GET /chat/sessions — list the rep's sessions ───────────────────────────
router.get("/chat/sessions", requireAccount, async (req, res) => {
  const rows = await db
    .select({
      id: chatSessions.id,
      title: chatSessions.title,
      status: chatSessions.status,
      createdAt: chatSessions.createdAt,
      lastMessageAt: chatSessions.lastMessageAt,
      totalCostUsd: chatSessions.totalCostUsd,
    })
    .from(chatSessions)
    .where(
      and(
        eq(chatSessions.accountId, req.currentAccount!.id),
        eq(chatSessions.userId, req.currentUser!.id),
      ),
    )
    .orderBy(desc(chatSessions.lastMessageAt))
    .limit(100);
  res.json({ sessions: rows });
});

// ─── GET /chat/sessions/:id — session detail + message history ──────────────
router.get("/chat/sessions/:id", requireAccount, async (req, res) => {
  const id = String(req.params.id);
  const [session] = await db
    .select()
    .from(chatSessions)
    .where(
      and(eq(chatSessions.id, id), eq(chatSessions.accountId, req.currentAccount!.id)),
    )
    .limit(1);
  if (!session) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const messages = await db
    .select({
      id: chatMessages.id,
      role: chatMessages.role,
      content: chatMessages.content,
      createdAt: chatMessages.createdAt,
    })
    .from(chatMessages)
    .where(eq(chatMessages.sessionId, id))
    .orderBy(chatMessages.createdAt);
  res.json({ session, messages });
});

// ─── DELETE /chat/sessions/:id — archive ────────────────────────────────────
router.delete("/chat/sessions/:id", requireAccount, async (req, res) => {
  const id = String(req.params.id);
  const updated = await db
    .update(chatSessions)
    .set({ status: "archived" })
    .where(
      and(eq(chatSessions.id, id), eq(chatSessions.accountId, req.currentAccount!.id)),
    )
    .returning({ id: chatSessions.id });
  if (updated.length === 0) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ ok: true, archived: id });
});

// ─── GET /chat/sessions/:id/prospects — opportunities surfaced here ─────────
router.get("/chat/sessions/:id/prospects", requireAccount, async (req, res) => {
  const id = String(req.params.id);
  const [session] = await db
    .select({ id: chatSessions.id })
    .from(chatSessions)
    .where(
      and(eq(chatSessions.id, id), eq(chatSessions.accountId, req.currentAccount!.id)),
    )
    .limit(1);
  if (!session) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const links = await db
    .select({ opportunityId: chatSessionProspects.opportunityId })
    .from(chatSessionProspects)
    .where(eq(chatSessionProspects.sessionId, id));
  const ids = links.map((l) => l.opportunityId);
  const opps = ids.length
    ? await db.select().from(opportunities).where(inArray(opportunities.id, ids))
    : [];
  res.json({ prospects: opps });
});

// ─── POST /chat/sessions/:id/messages — run the agent, stream SSE ───────────
const messageBody = z.object({ message: z.string().min(1).max(8000) });

router.post("/chat/sessions/:id/messages", requireAccount, async (req, res) => {
  const sessionId = String(req.params.id);
  const accountId = req.currentAccount!.id;
  const userId = req.currentUser!.id;

  const parsed = messageBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", detail: parsed.error.issues });
    return;
  }

  const [session] = await db
    .select({ id: chatSessions.id })
    .from(chatSessions)
    .where(and(eq(chatSessions.id, sessionId), eq(chatSessions.accountId, accountId)))
    .limit(1);
  if (!session) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  // SSE preamble.
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const agent = new ProspectingAgent({ accountId, userId, sessionId });
  try {
    const result = await agent.sendMessage(parsed.data.message, {
      onToken: (text) => send("token", { text }),
      onToolCall: (e) => send("tool_call", e),
      onToolResult: (e) => send("tool_result", e),
      onProspect: (e) => send("prospect", e),
      onSubAgent: (e) => send("sub_agent", e),
      onUsage: (e) => send("usage", e),
      onError: (err) =>
        send("error", { message: err.message, code: (err as { code?: string }).code }),
    });
    send("done", result);
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    logger.warn({ err: e.message, sessionId }, "chat: agent turn failed");
    // onError already streamed the detail; emit a terminal event.
    send("done", { stopReason: "error", error: e.message });
  } finally {
    res.end();
  }
});

export default router;
