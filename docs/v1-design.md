# Kindtree Swap API — v1 Design

**Status:** Draft for review · **Date:** 2026-11-13 · **Owner:** Vivek

Headless API for Kindtree Swap: users list items, discover others' items through a swipe deck, propose one-for-one swaps, chat, meet locally to exchange, and keep a history of completed swaps. Art is the launch category, but nothing in the model is art-specific.

---

## 1. Principles

1. **No vendor lock-in.** Code depends only on open standards: Postgres, S3 API, OIDC/WebAuthn, SMTP, OpenTelemetry, OCI containers. Every vendor sits behind an adapter selected by env config. The whole stack must run offline via `docker-compose`.
2. **The API is the only contract.** Clients never touch the database. Two exceptions: direct-to-storage uploads via presigned URLs, and OAuth redirects.
3. **Privacy by default.** Exact location is never exposed. No addresses are collected in v1.
4. **Every endpoint is documented and observable by construction.** A single route wrapper does auth, validation, error mapping, logging, tracing and OpenAPI registration.
5. **No database functions.** We don't write stored procedures, PL/pgSQL functions, triggers, rules or database-side cron (`pg_cron`). All business logic, validation, timestamps, state transitions and event emission live in application code (TypeScript), where they are versioned, tested, traced and portable. What the database still does:
   - **Allowed:** tables, indexes, constraints (PK, FK, unique, `CHECK`), enums, views if ever needed, and built-in or extension functions called from our queries (`now()`, PostGIS `ST_DWithin`, `pg_notify`, …).
   - **Third-party schemas** (Better Auth, pg-boss) are managed by those libraries and are out of scope for this rule. Any new dependency that installs triggers or functions needs review.
   - **Enforcement:** a CI check fails a migration that contains `CREATE FUNCTION`, `CREATE PROCEDURE`, `CREATE TRIGGER`, `CREATE RULE` or `DO $$` blocks.
6. **Ship v1 small.** Build the schema so deferred features (shipping, payments, reviews, counter-offers, multi-item swaps) don't need breaking migrations.

## 2. Product decisions (locked)

| Topic            | Decision                                                                                                                          |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Category model   | Generic `items` with category-specific `attributes` validated by a JSON Schema on `categories`                                    |
| Right swipe      | Records interest only; client then opens the "pick from your library" composer                                                    |
| Swap shape (v1)  | One-for-one. Schema supports N-for-M.                                                                                             |
| Fulfillment (v1) | `local_pickup` only. `shipping` / `either` are rejected with `FULFILLMENT_NOT_SUPPORTED`.                                         |
| Addresses (v1)   | Not collected. Mutual-consent reveal and platform shipping are designed (§13) but not built.                                      |
| Chat             | Conversation is created with the swap request                                                                                     |
| Pending expiry   | **4 weeks** (`SWAP_PENDING_TTL`, configurable)                                                                                    |
| Offers per item  | No limit. Accepting a swap invalidates other pending swaps that involve the same items.                                           |
| Completion       | Both parties confirm. Ownership transfers by cloning each item into the receiver's library, with `origin_item_id` for provenance. The clone lands as a **draft** (`source = swap_received`) for the new owner to review and list. |
| Item drafts      | Listings save as drafts (partial data allowed) and can be resumed later on any device; full validation happens only at publish (§5.3). |
| Auth             | Passwordless only: Google OAuth + passkeys, with email OTP as recovery                                                            |

## 3. Architecture

```
 iOS / Android / Web
        │  HTTPS (Bearer token or cookie)          presigned PUT
        ▼                                     ┌──────────────────────► R2 (S3 API)
 ┌──────────────────────┐   enqueue / SQL    │                          ▲
 │  api  (Hono, Node)   │────────────────────┼──► Postgres + PostGIS    │ variants
 │  /v1/*  SSE  /docs   │◄── LISTEN/NOTIFY ──┤    (Supabase-hosted)     │
 └──────────────────────┘                    │         ▲                │
 ┌──────────────────────┐   pg-boss jobs     │         │                │
 │ worker (same image)  │────────────────────┘─────────┘── sharp ───────┘
 │ media, outbox, cron  │──► FCM / APNs (Notifier) ──► SMTP (Mailer)
 └──────────────────────┘
        └──► OpenTelemetry exporter (Grafana Cloud)
```

One Docker image runs in two modes, chosen by `APP_ROLE=api|worker`. Both are long-running Node processes; no serverless runtime is assumed.

### 3.1 Components

| Concern          | Standard                     | v1 implementation                                                  | Adapter interface       |
| ---------------- | ---------------------------- | ------------------------------------------------------------------ | ----------------------- |
| HTTP framework   | Web Fetch API                | Hono + `@hono/zod-openapi`                                         | n/a                     |
| Database         | Postgres 16 + PostGIS        | Supabase Pro, via Supavisor (transaction mode)                     | `DATABASE_URL`          |
| ORM / migrations | SQL                          | Drizzle ORM + drizzle-kit                                          | n/a                     |
| Auth             | OIDC, WebAuthn               | Better Auth (Google, passkey, email-OTP plugins); tables in our DB | `AuthService`           |
| Object storage   | S3 API                       | Cloudflare R2; adobe/s3mock locally (S3 API, no account)           | `ObjectStore`           |
| Image processing | n/a                          | `sharp` in the worker                                              | `ImageProcessor`        |
| Jobs / cron      | Postgres                     | pg-boss                                                            | `JobQueue`              |
| Realtime         | SSE + Postgres LISTEN/NOTIFY | built-in                                                           | `EventBus`              |
| Push             | FCM HTTP v1, APNs            | direct                                                             | `Notifier`              |
| Email            | SMTP                         | any relay; Mailpit locally                                         | `Mailer`                |
| Area labels      | `AreaLabeler` interface | Google Geocoding API (reverse lookup) when `GOOGLE_MAPS_API_KEY` is set; grid label otherwise | `AreaLabeler`           |
| Telemetry        | OpenTelemetry, JSON logs     | pino + OTel SDK → Grafana Cloud                                    | env-configured exporter |

### 3.2 Domains

| Host                      | Serves                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `kindtree.us`             | Web app (`kindtree-web`) and the `/.well-known/apple-app-site-association` and `/.well-known/assetlinks.json` files |
| `api.kindtree.us`         | API: `/v1/*`, `/v1/openapi.json`, `/docs`                                                                           |
| `media.kindtree.us`       | R2 public bucket for item images                                                                                    |
| `staging-api.kindtree.us` | Staging API                                                                                                         |

The passkey relying party ID is **`kindtree.us`**, so the same passkey works on web, iOS and Android.

## 4. Conventions

- **Base path:** `/v1`. Breaking changes require `/v2`.
- **IDs:** UUIDv7 (time-ordered), serialized as strings.
- **Timestamps:** `timestamptz` in the database, ISO-8601 UTC in JSON.
- **JSON:** request and response fields are `snake_case`.
- **Auth:** `Authorization: Bearer <token>` (native) or a session cookie on `.kindtree.us` (web). Every endpoint requires auth except `/v1/auth/*`, `/v1/health`, `/v1/openapi.json` and `/docs`.
- **Pagination:** cursor based. `?limit=` (default 20, max 50) and `?cursor=` (opaque). Responses look like `{ "data": [...], "next_cursor": "..." | null }`.
- **Idempotency:** every mutating `POST` accepts an `Idempotency-Key` header. The first response is stored for 24 hours, keyed on (user, key). Reusing a key with a different body returns `409 IDEMPOTENCY_KEY_REUSED`.
- **Concurrency:** swap mutations accept `If-Match: <version>`. A stale version returns `412 VERSION_CONFLICT`.
- **Errors:** RFC 9457 `application/problem+json` (§10).
- **Request ID:** `X-Request-Id` is accepted or generated, echoed on every response, and equal to the OTel trace id.

