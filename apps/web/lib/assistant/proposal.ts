import { createHmac, timingSafeEqual } from "node:crypto";
import type { ActionKind } from "@teire/engine/actions";

/**
 * A proposed action (D119): Ask Teire may only propose; the person's click acts. The card shows the
 * validated action, and Confirm sends back this token, signed by the server, so the click can only
 * run exactly what the card showed, for the person it was shown to, within an hour.
 */
export interface Proposal {
  v: 1;
  /** Who it was proposed to: only they can confirm it. */
  uid: string;
  kind: ActionKind;
  repo: string | null;
  installationId: number | null;
  params: Record<string, unknown>;
  /** The card's words, exactly. */
  effect: string;
  exp: number;
}

const TTL_MS = 3_600_000;

function key() {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error("BETTER_AUTH_SECRET is not set");
  // A key of its own for proposals, derived so a session secret is never used twice for one purpose.
  return createHmac("sha256", secret).update("teire:assistant-proposal:v1").digest();
}

const b64 = (s: string) => Buffer.from(s).toString("base64url");

export function signProposal(p: Omit<Proposal, "v" | "exp">): { token: string; id: string } {
  const body = b64(JSON.stringify({ ...p, v: 1, exp: Date.now() + TTL_MS } satisfies Proposal));
  const mac = createHmac("sha256", key()).update(body).digest("base64url");
  return { token: `${body}.${mac}`, id: mac.slice(0, 24) };
}

/** The proposal, when the token is genuine, unexpired and was proposed to this person; else why not. */
export function openProposal(
  token: string,
  userId: string,
): { proposal: Proposal; id: string } | { error: string } {
  const [body = "", mac = ""] = token.split(".");
  const want = createHmac("sha256", key()).update(body).digest("base64url");
  if (!body || mac.length !== want.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(want)))
    return { error: "That proposal isn't one Teire made" };
  let proposal: Proposal;
  try {
    proposal = JSON.parse(Buffer.from(body, "base64url").toString()) as Proposal;
  } catch {
    return { error: "That proposal isn't one Teire made" };
  }
  if (proposal.v !== 1 || proposal.uid !== userId)
    return { error: "That proposal was made for someone else" };
  if (proposal.exp < Date.now()) return { error: "That proposal expired; ask again" };
  return { proposal, id: mac.slice(0, 24) };
}
