# Tomlin Draw v2 — Spec (Banjo builds, Bandit scoped 2026-11-24)

**Owner:** Banjo 🦝 · **Reviewer:** JJ · **Live v1:** https://krakentoolbar.github.io/tomlin-draw/ · **Repo:** github.com/krakentoolbar/tomlin-draw (public)

## 1. Why we're replacing drawnames.com

The family (JJ, Kait, Hewitt, Sonja, Micah, Lucas, Sarah) has used drawnames 2023–2025. It does the job but:

- Ads and Amazon affiliate upsell on every screen, plus year-round marketing email to all 7 people.
- Accounts + emailed sign-in codes for a once-a-year task.
- It nags by email, which nobody reads. We want **iMessage reminders with the person's link until they confirm they bought the gift.**
- We can't see who has actually bought. Drawnames never closes the loop.
- Wish-list changes only surface as "there are new wishes!" emails.

**Goal:** the best possible 7-person family gift exchange: zero accounts, one tap to see your person, wish lists that actually get used, and Banjo texting people until the job is done. Done means every sibling has confirmed "bought" before Dec 24.

## 2. What v1 already does (shipped 11/23)

Single static `index.html`, no backend. Organizer enters names, rules, taps Draw. Each person's assignment is XOR-obfuscated into their own `#r<hex>` link. Reveal page: "Hey Hewitt → tap → You're buying for Sonja → budget". History for 2024/2025 is hard-coded for the no-repeat rule. Couples exclusion supported. Verified live on phone width, light + dark.

**v1 limits that force a backend:** no shared state → no wish lists, no confirmation, no reminders. Also: the repo is public, so the XOR key is public; v2 tokens must be random server-issued, not derived from names.

## 3. Gap audit vs drawnames