## 5. Data model

All tables have `created_at timestamptz not null default now()`; mutable tables also have `updated_at`. `updated_at` and `version` are set by the data-access layer (Drizzle `$onUpdate`), not by triggers (Principle 5). FK means a foreign key; on delete restrict unless noted.

### 5.1 Identity (tables owned by Better Auth)

Better Auth manages these tables. Model names are configured so they live in our schema.

| Table           | Key columns                                                                                                    |
| --------------- | -------------------------------------------------------------------------------------------------------------- |
| `users`         | `id`, `email` (unique), `email_verified`, `name`, `image`                                                      |
| `sessions`      | `id`, `user_id` FK, `token`, `expires_at`, `ip_address`, `user_agent`                                          |
| `accounts`      | `id`, `user_id` FK, `provider_id` (`google`), `account_id`, tokens                                             |
| `verifications` | `id`, `identifier`, `value`, `expires_at` (email OTP)                                                          |
| `passkeys`      | `id`, `user_id` FK, `credential_id`, `public_key`, `counter`, `device_type`, `backed_up`, `transports`, `name` |

App code reads identity only through `AuthService`. All app data lives in the tables below and references `users.id`.

### 5.2 Profile and location

**`profiles`** (1:1 with users)
| Column | Type | Notes |
|---|---|---|
| `user_id` | uuid PK, FK users on delete cascade | |
| `display_name` | text, 1–50 | public |
| `bio` | text ≤ 500 | public |
| `avatar_key` | text null | object key in R2 |
| `status` | enum `active`, `suspended`, `deleted` | |
| `onboarded_at` | timestamptz null | set once a location and display name exist |

**`user_locations`** (private; never returned to other users)
| Column | Type | Notes |
|---|---|---|
| `user_id` | uuid PK FK | |
| `location` | `geography(Point,4326)` | from the client, rounded to about 100 m before storage |
| `area_label` | text | public coarse label, e.g. "Mission District, San Francisco". Derived by `AreaLabeler` from the rounded point. Only the label is stored, never Google's raw response. |
| `search_radius_km` | smallint, default 25, range 1–200 | |

**`user_category_prefs`**: `(user_id, category_id)` PK. Feed filter defaults.

**`devices`**: `id`, `user_id` FK cascade, `platform` enum `ios`/`android`/`web`, `push_token` unique, `app_version`, `last_seen_at`.

**`blocks`**: `(blocker_id, blocked_id)` PK, with `check blocker_id <> blocked_id`. Blocking is symmetric in effect: neither user sees the other in the feed, and neither can message or propose a swap to the other.

**`reports`**: `id`, `reporter_id`, `target_type` enum `user`/`item`/`message`, `target_id`, `reason` enum `spam`/`inappropriate`/`scam`/`harassment`/`other`, `details` ≤ 1000, `status` enum `open`/`actioned`/`dismissed`, `resolved_by`, `resolved_at`.

### 5.3 Catalog

**`categories`**
| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `slug` | text unique | `art`, … |
| `name` | text | |
| `attribute_schema` | jsonb | JSON Schema that validates `items.attributes` |
| `is_active` | bool | |
| `sort_order` | smallint | |

Example `art` schema fields: `medium` (enum), `width_cm`, `height_cm`, `depth_cm`, `year`, `artist_name`, `framed` (bool), `signed` (bool).

**`items`**
| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `owner_id` | uuid FK users | |
| `category_id` | uuid FK, null while `draft` | |
| `title` | text, 1–120, null while `draft` | |
| `description` | text ≤ 2000 | |
| `attributes` | jsonb default `{}` | drafts: only the fields provided are type-checked. Publish: full validation against the category schema. |
| `condition` | enum `new`, `like_new`, `good`, `fair`, null while `draft` | |
| `source` | enum `created`, `swap_received` | `swap_received` marks a clone made when a swap completes |
| `estimated_value_cents` | int null | optional, informational |
| `currency` | char(3) null | |
| `fulfillment_options` | text[] default `{local_pickup}` | v1 accepts only `local_pickup` |
| `status` | enum `draft`, `available`, `reserved`, `swapped`, `archived` | see §6.2 |
| `location` | geography(Point) null | copied from the owner's location on publish; refreshed when the owner moves |
| `area_label` | text null | copied with `location` |
| `origin_item_id` | uuid null FK items | set on clones made at swap completion (provenance) |
| `published_at` | timestamptz null | |
| `version` | int default 1 | optimistic locking |

Constraint: `CHECK (status = 'draft' OR (category_id IS NOT NULL AND title IS NOT NULL AND condition IS NOT NULL))`. Only drafts may be incomplete.

Indexes:

- `GIST(location) WHERE status = 'available'`
- `(owner_id, status, created_at DESC)`
- `(owner_id, updated_at DESC) WHERE status = 'draft'`, for the drafts list
- `(category_id, status, published_at DESC)`
- `(origin_item_id)`

**`item_media`**
| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `item_id` | uuid FK items, on delete cascade | |
| `kind` | enum `image` | `video` reserved |
| `status` | enum `pending`, `processing`, `ready`, `failed` | |
| `original_key` | text | `items/{item_id}/{media_id}/original` |
| `variants` | jsonb | `{ "thumb": {key,w,h}, "card": {...}, "full": {...} }` |
| `mime` | text | `image/jpeg`, `image/png`, `image/webp`, `image/heic` |
| `bytes` | int | max 15 MB |
| `width`, `height` | int | from the original |
| `blurhash` | text | |
| `position` | smallint | 0 is the cover |

Limits: at most 10 media per item, and at least one `ready` image to publish. Variants are WebP: `thumb` 400 px, `card` 1080 px, `full` 2048 px on the longest edge. EXIF is stripped (including GPS).

#### Item drafts

A user can start a listing, leave, and come back to it later on any device.

- **Starting a draft:** the client creates the draft with an empty `POST /v1/items` as soon as the user taps "Add item" or picks the first photo. Every field is optional, so photos can start uploading in the background straight away.
- **Autosave:** the client sends `PATCH /v1/items/{id}` with `If-Match`, debounced by about 2 s. If the same draft was edited on another device, the server returns `412 VERSION_CONFLICT` with the current `Item`, and the client merges or reloads.
- **Partial validation:** fields that are present are type-checked. Required fields, required attributes and media are only enforced at `publish`.
- **Publish readiness:** every draft in a response includes `publish_readiness: { ready, missing[] }`, computed in application code. `missing` lists items such as `title`, `category`, `condition`, `attributes.medium` and `media`, so clients can show a checklist.
- **Where drafts come from:**
  - `source = created`: the user started it.
  - `source = swap_received`: a clone made when a swap completed (§6.1). The UI shows it as "New from your swap — review and list".
- **Visibility:** drafts are only ever visible to their owner. Anyone else gets `404`.
- **Limits:** at most 50 drafts per user (`DRAFT_LIMIT_REACHED`).
- **Retention:** drafts never expire. A draft's media is kept; `media.gc` only removes abandoned uploads that never completed.
- **Discarding:** deleting a draft that was never published and has `source = created` hard-deletes the row and its R2 objects. Every other item is archived instead, so history and provenance stay intact.

