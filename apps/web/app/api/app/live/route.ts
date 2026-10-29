import { currentInstallation, liveRepos } from "@/lib/app-shell";
import { getSession } from "@/lib/session";

/**
 * What Teire is working on now in the chosen installation (U1): the sidebar's live dots, read every
 * few seconds while something is live, rarely while nothing is (plan "Live islands"). One query.
 */
export async function GET() {
  const session = await getSession();
  if (!session) return Response.json({ live: [] }, { status: 401 });
  const { current } = await currentInstallation(session.user.id);
  return Response.json(
    { live: current ? await liveRepos(current.id, session.user.id) : [] },
    { headers: { "cache-control": "no-store" } },
  );
}
