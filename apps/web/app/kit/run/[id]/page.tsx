import { redirect } from "next/navigation";

/**
 * The kit's run composition is the real run page now (plan revision 3.4, B12): one run page, no copy
 * of its parts; kit runs are public teire-dev runs, which `/runs/[id]` shows to anyone.
 */
export default async function KitRun({ params }: PageProps<"/kit/run/[id]">) {
  const { id } = await params;
  redirect(`/runs/${id}`);
}