### 5.4 Discovery

**`swipes`**: `(user_id, item_id)` PK, `direction` enum `left`/`right`, `created_at`. Index: `(item_id) WHERE direction = 'right'`, for the future "who liked my items" feature.

### 5.5 Swaps

**`swaps`**
| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `requester_id` | uuid FK users | |
| `recipient_id` | uuid FK users | `check requester_id <> recipient_id` |
| `status` | enum `pending`, `accepted`, `completed`, `declined`, `withdrawn`, `expired`, `unavailable`, `cancelled`, `disputed` | see §6.1 |
| `fulfillment_method` | enum `local_pickup`, `shipping`, `either` | v1: `local_pickup` only |
| `note` | text ≤ 500 | requester's opening note |
| `expires_at` | timestamptz | `created_at + SWAP_PENDING_TTL` |
| `accepted_at`, `completed_at` | timestamptz null | |
| `closed_at` | timestamptz null | set on any terminal state |
| `closed_by` | uuid null | null means the system closed it |
| `close_reason` | text null | required for `cancel` and `dispute` |
| `parent_swap_id` | uuid null FK swaps | reserved for counter-offers (v2) |
| `requires_payment` | bool default false | reserved for payments (§13) |
| `version` | int default 1 | |

Indexes:

- `(recipient_id, status, created_at DESC)`
- `(requester_id, status, created_at DESC)`
- `(expires_at) WHERE status = 'pending'`

**`swap_items`**
| Column | Type | Notes |
|---|---|---|
| `swap_id` | uuid FK on delete cascade | PK part |
| `item_id` | uuid FK items | PK part |
| `from_user_id` | uuid | owner when the swap was proposed |
| `to_user_id` | uuid | |
| `snapshot` | jsonb | title, category, attributes, condition, cover media variants. Captured at proposal and frozen. |
| `resulting_item_id` | uuid null FK items | clone created in the receiver's library on completion |

Index `(item_id)`, used for invalidation on accept. v1 enforces exactly one item per side.

**`swap_participants`**: `(swap_id, user_id)` PK, `role` enum `requester`/`recipient`, `confirmed_received_at` null. Reserved per-side columns for later: `shipment_id`, `address_consented_at`.

**`swap_events`** (append-only audit log and timeline): `id` bigserial, `swap_id`, `actor_id` null (system), `type` (`created`, `accepted`, `declined`, `withdrawn`, `expired`, `invalidated`, `cancelled`, `received_confirmed`, `completed`, `disputed`), `payload` jsonb, `created_at`.

### 5.6 Messaging and notifications

**`conversations`**: `id`, `swap_id` unique null (null reserved for direct messages later), `last_message_at`.

**`conversation_participants`**: `(conversation_id, user_id)` PK, `last_read_message_id` null, `muted_until` null.

**`messages`**
| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK (v7, so ordering by id is ordering by time) | |
| `conversation_id` | uuid FK on delete cascade | |
| `sender_id` | uuid null | null for `system` messages |
| `kind` | enum `text`, `image`, `system` | |
| `body` | text ≤ 4000 | for `system`, a template key plus params |
| `attachments` | jsonb | `[{ media_key, w, h, blurhash }]`, max 4 |
| `client_message_id` | text null | dedupe key generated by the client |

Unique: `(conversation_id, sender_id, client_message_id)`. Index: `(conversation_id, id DESC)`. Messages are append-only in v1, with no edit or delete.

**`notifications`**: `id`, `user_id`, `type`, `payload` jsonb, `read_at` null. Index: `(user_id, created_at DESC)`, plus a partial index on unread rows.

### 5.7 Platform tables

**`outbox_events`**: `id` bigserial, `topic`, `aggregate_type`, `aggregate_id`, `payload` jsonb, `created_at`, `processed_at` null. Each row is written in the same transaction as the domain change, then relayed by the worker.

**`idempotency_keys`**: `(user_id, key)` PK, `route`, `request_hash`, `response_status`, `response_body` jsonb, `expires_at`.

**`rate_limit_buckets`**: `key` PK, `window_start`, `count`. Fixed-window counters kept in Postgres. Redis can replace this later behind the same interface.

pg-boss creates and manages its own `pgboss` schema.

## 6. State machines

### 6.1 Swap

```
                  accept                         both confirm_received
   ┌──────────┐ ───────────► ┌──────────┐ ─────────────────────────► ┌───────────┐
   │ pending  │              │ accepted │                            │ completed │
   └──────────┘              └──────────┘                            └───────────┘
     │ decline   → declined      │ cancel  → cancelled
     │ withdraw  → withdrawn     │ dispute → disputed (admin resolves)
     │ (job) TTL → expired
     │ (sys) item taken → unavailable
```

| Transition                | Actor        | Preconditions                                                                                                                                                                                                                  | Side effects                                                                                                                                                        |
| ------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| create → `pending`        | requester    | Both items `available`. Requester owns the offered item; recipient owns the requested one. No block either way. Fulfillment method allowed by both items. No other pending swap by this requester for the same requested item. | Insert swap, swap_items with snapshots, participants, conversation and participants, system message, `swap.created` event and outbox row                            |
| `pending` → `accepted`    | recipient    | Not expired. Both items still `available` (checked under row lock).                                                                                                                                                            | Items → `reserved`. Every other `pending` swap containing either item → `unavailable`. System message. Outbox notifies both parties and all invalidated requesters. |
| `pending` → `declined`    | recipient    |                                                                                                                                                                                                                                | Outbox notifies requester                                                                                                                                           |
| `pending` → `withdrawn`   | requester    |                                                                                                                                                                                                                                | Outbox notifies recipient                                                                                                                                           |
| `pending` → `expired`     | system (job) | `expires_at <= now()`                                                                                                                                                                                                          | Notifies both                                                                                                                                                       |
| `pending` → `unavailable` | system       | Another swap containing one of its items was accepted, or an item was archived                                                                                                                                                 | Notifies requester                                                                                                                                                  |
| `accepted` → `cancelled`  | either       | Reason required                                                                                                                                                                                                                | Items → `available`, unless archived                                                                                                                                |
| `accepted` → `completed`  | system       | Both participants have `confirmed_received_at`                                                                                                                                                                                 | See completion below                                                                                                                                                |
| `accepted` → `disputed`   | either       | Reason required                                                                                                                                                                                                                | Items stay `reserved`. Admin notified.                                                                                                                              |

**Accept transaction** (one DB transaction, `READ COMMITTED`):

1. `SELECT … FROM swaps WHERE id = $1 FOR UPDATE`. Check `status = 'pending'`, `expires_at > now()`, the caller is the recipient, and the version matches.
2. `SELECT … FROM items WHERE id IN (...) ORDER BY id FOR UPDATE`. The ordered locking avoids deadlocks. Check every item is `available`.
3. Update the items to `reserved` and the swap to `accepted`, and bump `version`.
4. Find other `pending` swaps containing these items through `swap_items(item_id)`, and set them to `unavailable`.
5. Insert `swap_events`, system messages and `outbox_events`.
6. Commit. The worker relays the outbox to push notifications and SSE.

**Completion** (runs in the transaction of the second `confirm-received`):

1. For each `swap_item`, clone the item into `to_user_id`'s library:
   - The clone gets `status = draft`, `source = swap_received`, `origin_item_id = item_id`, and copied media. It counts toward the 50-draft limit, but is never blocked by it. Media objects are copied server-side in R2 under the new item's prefix.
   - The new owner reviews the clone and publishes it when ready.
