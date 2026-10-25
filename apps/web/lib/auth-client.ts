import { createAuthClient } from "better-auth/react";

/** Browser side of sign-in; same origin as the API routes. */
export const authClient = createAuthClient();
