import { headers } from "next/headers";
import { cache } from "react";
import { auth } from "./auth";

/**
 * The signed-in person for this request, read once however many components ask. `headers()` comes
 * first: it marks the work as request-time before `auth()` opens the database, so prerendering
 * (the 404 page's header) never needs one.
 */
export const getSession = cache(async () => {
  const requestHeaders = await headers();
  return auth().api.getSession({ headers: requestHeaders });
});