2. Set the original item to `swapped`, and set `resulting_item_id` on the `swap_item`.
3. Set the swap to `completed` with `completed_at`.

Reminders: if only one side has confirmed, the worker reminds the other on days 3 and 10. v1 never auto-completes a swap (open question O3).

### 6.2 Item

| From                 | To          | Trigger                                                                                |
| -------------------- | ----------- | -------------------------------------------------------------------------------------- |
| (none)               | `draft`     | `POST /items` (user starts a listing) or swap completion (clone, `source = swap_received`) |
| `draft`              | `available` | `POST /items/:id/publish`: at least one ready image, valid attributes, owner onboarded |
| `draft`              | (deleted)   | `DELETE /items/:id` on a never-published `created` draft: hard delete with its media      |
| `available`          | `draft`     | `POST /items/:id/unpublish` (not allowed while the item is in an accepted swap)        |
| `available`          | `reserved`  | Swap accepted                                                                          |
| `reserved`           | `available` | Swap cancelled                                                                         |
| `reserved`           | `swapped`   | Swap completed (terminal for this record)                                              |
| `draft`, `available` | `archived`  | `DELETE /items/:id`. Pending swaps containing the item → `unavailable`.                |

An item that is `reserved`, `swapped` or `archived` can't be edited (`ITEM_LOCKED`). Edits to an `available` item don't change pending swaps, which keep their snapshot.

## 7. API

Notation: `→` means the response body. Unless stated, success is `200`, and creates are `201`.

### 7.1 Shared schemas

```
ProfilePublic   { id, display_name, bio, avatar_url, area_label, member_since, completed_swaps_count }
Me              ProfilePublic + { email, onboarded, location: { area_label, search_radius_km }, category_ids[], has_passkey }
Media           { id, position, status, width, height, blurhash, urls: { thumb, card, full } }
ItemSummary     { id, title, category: {id, slug, name}, condition, cover: Media, area_label, owner: { id, display_name, avatar_url } }
Item            ItemSummary + { description, attributes, estimated_value: {amount_cents, currency} | null,
                                fulfillment_options[], status, source, media: Media[], origin_item_id, published_at, created_at, updated_at, version,
                                publish_readiness?: { ready, missing[] } }   // only present on drafts, which may have null title, category, condition or cover
SwapSide        { user: ProfilePublic(subset), items: [ItemSnapshot], confirmed_received_at }
Swap            { id, status, fulfillment_method, note, expires_at, accepted_at, completed_at, closed_at, close_reason,
                  requester: SwapSide, recipient: SwapSide, my_role, conversation_id, version, created_at }
SwapEvent       { id, type, actor_id | null, payload, created_at }
Conversation    { id, swap: { id, status, items: [ItemSnapshot(min)] }, other_user: {id, display_name, avatar_url},
                  last_message: Message | null, unread_count, muted_until }
Message         { id, conversation_id, sender_id | null, kind, body, attachments[], client_message_id, created_at }
Notification    { id, type, payload, read_at, created_at }
Page<T>         { data: T[], next_cursor: string | null }
```

### 7.2 Health and docs (public)

| Method | Path               | Notes                                           |
| ------ | ------------------ | ----------------------------------------------- |
| GET    | `/v1/health`       | Liveness: `{ status: "ok" }`                    |
| GET    | `/v1/health/ready` | Readiness: checks the database and object store |
| GET    | `/v1/openapi.json` | OpenAPI 3.1 spec, including the auth routes     |
| GET    | `/docs`            | Scalar UI                                       |

### 7.3 Auth (Better Auth, mounted at `/v1/auth/*`)

Better Auth handles these routes. Its OpenAPI output is merged into ours.

