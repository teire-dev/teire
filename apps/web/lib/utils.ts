export { cn } from "cn";

/** The verification backend's name as people know it (a run's `backend` is its id). */
export function backendName(id: string | null | undefined) {
  if (!id) return "—";
  return (
    (
      { tokenfactory: "Token Factory Sandboxes", cloudflare: "Cloudflare Containers" } as Record<
        string,
        string
      >
    )[id] ?? id
  );
}