| Capability | drawnames | v1 | v2 target | Priority |
|---|---|---|---|---|
| Draw with no-repeat + couple exclusions | yes | yes | yes, server-side, history in DB | P0 |
| Private reveal link per person | email | hash link | random token link, sent by Banjo over iMessage | P0 |
| Wish lists with product links | yes | no | yes, edit own, see your giftee's | P0 |
| "I bought it" confirmation | no | no | yes, one button, visible to organizer | P0 |
| Reminders | email, generic | no | iMessage, personal link, until confirmed, cadence below | P0 |
| Organizer dashboard (who's confirmed, resend link) | partial | no | yes, admin link | P0 |
| New-wish notification to the Santa | email | no | iMessage, max 1/day | P1 |
| Anonymous question to your giftee ("what size?") | yes | no | in-app Q&A thread, Banjo texts the nudge | P1 |
| Exchange date + countdown on reveal page | yes | no | yes | P1 |
| Draw history across years (auto no-repeat next year) | yes | hard-coded | DB table, seeded 2024/2025, append 2026 | P1 |
| Add to home screen (PWA manifest + icon) | app | no | yes, cheap | P2 |
| Post-Christmas "who had who" reveal | no | no | yes, admin toggle on Dec 26 | P2 |
| Kids / plus-ones joining later | yes | no | admin can add a member before draw only | P2 |
| Ads, affiliate, marketing email, accounts | yes | no | **never** | — |

## 4. Architecture

```
iPhone (siblings)  ──HTTPS──▶  GitHub Pages: index.html (static, vanilla JS)
                                      │ fetch JSON
                                      ▼
                          Cloudflare Worker  ──▶  D1 (SQLite)   ← all state
                                      ▲
                         GET /banjo/due   │  POST /banjo/sent
                                      │
                      Banjo (Mac Mini cron, every 30 min 9a–9p CT)
                                      │ osascript → Messages.app
                                      ▼
                              iMessage to each sibling
```

**Why this stack**
- **Cloudflare Worker + D1:** free tier covers this 1000x over, Banjo's `wrangler` is already logged into JJ's account (`jjtomlin18@gmail.com`, account `7b868e14…`), deploy is `wrangler deploy`, no server to babysit. Railway was rejected: family-dashboard runbook shows the trial-credit project dying; this must not die Dec 20. Google Apps Script was rejected: deploy needs interactive Google auth Banjo can't automate.
- **Static frontend stays on GitHub Pages:** already live, auto-deploys on push. Worker allows CORS from `https://krakentoolbar.github.io` only.
- **Outbox pattern for texts:** the Worker decides *who is due what* (cadence logic lives in one place, testable). Banjo's cron is dumb: pull `/banjo/due`, send each, ack `/banjo/sent`. If the Mini is asleep, texts are late, never lost or duplicated.
- **iMessage over Twilio:** Banjo already texts JJ from scheduled tasks; the siblings are all iPhone; zero cost; messages come from JJ's number so people actually open them.

**Secrets:** none in the repo. Worker has `BANJO_KEY` (shared secret for `/banjo/*`) and `ADMIN_PEPPER` as wrangler secrets. Phone numbers live only in D1. The public repo must never contain phones or tokens.

## 5. Data model (D1)

```sql
CREATE TABLE groups (
  id TEXT PRIMARY KEY,              -- random 12 chars
  name TEXT NOT NULL,               -- "Christmas 2026"
  year INTEGER NOT NULL,
  exchange_date TEXT NOT NULL,      -- "2026-12-25"
  budget TEXT,                      -- "$50"
  admin_token TEXT NOT NULL UNIQUE, -- random 24 chars, organizer link
  reveal_all_at TEXT,               -- null until organizer flips post-Christmas reveal
  created_at TEXT NOT NULL
);
CREATE TABLE members (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id),
  name TEXT NOT NULL,
  phone TEXT,                       -- E.164, iMessage target; null = organizer sends link by hand
  token TEXT NOT NULL UNIQUE,       -- random 24 chars, the person's private link
  sort INTEGER NOT NULL,
  confirmed_at TEXT,                -- "I bought it"
  link_opened_at TEXT,              -- first GET /me
  revealed_at TEXT                  -- tapped reveal
);
CREATE TABLE assignments (
  group_id TEXT NOT NULL,
  giver_id TEXT NOT NULL,
  receiver_id TEXT NOT NULL,
  PRIMARY KEY (group_id, giver_id)
);
CREATE TABLE history (                -- cross-year no-repeat, by first name
  year INTEGER NOT NULL,
  giver TEXT NOT NULL,
  receiver TEXT NOT NULL,
  PRIMARY KEY (year, giver)
);
CREATE TABLE wishes (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id),
  text TEXT NOT NULL,
  url TEXT,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE TABLE messages (               -- anonymous Q&A between Santa and giftee
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('question','answer')),
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT
);
CREATE TABLE outbox (                 -- every text Banjo should send
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL,
  kind TEXT NOT NULL,                 -- invite | reminder | wish_nudge | new_wish | question | answer | resend
  body TEXT NOT NULL,
  due_at TEXT NOT NULL,
  sent_at TEXT,
  created_at TEXT NOT NULL
);
```

Seed `history` with (exact first names as used in v1):

```
2025: Hewitt→Kait, JJ→Micah, Kait→Lucas, Lucas→Sarah, Micah→Sonja, Sarah→JJ, Sonja→Hewitt
2024: Hewitt→JJ, JJ→Lucas, Kait→Sonja, Lucas→Hewitt, Micah→Kait, Sarah→Micah, Sonja→Sarah
```

Nickname mapping from drawnames (Bandit's assumption, JJ to confirm): Grizzlymint = Hewitt, Yaya My Precious = Sonja, Luky Boy = Lucas, Queen Sarah = Sarah, Kaitlyn Stark = Kait, JiJi = JJ.

## 6. API (Worker, JSON, CORS from the Pages origin)

Auth is the token in the query string. Member token = `t`, admin token = `a`, Banjo key = header `X-Banjo-Key`.

| Method | Path | Who | Does |
|---|---|---|---|
| POST | `/groups` | anyone (organizer) | body `{name, year, exchange_date, budget, organizer_name, members:[{name, phone}], couples:[[a,b]], no_repeat:true}`. Server runs the draw (derangement + couples + history), inserts everything, queues `invite` texts for members with phones. Returns `{admin_token, members:[{name, token, link}]}` so the organizer can hand-send any without a phone. |
| GET | `/me?t=` | member | `{group:{name,budget,exchange_date,days_left}, me:{name,confirmed_at,wishes[]}, receiver:{name,wishes[]}, thread:[...], revealed}`. Sets `link_opened_at`. |
| POST | `/me/reveal?t=` | member | sets `revealed_at`. |
| PUT | `/me/wishes?t=` | member | body `[{id?, text, url?}]`, full replace (soft-delete missing). Queues `new_wish` to their Santa (dedupe: at most one per Santa per 24h, due next cron). |
| POST | `/me/confirm?t=` · DELETE same | member | set / clear `confirmed_at`. Confirm cancels any unsent `reminder` rows for that member. |
| POST | `/me/question?t=` | member | body `{text}` → messages(kind=question, to=receiver). Queues `question` text to receiver: "Your Secret Santa has a question, open your link." |
| POST | `/me/answer?t=` | member | body `{message_id, text}` → messages(kind=answer, to=asker). Queues `answer` text. |
| GET | `/admin?a=` | organizer | full state: members with phone, link, opened/revealed/confirmed, wish counts, last text sent, outbox pending. Assignments only if `?spoilers=1`. |
| PUT | `/admin/member/:id?a=` | organizer | `{phone, name}`. |
| POST | `/admin/resend/:id?a=` | organizer | queues `resend` text now. |
| POST | `/admin/redraw?a=` | organizer | allowed only if nobody has `revealed_at`. Re-runs draw, re-queues invites. |
| POST | `/admin/reveal-all?a=` | organizer | sets `reveal_all_at`; `/me` then includes `all_pairs`. |
| GET | `/banjo/due` | Banjo | `[{outbox_id, phone, body}]` where `due_at <= now` and `sent_at IS NULL`, max 20, oldest first. Also runs `schedule_reminders()` (idempotent, see §8) before answering. |
| POST | `/banjo/sent` | Banjo | `{ids:[...]}` → stamps `sent_at`. |

Error shape `{error:"message for a human"}`. Rate limit: none needed, but reject bodies > 10KB and wishes > 30 per person.

## 7. Frontend (index.html, keep vanilla, keep one file + manifest)

Three views, hash-routed: `#` organizer setup, `#r<token>` member, `#a<token>` admin. Keep the current visual system (DM Serif Display / DM Sans, cranberry accent, light + dark tokens). Every control keeps a stable `id`.

**Organizer setup (JJ, once a year)**
- Names pre-filled (7), each with an optional phone field (`tel` input, format on blur). Occasion, exchange date (default Dec 25 of current year), budget, couples box, no-repeat toggle.
- Draw → POST `/groups` → success screen: "Banjo is texting everyone their link" + the admin link (big Copy button, "save this, it's your dashboard") + per-person links for anyone without a phone.
- Previous year's group found in localStorage → "Reuse last year's people" prefill.

**Member page (siblings, the one that matters)**
1. Before reveal: `Christmas 2026 · Hey Hewitt · Tap to see who you drew`.
2. After reveal: giftee name big, budget, `23 days left`. Below it **their wish list** (text + link, links open in new tab). Empty state: "Sonja hasn't added wishes yet. Ask her anonymously ↓".
3. **My wish list** section: up to 30 rows of `thing` + optional `link`, Add / remove, autosave on blur with a "Saved" toast. Paste a URL alone → fetch nothing, just store it (no scraping; keep it dumb).
4. **Ask your giftee anonymously**: one text box, thread below it. Giftee sees "Your Secret Santa asks:" and an answer box. Never shows who.
5. **I bought it** button (primary, pine green when done, "Nice. Banjo will stop texting you."). Tappable again to undo.
6. After `reveal_all_at`: a footer "Who had who" list.
- Reveal state is server-side now, so re-opening the link skips straight to the name (no re-tap).
- Bad/unknown token → the existing "paste your code" fallback.

**Admin page (JJ)**
Table: name · phone · opened · revealed · wishes · bought · last text. Row actions: Resend link, Edit phone. Top: pending texts count, Redraw (disabled once anyone revealed), Show matches (spoilers), Reveal all (after Christmas). Mobile-first, it's a phone dashboard.

**PWA:** `manifest.webmanifest` + 192/512 icon (gift on cranberry), `theme-color`. No service worker (nothing to cache offline, avoid stale-JS bugs).

## 8. Reminder engine (lives in the Worker, Banjo just sends)

`schedule_reminders()` runs on every `/banjo/due` call. For each group with `exchange_date` in the future, and each member with a phone:

| Kind | When (CT, 10:00 unless noted) | Condition | Body |
|---|---|---|---|
| invite | immediately at draw | has phone | `{Name}, Tomlin Christmas draw is in. Tap to see who you got (don't share): {link}` |
| wish_nudge | Dec 1, Dec 6 | own wish list empty | `{Name}, add 3 things to your wish list so your Santa isn't guessing: {link}` |
| reminder | Dec 1, 8, 15, 18, 20, 22, 23, 24 | not confirmed | `{Name}, friendly nudge: {days} days to Christmas. Tap "I bought it" once you're done: {link}` (last two: "last call") |
| new_wish | next cron tick, max 1 per Santa per 24h | giftee added a wish | `Your person added to their wish list: {link}` |
| question / answer | next cron tick | message created | `Your Secret Santa has a question for you: {link}` / `Your giftee answered: {link}` |
| resend | now | organizer clicked | same as invite |

Rules: idempotent (an `outbox` row per member+kind+date, insert-ignore); quiet hours 9p–9a CT (due_at is clamped to 9a); confirm deletes unsent reminders; if `exchange_date` passes, nothing more is scheduled. Dates above assume Dec 25; derive as `exchange_date − N` so a Dec 24 exchange still works.

**Banjo side:** `~/.claude/automations/tomlin-draw-texts.sh` on cron `*/30 9-21 * * *` CT: `GET /banjo/due` with the key → for each row `osascript` send to `phone` via Messages.app (same mechanism as the existing JJ texts) → `POST /banjo/sent`. Log to `~/.claude/automations/logs/tomlin-draw-texts.log`. Text JJ once if the Worker is unreachable for > 6h (same dedupe style as `fd-sync-watch.sh`). Dry-run flag that prints instead of sending; **first real run sends only to JJ's number** to prove the pipe.

## 9. Milestones + acceptance

**M1 — Backend + wish lists (target: by Nov 30)**
- Worker + D1 deployed at `tomlin-draw.<account>.workers.dev`, schema + history seed applied, CORS locked to the Pages origin.
- Organizer flow creates a group via API; member page shows giftee + giftee's wishes + edits own wishes; "I bought it" works; admin page shows status.
- v1 XOR links are retired (hash still routes, shows "ask JJ for your new link").
- Acceptance: JJ runs a real draw from his phone, opens two sibling links in private tabs, adds a wish on one, sees it on the other, confirms, sees it in admin. No console errors, light + dark, 375px wide.

**M2 — Banjo texts (target: by Dec 1, the first reminder date)**
- Outbox + `schedule_reminders()` + `/banjo/*` + cron script. Dry run shows the right rows for a seeded group with faked dates (unit test the scheduler with a fixed `now`).
- First live run: invite to JJ only. Then JJ says go → invites to everyone with a phone.
- Acceptance: a member who confirms gets no further reminders (verify by advancing a test group's dates). Duplicate send is impossible by construction (outbox row primary key).

**M3 — Polish (by Dec 10, nice-to-have)**
- Anonymous Q&A, new-wish notifications, countdown, PWA manifest, reveal-all toggle, 2026 history appended automatically on draw.

## 10. Decisions JJ owes

1. Phone numbers for the 7 (entered in the app, never in the repo). Who, if anyone, should get links by hand instead?
2. Exchange date (Dec 25?) and budget.
3. ~~Reminder cadence above OK, or lighter?~~ **Approved by JJ 2026-11-24 as written in §8.**
4. Confirm the nickname mapping in §5 (matters only for the no-repeat rule).
5. OK to retire the v1 links the moment M1 ships (nobody has been sent one yet, so yes unless JJ already texted).

## 11. Handoff notes for Banjo

- Clone `git@github.com:krakentoolbar/tomlin-draw.git`. Put the Worker in `worker/` (`wrangler.toml`, `src/index.js`, `schema.sql`, `seed.sql`). Keep `index.html` at the root so Pages keeps serving it.
- Keep it boring: vanilla JS, no framework, no bundler, no TypeScript. One Worker file is fine. Match the existing style in `index.html`.
- Coding standards from `~/.claude/CLAUDE.md` apply (surgical, simple, no speculative abstractions). Tag any placeholder UI with `data-mock=` per the mockup rule and keep `MOCKS.md` current.
- Deploy: `cd worker && wrangler d1 create tomlin-draw && wrangler d1 execute tomlin-draw --file schema.sql && wrangler d1 execute tomlin-draw --file seed.sql && wrangler secret put BANJO_KEY && wrangler deploy`. Put the Worker URL in `index.html` as a single `API` const.
- Report back in `raccoon-comms/banjo/` after each milestone with the live URL and what JJ needs to do. Text JJ once per milestone, not per commit.
- Do NOT text any sibling until JJ says go in writing. Dry-run first, JJ-only second, everyone third.