| Method     | Path                                                                        | Purpose                                                                                              |
| ---------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| POST       | `/v1/auth/sign-in/social`                                                   | `{ provider: "google", id_token? }`. Native apps pass a Google ID token; web uses the redirect flow. |
| GET        | `/v1/auth/callback/{provider}`                                              | OAuth callback. `provider` is `google` (Better Auth's `/callback/:id`).                              |
| POST       | `/v1/auth/passkey/generate-register-options` → `/passkey/verify-registration` | Add a passkey to the signed-in user (`@better-auth/passkey`)                                       |
| POST       | `/v1/auth/passkey/generate-authenticate-options` → `/passkey/verify-authentication` | Sign in with a passkey (discoverable credentials)                                            |
| POST       | `/v1/auth/passkey/register`, `/passkey/authenticate`                        | One-call alternatives to the two-step ceremony, where the client prefers them                       |
| GET/POST/DELETE | `/v1/auth/passkey/list-user-passkeys`, `/update-passkey`, `/delete-passkey` | Manage passkeys                                                                                      |
| POST       | `/v1/auth/email-otp/send-verification-otp`, `/sign-in/email-otp`            | Recovery and fallback                                                                                |
| POST       | `/v1/auth/sign-out`                                                         |                                                                                                      |
| GET        | `/v1/auth/get-session`                                                      |                                                                                                      |

Sessions: web uses an HTTP-only, Secure, `SameSite=Lax` cookie on `.kindtree.us`. Native apps receive a bearer session token and store it in the Keychain or Keystore. Both are validated by the same middleware.

### 7.4 Me and profiles

| Method | Path                          | Body / query                                 | →                                                            |
| ------ | ----------------------------- | -------------------------------------------- | ------------------------------------------------------------ |
| GET    | `/v1/me`                      |                                              | `Me`. Creates the profile on first call.                     |
| PATCH  | `/v1/me`                      | `{ display_name?, bio?, avatar_media_key? }` | `Me`                                                         |
| PUT    | `/v1/me/location`             | `{ lat, lng, search_radius_km? }`            | `Me`. Server rounds the point and derives `area_label`.      |
| PUT    | `/v1/me/categories`           | `{ category_ids[] }`                         | `Me`                                                         |
| POST   | `/v1/me/avatar/upload`        | `{ mime, bytes }`                            | `{ upload_url, media_key, expires_at }`                      |
| DELETE | `/v1/me`                      |                                              | `202`. Soft delete, then a purge job.                        |
| POST   | `/v1/me/devices`              | `{ platform, push_token, app_version }`      | `204` (upsert)                                               |
| DELETE | `/v1/me/devices/{push_token}` |                                              | `204`                                                        |
| GET    | `/v1/users/{id}`              |                                              | `ProfilePublic` (`404` if either user has blocked the other) |
| GET    | `/v1/users/{id}/items`        | `?cursor&limit`                              | `Page<ItemSummary>`, `available` items only                  |

### 7.5 Categories

| Method | Path             | →                                                          |
| ------ | ---------------- | ---------------------------------------------------------- |
| GET    | `/v1/categories` | `[{ id, slug, name, attribute_schema }]` (cacheable, ETag) |

### 7.6 Items

| Method | Path                              | Body / query                                                                                          | →                                                                                              |
| ------ | --------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| GET    | `/v1/me/items`                    | `?status=draft,available,reserved,swapped&cursor&limit`                                               | `Page<ItemSummary & {status}>`. Also feeds the swap composer.                                  |
| GET    | `/v1/me/drafts`                   | `?source=created,swap_received&cursor&limit`                                                          | `Page<ItemSummary & {source, publish_readiness, updated_at}>`, most recently edited first      |
| POST   | `/v1/items`                       | `{ category_id?, title?, description?, attributes?, condition?, estimated_value?, fulfillment_options? }` (every field optional) | `201 Item` (`draft`)                                                 |
| GET    | `/v1/items/{id}`                  |                                                                                                       | `Item`. Others can only see items that are `available`, or that appear in a swap with them.    |
| PATCH  | `/v1/items/{id}`                  | partial fields, `If-Match`                                                                            | `Item`                                                                                         |
| DELETE | `/v1/items/{id}`                  |                                                                                                       | `204`. Hard delete for a never-published `created` draft; archive for everything else (§5.3). |
| POST   | `/v1/items/{id}/publish`          |                                                                                                       | `Item`                                                                                         |
| POST   | `/v1/items/{id}/unpublish`        |                                                                                                       | `Item`                                                                                         |
| POST   | `/v1/items/{id}/media/uploads`    | `{ files: [{ mime, bytes }] }` (1–10, total ≤ 10 per item)                                            | `{ uploads: [{ media_id, upload_url, headers, expires_at }] }`. Rows are created as `pending`. |
| POST   | `/v1/items/{id}/media/complete`   | `{ media_ids[] }`                                                                                     | `202 { media: Media[] }`. Status becomes `processing` and a `media.process` job is queued.     |
| PATCH  | `/v1/items/{id}/media/order`      | `{ media_ids[] }` (full order)                                                                        | `Media[]`                                                                                      |
| DELETE | `/v1/items/{id}/media/{media_id}` |                                                                                                       | `204`                                                                                          |
| GET    | `/v1/items/{id}/provenance`       |                                                                                                       | `[{ item_id, owner: {id, display_name}, from, to, swap_id }]` (oldest first)                   |

Upload flow: request upload URLs → client sends `PUT` to R2 → `complete` → the worker validates the magic bytes and size, strips EXIF, makes the variants and blurhash, and sets `ready` (or `failed`). Clients poll `GET /items/{id}` or listen on SSE for `media.ready`.

### 7.7 Discovery

| Method | Path                   | Body / query                           | →                                                                             |
| ------ | ---------------------- | -------------------------------------- | ----------------------------------------------------------------------------- |
| GET    | `/v1/feed`             | `?category_ids&radius_km&cursor&limit` | `Page<ItemSummary & { distance_km_rounded }>`                                 |
| POST   | `/v1/swipes`           | `{ item_id, direction }`               | `{ next_action: "compose_swap" \| "none" }`                                   |
| DELETE | `/v1/swipes/{item_id}` |                                        | `204` (undo)                                                                  |
| GET    | `/v1/me/likes`         | `?cursor&limit`                        | `Page<ItemSummary>`: right-swiped, still `available`, no pending swap from me |

Feed query:

- **Includes:** items that are `available` and within `ST_DWithin(location, me, radius)`, filtered by category.
- **Excludes:** the user's own items, items they've already swiped, and items from users blocked in either direction.
- **Ordering:** by distance bucket (0–5, 5–15, 15+ km), then `published_at DESC`.
- **Cursor:** encodes `(bucket, published_at, id)`.
- **Privacy:** distance is rounded to whole km, with a minimum of 1.

### 7.8 Swaps

| Method | Path                              | Body / query                                                                        | →                                        |
| ------ | --------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------- |
| POST   | `/v1/swaps`                       | `{ requested_item_id, offered_item_id, fulfillment_method: "local_pickup", note? }` | `201 Swap`                               |
| GET    | `/v1/swaps`                       | `?role=incoming\|outgoing\|all&status=pending,accepted,…&cursor&limit`              | `Page<Swap>`                             |
| GET    | `/v1/swaps/{id}`                  |                                                                                     | `Swap & { events: SwapEvent[] }`         |
| POST   | `/v1/swaps/{id}/accept`           | `If-Match`                                                                          | `Swap`                                   |
| POST   | `/v1/swaps/{id}/decline`          | `{ reason? }`                                                                       | `Swap`                                   |
| POST   | `/v1/swaps/{id}/withdraw`         |                                                                                     | `Swap`                                   |
| POST   | `/v1/swaps/{id}/cancel`           | `{ reason }`                                                                        | `Swap`                                   |
| POST   | `/v1/swaps/{id}/confirm-received` |                                                                                     | `Swap` (may now be `completed`)          |
| POST   | `/v1/swaps/{id}/dispute`          | `{ reason }`                                                                        | `Swap`                                   |
| GET    | `/v1/me/history`                  | `?cursor&limit`                                                                     | `Page<Swap>` (`completed`, newest first) |

The v1 request shape is one-for-one. v2 will add `requested_item_ids[]` / `offered_item_ids[]` without breaking v1 clients.

### 7.9 Messaging

| Method | Path                                        | Body / query                                                            | →                                                               |
| ------ | ------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------- |
| GET    | `/v1/conversations`                         | `?cursor&limit`                                                         | `Page<Conversation>` ordered by `last_message_at DESC`          |
| GET    | `/v1/conversations/{id}`                    |                                                                         | `Conversation`                                                  |
| GET    | `/v1/conversations/{id}/messages`           | `?before=<id>` or `?after=<id>`, `limit`                                | `Page<Message>`                                                 |
| POST   | `/v1/conversations/{id}/messages`           | `{ client_message_id, kind: "text"\|"image", body?, attachment_keys? }` | `201 Message` (repeat `client_message_id` returns the original) |
| POST   | `/v1/conversations/{id}/attachments/upload` | `{ mime, bytes }`                                                       | `{ upload_url, media_key, expires_at }`                         |
| POST   | `/v1/conversations/{id}/read`               | `{ message_id }`                                                        | `204`                                                           |
| POST   | `/v1/conversations/{id}/mute`               | `{ until \| null }`                                                     | `204`                                                           |

Messaging is open while the swap is `pending`, `accepted` or `disputed`. In other states the conversation becomes read-only (`CONVERSATION_CLOSED`). Message attachments go in a private bucket and are served as signed GET URLs valid for 15 minutes.

### 7.10 Realtime (SSE)

`GET /v1/events/stream` sends `text/event-stream` with a heartbeat every 25 s. Clients resume with `Last-Event-ID` (events are kept for 24 h).

| Event                          | Payload                                    |
| ------------------------------ | ------------------------------------------ |
| `message.created`              | `Message`                                  |
| `conversation.read`            | `{ conversation_id, user_id, message_id }` |
| `swap.updated`                 | `{ swap_id, status, version }`             |
| `media.ready` / `media.failed` | `{ item_id, media_id }`                    |
| `notification.created`         | `Notification`                             |

Fan-out: after commit, application code calls `SELECT pg_notify('user_<uuid>', …)`. No triggers are involved. Every API instance `LISTEN`s for the users connected to it.

### 7.11 Notifications and safety

| Method | Path                     | Body                                           | →                                                                    |
| ------ | ------------------------ | ---------------------------------------------- | -------------------------------------------------------------------- |
| GET    | `/v1/notifications`      | `?unread_only&cursor&limit`                    | `Page<Notification> & { unread_count }`                              |
| POST   | `/v1/notifications/read` | `{ ids[] }` or `{ all: true }`                 | `204`                                                                |
| POST   | `/v1/blocks`             | `{ user_id }`                                  | `204`. Pending swaps between the two users → `withdrawn`/`declined`. |
| DELETE | `/v1/blocks/{user_id}`   |                                                | `204`                                                                |
| GET    | `/v1/blocks`             |                                                | `[{ user_id, display_name, created_at }]`                            |
| POST   | `/v1/reports`            | `{ target_type, target_id, reason, details? }` | `201 { id }`                                                         |

Notification types: `swap.requested`, `swap.accepted`, `swap.declined`, `swap.withdrawn`, `swap.expired`, `swap.unavailable`, `swap.cancelled`, `swap.received_confirmed`, `swap.completed`, `swap.reminder_confirm`, `message.created` (collapsed to one push per conversation every 5 minutes).

## 8. Background jobs (pg-boss)

| Job                    | Trigger                         | Work                                                                  |
| ---------------------- | ------------------------------- | --------------------------------------------------------------------- |
| `media.process`        | `media/complete`                | Validate, strip EXIF, make variants, blurhash, mark `ready`/`failed`  |
| `outbox.relay`         | every 5 s plus a NOTIFY wake-up | Turn outbox rows into notifications, push and SSE; mark processed     |
| `push.send`            | from relay                      | FCM/APNs through `Notifier`; prune invalid tokens                     |
| `swaps.expire`         | cron hourly                     | Expire `pending` swaps past `expires_at`                              |
| `swaps.remind_confirm` | cron daily                      | Remind on days 3 and 10 of a one-sided confirmation                   |
| `items.relocate`       | owner location change           | Refresh `location` and `area_label` on that owner's `available` items |
| `media.gc`             | cron daily                      | Delete `pending` media older than 24 h and orphaned objects (never a draft's `ready` media) |
| `drafts.remind`        | cron daily                      | One push per draft, 3 days after its last edit ("Finish listing …"). Respects the user's notification settings. |
| `idempotency.gc`       | cron daily                      | Purge expired keys                                                    |
| `accounts.purge`       | 30 days after `DELETE /me`      | Hard-delete personal data; anonymize the user's side of past swaps    |

Every job is idempotent and retried with backoff (max 5). After that it lands in a dead-letter queue, which raises an alert.

## 9. Validation and docs

- Every route is defined with `createRoute()` from `@hono/zod-openapi`. One Zod schema both validates the request and describes it in OpenAPI.
- Response schemas are also Zod. In non-production builds, responses are validated, so drift between the code and the docs fails tests.
- `/v1/openapi.json` merges our routes with Better Auth's generated spec.
- **CI:**
  - The spec builds and lints with Spectral.
  - `oasdiff breaking` runs against `main` and fails the PR on breaking changes unless it carries the `api-breaking` label.
  - The spec is published as a build artifact so clients can generate SDKs.

## 10. Errors and observability

### 10.1 Error format

```json
{
  "type": "https://api.kindtree.us/errors/swap-item-unavailable",
  "title": "Item is no longer available",
  "status": 409,
  "code": "SWAP_ITEM_UNAVAILABLE",
  "detail": "Item 0193… has been reserved in another swap.",
  "request_id": "4bf92f3577b34da6a3ce929d0e0e4736",
  "errors": [{ "field": "offered_item_id", "message": "..." }]
}
```

Clients must branch on `code`. `title` and `detail` are for humans and may change.

### 10.2 Error catalog (`src/errors/catalog.ts`)

| Code                        | HTTP | When                                                                            |
| --------------------------- | ---- | ------------------------------------------------------------------------------- |
| `VALIDATION_FAILED`         | 400  | Zod or attribute-schema failure (`errors[]` populated)                          |
| `UNAUTHENTICATED`           | 401  | Missing or invalid session                                                      |
| `FORBIDDEN`                 | 403  | Authenticated but not allowed                                                   |
| `ACCOUNT_SUSPENDED`         | 403  | Profile suspended                                                               |
| `ONBOARDING_REQUIRED`       | 403  | Feed, publish or swap before location and display name are set                  |
| `NOT_FOUND`                 | 404  | Includes resources hidden by blocks                                             |
| `VERSION_CONFLICT`          | 412  | `If-Match` mismatch                                                             |
| `IDEMPOTENCY_KEY_REUSED`    | 409  | Same key, different body                                                        |
| `ITEM_LOCKED`               | 409  | Edit or unpublish of a reserved, swapped or archived item                       |
| `ITEM_NOT_PUBLISHABLE`      | 422  | Draft is incomplete. `errors[]` lists the same fields as `publish_readiness.missing`. |
| `DRAFT_LIMIT_REACHED`       | 422  | User already has 50 drafts                                                      |
| `MEDIA_LIMIT_EXCEEDED`      | 422  | More than 10 media per item                                                     |
| `MEDIA_INVALID`             | 422  | Bad mime, size or magic bytes                                                   |
| `SWAP_ITEM_UNAVAILABLE`     | 409  | An item isn't `available` at create or accept                                   |
| `SWAP_OWN_ITEM`             | 422  | Requesting your own item, or offering someone else's                            |
| `SWAP_DUPLICATE`            | 409  | Requester already has a pending swap for this item                              |
| `SWAP_INVALID_TRANSITION`   | 409  | e.g. accepting a declined swap                                                  |
| `SWAP_EXPIRED`              | 409  | Action on a pending swap past `expires_at`                                      |
| `FULFILLMENT_NOT_SUPPORTED` | 422  | Anything other than `local_pickup` in v1                                        |
| `USER_BLOCKED`              | 403  | Interaction across a block (returned as `NOT_FOUND` where existence would leak) |
| `CONVERSATION_CLOSED`       | 409  | Message to a read-only conversation                                             |
| `RATE_LIMITED`              | 429  | Includes a `Retry-After` header                                                 |
| `INTERNAL`                  | 500  | Unhandled. Generic detail; full error goes to logs and the tracker.             |
| `DEPENDENCY_UNAVAILABLE`    | 503  | Database or object store down                                                   |

### 10.3 Route wrapper (`withApi`)

Each request passes through one middleware chain, so routes never `try/catch`:

1. Request ID and OTel span
2. Auth: resolve the session into `ctx.user`, or 401
3. Rate limit check
4. Zod validation of params, query and body
5. Idempotency lookup and replay
6. Handler (throws `DomainError(code, detail)`)
7. Error mapper: `DomainError` → catalog entry; anything else → `INTERNAL`, logged at `error` with a stack trace and recorded on the span
8. Access log line

### 10.4 Logging and telemetry

- **pino** writes JSON to stdout with these fields: `level, time, request_id, trace_id, user_id, route, method, status, latency_ms, error.code`.
- **Redaction:** `authorization`, `cookie`, `*.token`, `push_token`, `lat`, `lng`, `location`, `email`, message `body`, `attachments`. Request and response bodies are never logged.
- **OpenTelemetry:** traces cover HTTP, Postgres (`pg` instrumentation), the S3 client and pg-boss jobs. Metrics: request rate, latency and errors per route; job durations and failures; outbox lag; SSE connections.
- **Alerts:** 5xx rate above 1 % for 5 minutes, p95 latency above 1 s, outbox lag above 60 s, any dead-letter job, readiness failing.
- **Business audit trail:** `swap_events`.

## 11. Security and privacy

- **TLS and headers:** TLS everywhere, HSTS, `X-Content-Type-Options`.
- **CORS:** allowlist `https://kindtree.us` and staging only.
- **Location:**
  - Stored rounded to about 100 m. Never returned.
  - Others see only `area_label` and distance rounded to whole km.
  - EXIF GPS is stripped from every upload.
- **Rate limits:**

  | Action        | Limit                           |
  | ------------- | ------------------------------- |
  | Swipes        | 600 per hour                    |
  | Swap creates  | 30 per day                      |
  | Messages      | 60 per minute and 1,000 per day |
  | Uploads       | 100 per hour                    |
  | Auth attempts | 10 per minute per IP            |

- **Authorization:** checked in the service layer on every read and write (owner, participant, block). The database role has only the privileges it needs, with no superuser or DDL at runtime.
- **Media:** presigned URLs are scoped to one key with a 10-minute expiry. Size and mime are enforced on `complete`.
- **Third-party location disclosure (Google Geocoding):** when the Google labeler is enabled, the rounded point (3 decimal places, about 111 m) is sent to Google for each location update. Users must be told this in the privacy policy before launch. Google's terms cap caching of geocoding lat/lng at 30 days, so raw responses are never stored. The derived label is stored. Confirm with counsel that a stored locality name is allowed under the current Maps Service Terms. If not, the label is computed on each request instead.
- **Google key:** restrict it to the Geocoding API and to the server's egress IPs. Keep it out of logs and the client.
- **Account deletion:** a soft delete hides the profile immediately. Personal data is purged after 30 days. Completed swap history keeps anonymized snapshots for the counterparty.
- **Secrets:** environment variables only, rotated through the host's secret store.

## 12. Environments and delivery

| Env        | Infra                                                                   |
| ---------- | ----------------------------------------------------------------------- |
| local      | `docker-compose`: postgis/postgis:16-3.4, adobe/s3mock, Mailpit, storage-init (creates buckets), api, worker |
| staging    | Supabase (free or Pro), R2 bucket `kindtree-staging`, 1× api, 1× worker |
| production | Supabase Pro, R2 `kindtree-prod`, 2× api, 1× worker, any OCI host       |

Environment variables: `APP_ROLE`, `DATABASE_URL`, `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET_PUBLIC`, `S3_BUCKET_PRIVATE`, `MEDIA_PUBLIC_BASE_URL`, `AUTH_SECRET`, `AUTH_BASE_URL`, `PASSKEY_RP_ID=kindtree.us`, `PASSKEY_ORIGINS`, `GOOGLE_CLIENT_ID_WEB`, `GOOGLE_CLIENT_ID_IOS`, `GOOGLE_CLIENT_ID_ANDROID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_MAPS_API_KEY`, `SMTP_URL`, `FCM_SERVICE_ACCOUNT_JSON`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_PRIVATE_KEY`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `SWAP_PENDING_TTL=28d`, `CORS_ORIGINS`.

**CI.** Every step is an `npm` script, so any CI runner works. v1 uses GitHub Actions (`.github/workflows/ci.yml`).

1. typecheck and lint
2. unit tests
3. integration tests against the compose stack
4. migration check, including the ban on functions, procedures and triggers (Principle 5)
5. OpenAPI build, lint and breaking-change diff
6. Docker build

**Deploy:** migrations run as a one-off release step before new containers start. Migrations must be backward compatible (expand, then contract).

### Must-have tests

- Concurrent accepts: two swaps sharing an item are accepted in parallel. Exactly one succeeds, and the other becomes `unavailable`.
- Every allowed and forbidden swap transition.
- Completion clones items and media, sets `origin_item_id`, and marks the originals `swapped`.
- Blocks hide users and items in the feed, profiles, swaps and messaging.
- Idempotent replay of `POST /swaps` and `POST /messages`.
- Drafts: an empty draft saves; partial attributes are accepted; publish fails with the exact `missing[]` list; other users get `404`; concurrent autosaves from two devices produce `412`; discarding removes R2 objects.
- Location never appears in any response. A snapshot test scans responses for `lat`, `lng` and `location`.

## 13. Designed now, built later

| Feature              | Design sketch                                                                                                                                                                                                                                                                                         |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Counter-offers**   | `POST /swaps/{id}/counter` creates a new `pending` swap with `parent_swap_id` and closes the parent as `countered`                                                                                                                                                                                    |
| **Multi-item swaps** | `swap_items` already supports N-for-M; relax the v1 one-per-side check                                                                                                                                                                                                                                |
| **Reviews**          | `reviews(swap_id, reviewer_id, reviewee_id, rating 1–5, comment, created_at)`, unique per swap and reviewer, allowed only once the swap is `completed`                                                                                                                                                |
| **Addresses**        | `addresses(id, user_id, label, line1, line2, city, region, postal_code, country, is_default)`, columns encrypted at the application level. Only ever returned to the owner.                                                                                                                           |
| **Address consent**  | `swap_address_consents(swap_id, user_id, consented_at, revoked_at)`. Both must consent before `GET /swaps/{id}/counterparty-address` returns anything. Every reveal is audited in `swap_events`.                                                                                                      |
| **Shipments**        | `shipments(id, swap_id, from_user_id, to_user_id, carrier, service_level, label_key, tracking_number, status, cost_cents, currency, provider, provider_ref)`. Platform-bought labels mean addresses never reach the counterparty.                                                                     |
| **Payments**         | `payments(id, swap_id, payer_id, payee_id null, purpose shipping_fee\|top_up\|platform_fee, amount_cents, currency, provider, provider_ref, status, idempotency_key)`, with a `PaymentProvider` adapter. Adds an `awaiting_payment` sub-state after `accepted` when `swaps.requires_payment` is true. |
| **Direct messages**  | `conversations.swap_id` null, gated by a mutual right swipe                                                                                                                                                                                                                                           |
| **Recommendations**  | Learn from the `swipes` table; replace the feed ordering behind the same endpoint                                                                                                                                                                                                                     |

## 14. Build plan

| #   | Milestone                  | Done when                                                                                                                                                     |
| --- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Foundations**            | Hono app, Drizzle, `withApi`, error catalog, pino and OTel, OpenAPI and `/docs`, Dockerfile, compose, CI green                                                |
| 2   | **Auth and identity**      | Google, passkey and email-OTP sign-in on web and native. `/me`, location, categories, devices, blocks and reports. `.well-known` files live on `kindtree.us`. |
| 3   | **Catalog**                | Item CRUD and publish, media pipeline to R2 with variants, user libraries, provenance endpoint                                                                |
| 4   | **Discovery**              | Feed with PostGIS and cursors, swipes, likes; load-tested at 100k items                                                                                       |
| 5   | **Swaps**                  | Full state machine, accept transaction, outbox, expiry and reminder jobs, completion with cloning, history                                                    |
| 6   | **Messaging and realtime** | Conversations, messages, read state, SSE, push notifications, notifications inbox                                                                             |
| 7   | **Hardening**              | Rate limits, concurrency tests, privacy snapshot tests, alerts, staging soak, production launch                                                               |

A milestone is done only when its eval suite (§16) passes, with every hard gate green and every earlier milestone's evals still passing.

## 15. Open questions

| #   | Question                                                                                 | Proposed default                                                    |
| --- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| O2  | Can a user propose a swap for an item they swiped left on earlier (from a profile page)? | Yes; a swipe doesn't gate swap creation                             |
| O3  | Auto-complete a swap if one side confirms and the other is silent for N days?            | No in v1; reminders only, then the user can `dispute`               |
| O4  | Moderation of new listings (pre- or post-publish)?                                       | Post-publish, through reports; add automated image moderation in v2 |
| O5  | Minimum age and terms acceptance at onboarding?                                          | Collect `tos_accepted_at` and an 18+ attestation in `profiles`      |

## 16. Evals for AI-written code

The API code is written by Claude (Claude Code), with a human reviewing and merging. Evals are the executable form of this document. They decide whether a PR does what the design says, independently of the unit tests written alongside the code. **Claude can't edit an eval to make it pass:**
- `evals/` is protected by CODEOWNERS, so changes need human approval.
- Eval changes go in their own PRs. CI rejects a PR that touches both `src/` and `evals/`.
- Claude may draft new evals from this document, but only in an evals-only PR that a human reviews before any implementation starts.

### 16.1 Layers

| Layer | What it checks | Tooling (open source, no vendor) | Gate |
|---|---|---|---|
| **E1 Static rules** | The architecture rules in §1. No `CREATE FUNCTION/TRIGGER/PROCEDURE/RULE` or `DO $$` in migrations. No vendor SDK imports outside `src/adapters/*` (`@supabase/*`, `@vercel/*`, `@aws-sdk/*`, `firebase-admin`). Every route is built with `createRoute` and wrapped by `withApi`. Every thrown `DomainError` code exists in the catalog. No `try/catch` in route handlers. No `console.*`. | ESLint custom rules, `dependency-cruiser`, a small migration SQL scanner | Hard |
| **E2 Contract** | The running API matches `/v1/openapi.json`. Every documented status and schema is real, no undocumented 5xx, and every error body is valid problem+json with a catalog `code`. The spec has no breaking diff against `main`. | Schemathesis (property-based fuzzing from the spec), Spectral, oasdiff | Hard |
| **E3 Scenarios** | Black-box behaviour from this document: the user journeys, state machines and business rules, run over HTTP against the full docker-compose stack. | Vitest + a typed HTTP client generated from the spec. Scenarios are written as YAML (16.3). | Hard |
| **E4 Invariants** | Properties that must hold after any scenario: no location data in any response, drafts invisible to others, blocks respected, no item `reserved` in two accepted swaps, every state change has a `swap_events` row, every request logs with its `request_id` and redacted fields. | Assertions run after every E3 scenario, plus DB checks | Hard |
| **E5 Concurrency and load** | Parallel accepts on a shared item (exactly one wins), duplicate idempotent POSTs, concurrent draft autosaves (`412`). Feed p95 under 300 ms at 100k items. | Vitest with parallel clients; k6 (OSS) for load | Hard for concurrency; tracked for load until M7 |
| **E6 Rubric review** | Things that are hard to check mechanically: adapter boundaries respected, readable naming, no dead code, migrations expand/contract safe, docs updated. | An LLM judge with a fixed rubric (`evals/rubric.md`), scoring 1–5 per criterion; a human reviewer still approves | Soft (advisory score on the PR) |

### 16.2 Repo layout

```
evals/
  static/          # E1 rules and migration scanner
  contract/        # Schemathesis config, Spectral ruleset
  scenarios/
    m2-identity/   # one folder per milestone
    m3-catalog/
    m4-discovery/
    m5-swaps/
    m6-messaging/
  invariants/      # E4 checks, auto-run after each scenario
  perf/            # k6 scripts
  fixtures/        # seed users, categories, test images (with GPS EXIF to verify stripping)
  rubric.md        # E6 rubric
  README.md        # how to run: `npm run evals [-- --milestone m5]`
```

### 16.3 Scenario format

Each scenario is a YAML file that reads like the spec, so a reviewer can check it against this document without reading code:

```yaml
id: M5-SWAP-ACCEPT-INVALIDATES-OTHERS
spec_ref: "§6.1 Accept transaction"
given:
  users: [alice, bob, carol]
  items:
    - { ref: a1, owner: alice, status: available }
    - { ref: b1, owner: bob,   status: available }
    - { ref: c1, owner: carol, status: available }
  swaps:
    - { ref: s1, requester: bob,   requested: a1, offered: b1 }
    - { ref: s2, requester: carol, requested: a1, offered: c1 }
when:
  - { as: alice, call: "POST /v1/swaps/{s1}/accept", headers: { If-Match: "{s1.version}" } }
then:
  - { status: 200, body: { status: accepted } }
  - { get: "/v1/swaps/{s2}", as: carol, expect: { status: unavailable } }
  - { get: "/v1/items/{a1}", as: alice, expect: { status: reserved } }
  - { notifications: carol, includes: swap.unavailable }
  - { swap_events: s1, includes: [created, accepted] }
```

### 16.4 Minimum eval set per milestone

| Milestone | Required scenarios (non-exhaustive) |
|---|---|
| **M1 Foundations** | Health and readiness. Unknown route → problem+json `404`. Validation error → `400` with `errors[]`. Thrown unknown error → `500 INTERNAL` with no stack in the body, and a logged stack trace with `request_id`. `/v1/openapi.json` lints clean. E1 rules wired up and failing on a planted violation. |
| **M2 Identity** | Unauthenticated → `401`. First `GET /me` creates the profile. Location input is never echoed back as coordinates. Email OTP sign-in via Mailpit. Blocked user's profile → `404`. Session works as cookie and as bearer. |
| **M3 Catalog** | Empty draft saves. Partial attributes accepted on a draft. Publish → `ITEM_NOT_PUBLISHABLE` with the exact `missing[]`. Upload → complete → `ready`, with variants present and EXIF GPS stripped. 11th media → `MEDIA_LIMIT_EXCEEDED`. 51st draft → `DRAFT_LIMIT_REACHED`. Discarding a draft removes its objects from the object store. Another user reading a draft → `404`. |
| **M4 Discovery** | Feed excludes the user's own items, swiped items, blocked users and non-`available` items, and respects the radius. Cursor pagination is stable with no duplicates. Distance is rounded. Undoing a swipe brings the item back. |
| **M5 Swaps** | Every allowed transition succeeds and every forbidden one → `SWAP_INVALID_TRANSITION`. Accept invalidates other swaps. Parallel accept race. Expiry job at 28 days (clock injected). Non-pickup fulfillment → `FULFILLMENT_NOT_SUPPORTED`. Completion clones as a `swap_received` draft with provenance; originals become `swapped`. History lists completed swaps. Stale `If-Match` → `412`. |
| **M6 Messaging** | Conversation exists on request. Duplicate `client_message_id` returns the original. Messages are blocked after decline (`CONVERSATION_CLOSED`). SSE delivers `message.created` to the other participant and resumes with `Last-Event-ID`. Read cursor updates unread counts. Push notifications are collapsed per conversation. |
| **M7 Hardening** | Rate limits return `429` with `Retry-After`. k6 feed p95 under 300 ms. All E4 invariants pass across the full suite. |

### 16.5 Running and scoring

- `npm run evals` runs E1 to E5 against `docker compose up` locally and in CI. The run is deterministic: seeded data, an injected clock and fixed UUID generation in test mode.
- CI publishes a scorecard on every PR: the pass/fail count per layer and milestone, newly failing evals, and the E6 rubric score.
- **Merge rule:**
  - All hard-gate evals pass for the current milestone and every earlier one. "Current" means the milestones listed as `active` in `evals/milestones.json`.
  - An evals-only PR may add scenarios for a milestone that isn't built yet. They run but don't gate until the implementation PR adds that milestone to `active`. This keeps evals-first PRs mergeable without weakening any gate.
  - The E6 score is at least 3.5 on average (advisory until M3, then enforced).
  - A human approves.
- The CI workflow runs `npm run evals` from M1 onwards.
- A `CLAUDE.md` at the repo root points Claude to this document, the principles in §1, `evals/rubric.md` and the `npm run evals` command. Claude runs the relevant milestone's evals locally and includes the scorecard in the PR description before asking for review.
- Workflow per milestone:
  1. Claude drafts the milestone's scenarios in an evals-only PR.
  2. A human reviews and merges it.
  3. Claude implements until the evals pass.
  4. A human reviews and merges the implementation PR.
