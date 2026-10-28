import { redirect } from "next/navigation";

/** A repository opens on its findings; every tab has its own URL (plan revision 3.3, U3). */
export default async function RepoIndex({ params, searchParams }: PageProps<"/app/repos/[owner]/[repo]">) {
  const [{ owner, repo }, query] = await Promise.all([params, searchParams]);
  const group = typeof query.group === "string" ? `?group=${encodeURIComponent(query.group)}` : "";
  redirect(`/app/repos/${owner}/${repo}/findings${group}`);
}
