import { headers } from "next/headers";
import { cache } from "react";
import { auth } from "./auth";

/** The signed-in person for this request, read once however many components ask. */
export const getSession = cache(async () => auth().api.getSession({ headers: await headers() }));
