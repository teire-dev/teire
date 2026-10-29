import { StatePage } from "@/components/state-page";

/** A missing page inside the site keeps the site's header and footer around it. */
export default function SiteNotFound() {
  return <StatePage kind="not-found" inset />;
}
