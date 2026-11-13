import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_ROLE: z.enum(["api", "worker"]).default("api"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  DATABASE_URL: z.string().min(1),
  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().default("auto"),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_BUCKET_PUBLIC: z.string().min(1),
  S3_BUCKET_PRIVATE: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().url(),
  PASSKEY_RP_ID: z.string().min(1),
  PASSKEY_ORIGINS: z
    .string()
    .min(1)
    .transform((v) => v.split(",").map((o) => o.trim()).filter(Boolean)),
  SMTP_URL: z.string().min(1),
  MAIL_FROM: z.string().default("Kindtree <no-reply@kindtree.us>"),
  GOOGLE_CLIENT_ID_WEB: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_MAPS_API_KEY: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

/** Parses process.env once at startup. Fails fast with every missing or invalid variable listed. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment: ${details}`);
  }
  return parsed.data;
}
