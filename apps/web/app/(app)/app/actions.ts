"use server";

import { cookies } from "next/headers";
import { requestAction } from "@/lib/actions";
import { INSTALLATION_COOKIE } from "@/lib/app-shell";
import { refreshInstallations } from "@/lib/auth";
import { myInstallations } from "@/lib/dashboard";
import { removeRepository, revokeAccess } from "@/lib/revoke";
import { getSession } from "@/lib/session";

export interface ActionState {
  id: string;
  kind: string;
  params: Record<string, unknown>;
  status: string;
  result: string | null;
  links: { label: string; href: string }[];
}

/**
 * A person's action from any page (U1, D121): recorded with its outbox delivery, then followed by the
 * page until the worker says what happened. Never a "Queued" banner: the answer is the result.
 */
export async function act(input: {
  kind: string;
  params: Record<string, unknown>;
  repo?: string;
  installationId?: number;
  key: string;
}): Promise<ActionState | { error: string }> {
  const session = await getSession();
  if (!session) return { error: "Sign in first" };
  const out = await requestAction({
    userId: session.user.id,
    kind: input.kind,
    params: input.params,
    ...(input.repo ? { repo: input.repo } : {}),
    ...(input.installationId ? { installationId: input.installationId } : {}),
    idempotencyKey: input.key,
  });
  if (!out.ok) return { error: out.error };
  const { action } = out;
  return {
    id: action.id,
    kind: action.kind,
    params: action.params,
    status: action.status,
    result: action.result,
    links: action.links,
  };
}

/** The installation switcher (U1): remembers the choice for this browser, only among installations
 * this person's GitHub account can see. */
export async function switchInstallation(id: number) {
  const session = await getSession();
  if (!session) return;
  if (!(await myInstallations(session.user.id)).some((i) => i.id === id)) return;
  (await cookies()).set(INSTALLATION_COOKIE, String(id), {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 365,
  });
}

/** Reads the installations this person's GitHub account can see again (no more signing out and in). */
export async function refreshMyInstallations(): Promise<{ count: number } | { error: string }> {
  const session = await getSession();
  if (!session) return { error: "Sign in first" };
  await refreshInstallations(session.user.id);
  return { count: (await myInstallations(session.user.id)).length };
}

/** Teire out of one repository, with the person's own GitHub access (Settings, repository page). */
export async function removeRepositoryAccess(
  fullName: string,
): Promise<{ ok: true } | { error: string; manage?: string }> {
  const session = await getSession();
  if (!session) return { error: "Sign in first" };
  return removeRepository(session.user.id, fullName);
}

/** Ends Teire's GitHub authorization for this person and signs them out everywhere (Settings → Account). */
export async function revokeMyGitHubAccess(): Promise<{ ok: true } | { error: string }> {
  const session = await getSession();
  if (!session) return { error: "Sign in first" };
  await revokeAccess(session.user.id);
  return { ok: true };
}
