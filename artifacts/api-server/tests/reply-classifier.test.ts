/**
 * Regression test for the reply-classifier batch (task #26).
 *
 * `reply_events` stores opens, bounces, task-complete events, and webhook
 * errors alongside actual replies, all initially with `aiClassification` =
 * NULL. The classifier must filter to reply-shaped events in SQL so a flood
 * of non-reply traffic can never starve real replies out of the per-tick
 * processing window.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

vi.mock("../src/lib/anthropic", () => ({
  ai: {
    messages: {
      create: vi.fn(async () => ({
        content: [
          { type: "text", text: '{"classification": "interested"}' },
        ],
      })),
    },
  },
  ANTHROPIC_MODEL: "test-model",
  ANTHROPIC_MAX_TOKENS: 64,
}));

import { eq, inArray } from "drizzle-orm";
import { db, replyEvents } from "@workspace/db";
import { classifyPendingReplies } from "../src/services/replyClassifier";
import { seedWorld, teardownWorld, type SeededWorld } from "./helpers/seed";

let world: SeededWorld;
const insertedIds: string[] = [];

beforeAll(async () => {
  world = await seedWorld();
});

afterAll(async () => {
  if (insertedIds.length > 0) {
    await db.delete(replyEvents).where(inArray(replyEvents.id, insertedIds));
  }
  if (world) await teardownWorld(world);
});

describe("classifyPendingReplies", () => {
  it("classifies the reply even when many newer non-reply events are pending", async () => {
    // seedWorld() creates one `reply_received` event per seeded tenant for
    // unrelated test coverage. classifyPendingReplies scans every account's
    // reply-shaped events, so those baseline rows would otherwise inflate
    // `result.examined`. Clear them up front so the assertions below only
    // count this test's inserts.
    await db.delete(replyEvents).where(eq(replyEvents.eventType, "reply_received"));

    // 50 newer non-reply rows (opens/bounces/task-completes/errors) all with
    // null classification. A naive "ORDER BY received_at DESC LIMIT N" query
    // would never reach the older reply row.
    const noisyTypes = [
      "email.opened",
      "email.bounced",
      "task.completed",
      "webhook_error",
      "contact.updated",
    ];
    const olderReplyTime = new Date(Date.now() - 60 * 60 * 1000);

    const replyRow = await db
      .insert(replyEvents)
      .values({
        accountId: world.tenantA.accountId,
        draftId: world.tenantA.draftId,
        crmType: "ghl",
        crmContactId: "crm-contact-1",
        eventType: "InboundMessage",
        rawPayload: { body: "Yes please, send me more info." },
        receivedAt: olderReplyTime,
      })
      .returning({ id: replyEvents.id });
    insertedIds.push(replyRow[0].id);

    for (let i = 0; i < 50; i += 1) {
      const r = await db
        .insert(replyEvents)
        .values({
          accountId: world.tenantA.accountId,
          draftId: world.tenantA.draftId,
          crmType: "ghl",
          crmContactId: "crm-contact-1",
          eventType: noisyTypes[i % noisyTypes.length],
          rawPayload: { noise: i },
        })
        .returning({ id: replyEvents.id });
      insertedIds.push(r[0].id);
    }

    const result = await classifyPendingReplies(10);

    expect(result.examined).toBe(1);
    expect(result.classified).toBe(1);

    const [updated] = await db
      .select({ cls: replyEvents.aiClassification })
      .from(replyEvents)
      .where(eq(replyEvents.id, replyRow[0].id));
    expect(updated.cls).toBe("interested");

    // The non-reply rows must remain untouched (still null) so other
    // pipelines (e.g. open/bounce processing) can read them later.
    const noiseRows = await db
      .select({ cls: replyEvents.aiClassification })
      .from(replyEvents)
      .where(
        inArray(
          replyEvents.id,
          insertedIds.filter((id) => id !== replyRow[0].id),
        ),
      );
    expect(noiseRows.every((r) => r.cls === null)).toBe(true);
  });
});
