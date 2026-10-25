import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

/** Every page outside /docs: the site's own bar and footer. */
export default function SiteLayout({ children }: LayoutProps<"/">) {
  return (
    <>
      <SiteHeader />
      <div className="flex flex-1 flex-col">{children}</div>
      <SiteFooter />
    </>
  );
}
