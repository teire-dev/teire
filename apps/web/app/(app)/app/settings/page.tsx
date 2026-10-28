import { redirect } from "next/navigation";

/** Settings open on the organisation's defaults; each section has its own URL (plan revision 3.3, U3). */
export default function SettingsIndex() {
  redirect("/app/settings/organization");
}
