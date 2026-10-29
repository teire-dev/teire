import { GhostFlow } from "@/components/flow/ghost-flow";

/** Anything outside the site and the app on its way (the docs, the kit): the flow in ghost state. */
export default function RootLoading() {
  return (
    <div
      className="flex min-h-svh flex-1 items-center justify-center bg-canvas"
      role="status"
      aria-label="Loading"
    >
      <GhostFlow />
    </div>
  );
}
