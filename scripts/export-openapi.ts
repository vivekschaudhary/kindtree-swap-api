// Writes the public OpenAPI document to openapi/openapi.json. Test-only routes are excluded (production mode).
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/http/app.ts";
import { createLogger } from "../src/logging/logger.ts";
import { registerDocs } from "../src/http/docs.ts";
import { registerRoutes } from "../src/routes/index.ts";
import { OPENAPI_DOC } from "../src/http/openapi-config.ts";
import { gridAreaLabeler } from "../src/adapters/area-labeler.ts";

const app = createApp({ logger: createLogger("silent"), env: "production" });
// The spec doesn't call the database or auth, so inert stand-ins are enough here.
registerRoutes(app, {
  env: "production",
  health: { pingDatabase: async () => true, pingObjectStore: async () => true },
  identity: { db: null as never, auth: { api: { getSession: async () => null } } as never, labeler: gridAreaLabeler },
});
registerDocs(app);

const doc = app.getOpenAPI31Document(OPENAPI_DOC);
const out = fileURLToPath(new URL("../openapi/openapi.json", import.meta.url));
writeFileSync(out, JSON.stringify(doc, null, 2) + "\n");
console.log(`wrote ${out}`);
