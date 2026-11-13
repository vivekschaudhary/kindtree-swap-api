import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type pg from "pg";
import type { Auth } from "../auth/auth.js";
import { DomainError } from "../errors/domain-error.js";
import { requireUser, type SessionUser } from "../http/session.js";
import { COMMON_ERRORS, problemResponse } from "../http/schemas.js";
import type { AppEnv } from "../http/app.js";

import type { AreaLabeler } from "../adapters/area-labeler.js";

export type IdentityDeps = { db: pg.Pool; auth: Pick<Auth, "api">; labeler: AreaLabeler };

const Location = z.object({ area_label: z.string(), search_radius_km: z.number().int() });

const Me = z.object({
  id: z.string(),
  email: z.string(),
  display_name: z.string().nullable(),
  bio: z.string().nullable(),
  avatar_url: z.string().nullable(),
  area_label: z.string().nullable(),
  member_since: z.string(),
  completed_swaps_count: z.number().int(),
  onboarded: z.boolean(),
  location: Location.nullable(),
  category_ids: z.array(z.string()),
  has_passkey: z.boolean(),
});

const ProfilePublic = z.object({
  id: z.string(),
  display_name: z.string().nullable(),
  bio: z.string().nullable(),
  avatar_url: z.string().nullable(),
  area_label: z.string().nullable(),
  member_since: z.string(),
  completed_swaps_count: z.number().int(),
});

const AUTH_REQUIRED = { 401: problemResponse("Authentication required") } as const;

const getMeRoute = createRoute({
  method: "get",
  path: "/v1/me",
  operationId: "getMe",
  tags: ["Profile"],
  summary: "Current user",
  description: "Returns the signed-in user. Creates the profile on first call. Coordinates are never returned.",
  responses: { 200: { description: "The current user", content: { "application/json": { schema: Me } } }, ...AUTH_REQUIRED, ...COMMON_ERRORS },
});

const updateMeRoute = createRoute({
  method: "patch",
  path: "/v1/me",
  operationId: "updateMe",
  tags: ["Profile"],
  summary: "Update display name or bio",
  description: "Updates the display name and bio. Onboarding completes once a display name and a location both exist.",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            display_name: z.string().min(1).max(50).optional(),
            bio: z.string().max(500).optional(),
          }),
        },
      },
    },
  },
  responses: { 200: { description: "Updated user", content: { "application/json": { schema: Me } } }, ...AUTH_REQUIRED, ...COMMON_ERRORS },
});

const putLocationRoute = createRoute({
  method: "put",
  path: "/v1/me/location",
  operationId: "putMyLocation",
  tags: ["Profile"],
  summary: "Set location",
  description:
    "Stores the point rounded to about 100 m. Only the coarse area label and the search radius are ever returned.",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            lat: z.number().min(-90).max(90),
            lng: z.number().min(-180).max(180),
            search_radius_km: z.number().int().min(1).max(200).optional(),
          }),
        },
      },
    },
  },
  responses: { 200: { description: "Updated user", content: { "application/json": { schema: Me } } }, ...AUTH_REQUIRED, ...COMMON_ERRORS },
});

const getUserRoute = createRoute({
  method: "get",
  path: "/v1/users/{id}",
  operationId: "getUserProfile",
  tags: ["Profile"],
  summary: "Public profile",
  description: "Returns 404 when either user has blocked the other.",
  request: { params: z.object({ id: z.string().min(1) }) },
  responses: {
    200: { description: "Public profile", content: { "application/json": { schema: ProfilePublic } } },
    ...AUTH_REQUIRED,
    ...COMMON_ERRORS,
  },
});

const blockRoute = createRoute({
  method: "post",
  path: "/v1/blocks",
  operationId: "createBlock",
  tags: ["Safety"],
  summary: "Block a user",
  description: "Blocks another user. Blocks hide each user from the other in profiles, feeds and swaps.",
  request: {
    body: { required: true, content: { "application/json": { schema: z.object({ user_id: z.string().min(1) }) } } },
  },
  responses: { 204: { description: "Blocked" }, ...AUTH_REQUIRED, ...COMMON_ERRORS },
});

const unblockRoute = createRoute({
  method: "delete",
  path: "/v1/blocks/{user_id}",
  operationId: "deleteBlock",
  tags: ["Safety"],
  summary: "Unblock a user",
  description: "Removes a block you created.",
  request: { params: z.object({ user_id: z.string().min(1) }) },
  responses: { 204: { description: "Unblocked" }, ...AUTH_REQUIRED, ...COMMON_ERRORS },
});

type MeRow = {
  id: string;
  email: string;
  created_at: Date;
  display_name: string | null;
  bio: string | null;
  onboarded_at: Date | null;
  area_label: string | null;
  search_radius_km: number | null;
  has_passkey: boolean;
};

