import { treaty } from "@elysiajs/eden";
import { env } from "@voice-agent/env/web";
import type { App } from "@voice-agent/server";

export const api = treaty<App>(env.VITE_SERVER_URL);
