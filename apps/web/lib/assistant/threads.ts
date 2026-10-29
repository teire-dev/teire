import { and, asc, assistantMessages, assistantThreads, desc, eq, gte, sql } from "@teire/db";
import { database } from "../db";
import type { AssistantContext, AssistantMessage } from "./message";

/**
 * Ask Teire's threads (plan revision 3.3, U4): one person's conversations, each message stored as its
 * UI parts so a reloaded thread renders exactly as it streamed. A thread belongs to the person who
 * started it; anyone else gets nothing back, as if it didn't exist. The operator walk's threads are
 * kept under "operator" and age out with the rest (90 days).
 */
export const ownerOf = (userId: string | null) => userId ?? "operator";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isThreadId = (id: unknown): id is string => typeof id === "string" && UUID.test(id);
export const isMessageId = (id: unknown): id is string => typeof id === "string" && /^[\w-]{6,80}$/.test(id);

export async function threadOf(owner: string, id: string) {
  const [row] = await database()
    .select()
    .from(assistantThreads)
    .where(and(eq(assistantThreads.id, id), eq(assistantThreads.userId, owner)))
    .limit(1);
  return row ?? null;
}

/** The thread, created on its first message; null when the id belongs to someone else. */
export async function openThread(input: {
  owner: string;
  id: string;
  installationId: number | null;
  context: AssistantContext | null;
  firstText: string;
}) {
  const db = database();
  await db
    .insert(assistantThreads)
    .values({
      id: input.id,
      userId: input.owner,
      installationId: input.installationId,
      title: input.firstText.replace(/\s+/g, " ").trim().slice(0, 80) || "New thread",
      context: input.context,
    })
    .onConflictDoNothing({ target: assistantThreads.id });
  return threadOf(input.owner, input.id);
}

export async function messagesOf(threadId: string): Promise<AssistantMessage[]> {
  const rows = await database()
    .select()
    .from(assistantMessages)
    .where(eq(assistantMessages.threadId, threadId))
    .orderBy(asc(assistantMessages.createdAt), asc(assistantMessages.id));
  return rows.map((r) => ({
    id: r.id,
    role: r.role,
    parts: r.parts as AssistantMessage["parts"],
    metadata: {
      ...((r.metadata as AssistantMessage["metadata"]) ?? {}),
      ...(r.status === "interrupted" ? { interrupted: true } : {}),
      ...(r.rating === 1 || r.rating === -1 ? { rating: r.rating } : {}),
    },
  }));
}

/** Stores (or replaces) one message of a thread; a message id from another thread is refused. */
export async function saveMessage(threadId: string, message: AssistantMessage, interrupted = false) {
  const db = database();
  await db
    .insert(assistantMessages)
    .values({
      id: message.id,
      threadId,
      role: message.role === "user" ? "user" : "assistant",
      parts: message.parts,
      metadata: message.metadata ?? null,
      status: interrupted ? "interrupted" : "complete",
    })
    .onConflictDoUpdate({
      target: assistantMessages.id,
      set: {
        parts: message.parts,
        metadata: message.metadata ?? null,
        status: interrupted ? "interrupted" : "complete",
      },
      setWhere: eq(assistantMessages.threadId, threadId),
    });
  await db.update(assistantThreads).set({ updatedAt: new Date() }).where(eq(assistantThreads.id, threadId));
}

/** Regenerate: the reply asked again and everything after it go; the question stays. */
export async function dropFrom(threadId: string, messageId: string) {
  const db = database();
  const [from] = await db
    .select({ at: assistantMessages.createdAt })
    .from(assistantMessages)
    .where(and(eq(assistantMessages.threadId, threadId), eq(assistantMessages.id, messageId)))
    .limit(1);
  if (!from) return;
  await db
    .delete(assistantMessages)
    .where(
      and(
        eq(assistantMessages.threadId, threadId),
        gte(assistantMessages.createdAt, from.at),
        sql`${assistantMessages.role} = 'assistant'`,
      ),
    );
}

/** The person's threads, newest first; a search matches the title or any message's text. */
export async function threadsOf(owner: string, q = "") {
  const like = `%${q.replace(/[%_\\]/g, "").slice(0, 80)}%`;
  return database()
    .select({
      id: assistantThreads.id,
      title: assistantThreads.title,
      context: assistantThreads.context,
      updatedAt: assistantThreads.updatedAt,
    })
    .from(assistantThreads)
    .where(
      and(
        eq(assistantThreads.userId, owner),
        q
          ? sql`(${assistantThreads.title} ilike ${like} or exists (select 1 from assistant_messages m where m.thread_id = ${assistantThreads.id} and m.parts::text ilike ${like}))`
          : sql`true`,
      ),
    )
    .orderBy(desc(assistantThreads.updatedAt))
    .limit(50);
}

export async function renameThread(owner: string, id: string, title: string) {
  const [row] = await database()
    .update(assistantThreads)
    .set({ title: title.replace(/\s+/g, " ").trim().slice(0, 80) || "New thread" })
    .where(and(eq(assistantThreads.id, id), eq(assistantThreads.userId, owner)))
    .returning({ id: assistantThreads.id });
  return !!row;
}

/** A person deletes their own thread and its messages (they go with it). */
export async function deleteThread(owner: string, id: string) {
  const [row] = await database()
    .delete(assistantThreads)
    .where(and(eq(assistantThreads.id, id), eq(assistantThreads.userId, owner)))
    .returning({ id: assistantThreads.id });
  return !!row;
}

export async function rateMessage(owner: string, messageId: string, rating: 1 | -1 | null) {
  const [row] = await database()
    .update(assistantMessages)
    .set({ rating })
    .where(
      and(
        eq(assistantMessages.id, messageId),
        sql`exists (select 1 from assistant_threads t where t.id = ${assistantMessages.threadId} and t.user_id = ${owner})`,
      ),
    )
    .returning({ id: assistantMessages.id });
  return !!row;
}