/** Reads the profile view for one user. Creates the profile row on first call (no triggers, §1). */
async function loadMe(db: pg.Pool, user: SessionUser): Promise<MeRow> {
  await db.query("insert into profiles (user_id) values ($1) on conflict (user_id) do nothing", [user.id]);
  const { rows } = await db.query<MeRow>(
    `select u.id, u."email", u."createdAt" as created_at,
            p.display_name, p.bio, p.onboarded_at,
            l.area_label, l.search_radius_km,
            exists (select 1 from passkey k where k."userId" = u.id) as has_passkey
       from "user" u
       join profiles p on p.user_id = u.id
  left join user_locations l on l.user_id = u.id
      where u.id = $1`,
    [user.id],
  );
  const row = rows[0];
  if (!row) throw new DomainError("NOT_FOUND", "User not found.");
  return row;
}

function toMe(row: MeRow) {
  const location =
    row.area_label !== null && row.search_radius_km !== null
      ? { area_label: row.area_label, search_radius_km: row.search_radius_km }
      : null;
  return {
    id: row.id,
    email: row.email,
    display_name: row.display_name,
    bio: row.bio,
    avatar_url: null,
    area_label: row.area_label,
    member_since: row.created_at.toISOString(),
    completed_swaps_count: 0,
    onboarded: row.onboarded_at !== null,
    location,
    category_ids: [] as string[],
    has_passkey: row.has_passkey,
  };
}

/** Onboarding completes once a display name and a location both exist (§5.2). Set in app code. */
async function markOnboarded(db: pg.Pool, userId: string) {
  await db.query(
    `update profiles set onboarded_at = now(), updated_at = now()
      where user_id = $1 and onboarded_at is null and display_name is not null
        and exists (select 1 from user_locations where user_id = $1)`,
    [userId],
  );
}

export function registerIdentityRoutes(app: OpenAPIHono<AppEnv>, deps: IdentityDeps) {
  const { db, auth, labeler } = deps;

  app.openapi(getMeRoute, async (c) => {
    const user = await requireUser(auth, c);
    return c.json(toMe(await loadMe(db, user)), 200);
  });

  app.openapi(updateMeRoute, async (c) => {
    const user = await requireUser(auth, c);
    const body = c.req.valid("json");
    await loadMe(db, user);
    if (body.display_name !== undefined || body.bio !== undefined) {
      await db.query(
        `update profiles set display_name = coalesce($2, display_name), bio = coalesce($3, bio), updated_at = now()
          where user_id = $1`,
        [user.id, body.display_name ?? null, body.bio ?? null],
      );
    }
    await markOnboarded(db, user.id);
    return c.json(toMe(await loadMe(db, user)), 200);
  });

  app.openapi(putLocationRoute, async (c) => {
    const user = await requireUser(auth, c);
    const body = c.req.valid("json");
    await loadMe(db, user);
    // Round to 3 decimal places (about 111 m) before storing. Exact input is never kept.
    const lat = Math.round(body.lat * 1000) / 1000;
    const lng = Math.round(body.lng * 1000) / 1000;
    await db.query(
      `insert into user_locations (user_id, location, area_label, search_radius_km)
            values ($1, ST_SetSRID(ST_MakePoint($3, $2), 4326)::geography, $4, $5)
       on conflict (user_id) do update
              set location = excluded.location, area_label = excluded.area_label,
                  search_radius_km = excluded.search_radius_km, updated_at = now()`,
      [user.id, lat, lng, await labeler.label(lat, lng), body.search_radius_km ?? 25],
    );
    await markOnboarded(db, user.id);
    return c.json(toMe(await loadMe(db, user)), 200);
  });

  app.openapi(getUserRoute, async (c) => {
    const viewer = await requireUser(auth, c);
    const { id } = c.req.valid("param");
    const { rows } = await db.query<{
      id: string;
      display_name: string | null;
      bio: string | null;
      created_at: Date;
      area_label: string | null;
    }>(
      `select u.id, p.display_name, p.bio, u."createdAt" as created_at, l.area_label
         from "user" u
         join profiles p on p.user_id = u.id
    left join user_locations l on l.user_id = u.id
        where u.id = $1
          and not exists (
            select 1 from blocks b
             where (b.blocker_id = $2 and b.blocked_id = $1) or (b.blocker_id = $1 and b.blocked_id = $2))`,
      [id, viewer.id],
    );
    const row = rows[0];
    if (!row) throw new DomainError("NOT_FOUND", "User not found.");
    return c.json(
      {
        id: row.id,
        display_name: row.display_name,
        bio: row.bio,
        avatar_url: null,
        area_label: row.area_label,
        member_since: row.created_at.toISOString(),
        completed_swaps_count: 0,
      },
      200,
    );
  });

  app.openapi(blockRoute, async (c) => {
    const viewer = await requireUser(auth, c);
    const { user_id } = c.req.valid("json");
    if (user_id === viewer.id) {
      throw new DomainError("VALIDATION_FAILED", "You can't block yourself.", [{ field: "user_id", message: "must be another user" }]);
    }
    await db.query(
      "insert into blocks (blocker_id, blocked_id) values ($1, $2) on conflict do nothing",
      [viewer.id, user_id],
    );
    return c.body(null, 204);
  });

  app.openapi(unblockRoute, async (c) => {
    const viewer = await requireUser(auth, c);
    const { user_id } = c.req.valid("param");
    await db.query("delete from blocks where blocker_id = $1 and blocked_id = $2", [viewer.id, user_id]);
    return c.body(null, 204);
  });
}
