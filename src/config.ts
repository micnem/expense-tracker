import { z } from "zod";
import type { AppConfig } from "./types.js";

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  WEBHOOK_SHARED_SECRET: z.string().min(1),
  GEMINI_API_KEY: z.string().min(1),
  GEMINI_MODEL: z.string().default("gemini-2.5-flash"),
  DEFAULT_CURRENCY: z.string().min(1).transform((value) => value.trim().toUpperCase()),
  MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.7),
  APP_REVISION: z.string().optional(),
  RENDER_GIT_COMMIT: z.string().optional(),
  GIT_COMMIT: z.string().optional(),
  COMMIT_SHA: z.string().optional()
});

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const env = envSchema.parse(environment);
  const revision =
    env.APP_REVISION ??
    env.RENDER_GIT_COMMIT ??
    env.GIT_COMMIT ??
    env.COMMIT_SHA ??
    "unknown";

  return {
    port: env.PORT,
    webhookSharedSecret: env.WEBHOOK_SHARED_SECRET,
    geminiApiKey: env.GEMINI_API_KEY,
    geminiModel: env.GEMINI_MODEL,
    defaultCurrency: env.DEFAULT_CURRENCY,
    minConfidence: env.MIN_CONFIDENCE,
    revision
  };
}
