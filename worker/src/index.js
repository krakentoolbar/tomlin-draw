// Tomlin Draw v2 Worker: D1 state, draw, wish lists, outbox for Banjo's texts. See ../SPEC.md.

const REMINDER_DAYS = [24, 17, 10, 7, 5, 3, 2, 1];
const NUDGE_DAYS = [24, 19];
const MAX_BODY = 10240;
const MAX_WISHES = 30;
const DRAW_TRIES = 5000;
const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

// ---------- pure helpers (exported for test.mjs) ----------

export function randomToken(len) {
  let out = '';
  const buf = new Uint8Array(len * 2);
  while (out.length < len) {
    crypto.getRandomValues(buf);
    for (const b of buf) if (b < 248 && out.length < len) out += CHARS[b % 62];
  }
  return out;
}

export function firstName(name) {
  return String(name).trim().split(/\s+/)[0].toLowerCase();
}

function randInt(n) {
  const u = new Uint32Array(1);
  crypto.getRandomValues(u);
  return u[0] % n;
}

// names: array of names. forbidden: Set of "giver|receiver" first names, lowercased.
// Returns receiver index per giver index, or null if no valid draw was found.
export function drawNames(names, forbidden) {
  const n = names.length;
  if (n < 2) return null;
  const key = names.map(firstName);
  const p = names.map((_, i) => i);
  for (let t = 0; t < DRAW_TRIES; t++) {
    for (let i = n - 1; i > 0; i--) { const j = randInt(i + 1); const x = p[i]; p[i] = p[j]; p[j] = x; }
    let ok = true;
    for (let i = 0; i < n && ok; i++) ok = p[i] !== i && !forbidden.has(key[i] + '|' + key[p[i]]);
    if (ok) return p.slice();
  }
  return null;
}

const CT_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago', hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
});

function ctParts(d) {
  const p = {};
  for (const x of CT_FMT.formatToParts(d)) p[x.type] = x.value;
  return p;
}

// Minutes from UTC to Chicago wall time at instant d (-360 CST, -300 CDT).
export function ctOffsetMinutes(d) {
  const p = ctParts(d);
  const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return Math.round((wall - Math.floor(d.getTime() / 1000) * 1000) / 60000);
}

export function ctDate(d) {
  const p = ctParts(d);
  return p.year + '-' + p.month + '-' + p.day;
}

function ctHour(d) {
  return +ctParts(d).hour % 24;
}

// The UTC instant of `hour`:00 Chicago time on date "YYYY-MM-DD".
export function ctAt(dateStr, hour) {
  const [y, m, day] = dateStr.split('-').map(Number);
  const base = Date.UTC(y, m - 1, day, hour);
  let t = base + 360 * 60000;
  for (let i = 0; i < 2; i++) t = base - ctOffsetMinutes(new Date(t)) * 60000;
  return new Date(t);
}

// Quiet hours 9p to 9a CT: push anything in that window to the next 9a.
export function clampQuiet(d) {
  const h = ctHour(d);
  if (h >= 21) return ctAt(addDays(ctDate(d), 1), 9);
  if (h < 9) return ctAt(ctDate(d), 9);
  return d;
}

export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}

export function reminderDates(exchangeDate) {
  return {
    reminder: REMINDER_DAYS.map(n => ({ date: addDays(exchangeDate, -n), days: n })),
    wish_nudge: NUDGE_DAYS.map(n => ({ date: addDays(exchangeDate, -n), days: n }))
  };
}

export function inviteBody(name, link) {
  return `${name}, Tomlin Christmas draw is in. Tap to see who you got (don't share): ${link}`;
}
export function reminderBody(name, days, link) {
  const d = days === 1 ? '1 day' : days + ' days';
  if (days <= 2) return `${name}, last call: ${d} to Christmas. Tap "I bought it" once you're done: ${link}`;
  return `${name}, friendly nudge: ${d} to Christmas. Tap "I bought it" once you're done: ${link}`;
}
export function wishNudgeBody(name, link) {
  return `${name}, add 3 things to your wish list so your Santa isn't guessing: ${link}`;
}
export function newWishBody(link) { return `Your person added to their wish list: ${link}`; }
export function questionBody(link) { return `Your Secret Santa has a question for you: ${link}`; }
export function answerBody(link) { return `Your giftee answered: ${link}`; }

export function normalizePhone(v) {
  if (v == null || String(v).trim() === '') return null;
  let s = String(v).replace(/[^\d+]/g, '');
  if (/^\d{10}$/.test(s)) s = '+1' + s;
  else if (/^1\d{10}$/.test(s)) s = '+' + s;
  if (!/^\+\d{10,15}$/.test(s)) fail(400, `"${v}" doesn't look like a phone number.`);
  return s;
}

// ---------- plumbing ----------

function fail(status, message) {
  const e = new Error(message);
  e.status = status;
  throw e;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

function q(env, sql, ...args) { return env.DB.prepare(sql).bind(...args); }
async function all(env, sql, ...args) { return (await q(env, sql, ...args).all()).results || []; }
function one(env, sql, ...args) { return q(env, sql, ...args).first(); }

function corsHeaders(origin, env) {
  const h = { 'Vary': 'Origin' };
  if (origin && (origin === env.PAGES_ORIGIN || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin))) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
    h['Access-Control-Allow-Headers'] = 'Content-Type, X-Banjo-Key';
    h['Access-Control-Max-Age'] = '86400';
  }
  return h;
}

function text(v, max, label) {
  if (v == null) return '';
  if (typeof v !== 'string' && typeof v !== 'number') fail(400, `${label} should be text.`);
  const s = String(v).trim();
  if (s.length > max) fail(400, `${label} is too long (max ${max} characters).`);
  return s;
}

function cleanUrl(v) {
  const s = text(v, 1000, 'Link');
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) fail(400, 'Links need to start with http:// or https://');
  return 'https://' + s;
}

const nowIso = () => new Date().toISOString();
const memberLink = (env, token) => `${env.PAGES_ORIGIN}/tomlin-draw/#r${token}`;
const adminLink = (env, token) => `${env.PAGES_ORIGIN}/tomlin-draw/#a${token}`;

// Prepared INSERT OR IGNORE into outbox, or null for members without a phone.
function outboxStmt(env, member, kind, body, dueAt, dueDate) {
  if (!member.phone) return null;
  return q(env, 'INSERT OR IGNORE INTO outbox (id, member_id, kind, body, due_at, due_date, created_at) VALUES (?,?,?,?,?,?,?)',
    crypto.randomUUID(), member.id, kind, body, dueAt.toISOString(), dueDate || null, nowIso());
}

async function batch(env, stmts) {
  stmts = stmts.filter(Boolean);
  if (stmts.length) await env.DB.batch(stmts);
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || !a.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}

// ---------- draw ----------

async function runDraw(env, members, year, rules) {
  const forbidden = new Set();
  const byName = {};
  members.forEach(m => { byName[m.name.toLowerCase()] = m; byName[firstName(m.name)] = byName[firstName(m.name)] || m; });
  for (const pair of rules.couples || []) {
    const [a, b] = pair.map(n => byName[String(n).trim().toLowerCase()]);
    if (!a || !b) fail(400, `Couple "${pair.join(' + ')}" doesn't match the names in the draw.`);
    forbidden.add(firstName(a.name) + '|' + firstName(b.name));
    forbidden.add(firstName(b.name) + '|' + firstName(a.name));
  }
  if (rules.no_repeat) {
    const rows = await all(env, 'SELECT giver, receiver FROM history WHERE year >= ? AND year < ?', year - 2, year);
    rows.forEach(r => forbidden.add(firstName(r.giver) + '|' + firstName(r.receiver)));
  }
  const p = drawNames(members.map(m => m.name), forbidden);
  if (!p) fail(400, "Those rules leave no valid draw. Loosen the couples or turn off no-repeat.");
  return p;
}

function drawStmts(env, group, members, p) {
  const stmts = [q(env, 'DELETE FROM assignments WHERE group_id = ?', group.id)];
  members.forEach((m, i) => {
    const r = members[p[i]];
    stmts.push(q(env, 'INSERT INTO assignments (group_id, giver_id, receiver_id) VALUES (?,?,?)', group.id, m.id, r.id));
    stmts.push(q(env, 'INSERT OR REPLACE INTO history (year, giver, receiver) VALUES (?,?,?)',
      group.year, m.name.trim().split(/\s+/)[0], r.name.trim().split(/\s+/)[0]));
  });
  const due = clampQuiet(new Date());
  members.forEach(m => stmts.push(outboxStmt(env, m, 'invite', inviteBody(m.name, memberLink(env, m.token)), due)));
  return stmts;
}

// ---------- reminder engine (SPEC §8) ----------

export async function scheduleReminders(db, now, origin = 'https://krakentoolbar.github.io') {
  const env = { DB: db, PAGES_ORIGIN: origin };
  const today = ctDate(now);
  const groups = await all(env, 'SELECT id, exchange_date, created_at FROM groups WHERE exchange_date > ?', today);
  const stmts = [];
  for (const g of groups) {
    const created = ctDate(new Date(g.created_at));
    const plan = reminderDates(g.exchange_date);
    const members = await all(env,
      `SELECT m.*, (SELECT count(*) FROM wishes w WHERE w.member_id = m.id AND w.deleted_at IS NULL) AS wish_count
       FROM members m WHERE m.group_id = ? AND m.phone IS NOT NULL AND m.phone != ''`, g.id);
    for (const m of members) {
      const link = memberLink(env, m.token);
      const usable = x => x.date >= today && x.date > created;
      if (!m.confirmed_at) for (const r of plan.reminder.filter(usable))
        stmts.push(outboxStmt(env, m, 'reminder', reminderBody(m.name, r.days, link), ctAt(r.date, 10), r.date));
      if (!m.wish_count) for (const r of plan.wish_nudge.filter(usable))
        stmts.push(outboxStmt(env, m, 'wish_nudge', wishNudgeBody(m.name, link), ctAt(r.date, 10), r.date));
    }
  }
  for (let i = 0; i < stmts.length; i += 50) await batch(env, stmts.slice(i, i + 50));
  return stmts.length;
}

// ---------- routes: groups ----------

async function createGroup(c) {
  const { env } = c;
  const b = c.body || {};
  const name = text(b.name, 60, 'Name') || fail(400, 'Give the exchange a name.');
  const year = parseInt(b.year, 10);
  if (!(year >= 2000 && year <= 2100)) fail(400, 'Year looks wrong.');
  const exchange = text(b.exchange_date, 10, 'Exchange date');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(exchange) || addDays(exchange, 0) !== exchange) fail(400, 'Exchange date should be YYYY-MM-DD.');
  const budget = text(b.budget, 30, 'Budget') || null;
  if (!Array.isArray(b.members) || b.members.length < 2 || b.members.length > 30) fail(400, 'A draw needs 2 to 30 people.');
  const seen = {};
  const members = b.members.map((m, i) => {
    const n = text(m && m.name, 40, 'Name') || fail(400, 'Every person needs a name.');
    if (seen[n.toLowerCase()]) fail(400, `${n} is in the list twice.`);
    seen[n.toLowerCase()] = 1;
    return { id: crypto.randomUUID(), name: n, phone: normalizePhone(m.phone), token: randomToken(24), sort: i };
  });
  const couples = Array.isArray(b.couples) ? b.couples.filter(p => Array.isArray(p) && p.length === 2) : [];
  const rules = { couples, no_repeat: !!b.no_repeat };
  const group = { id: randomToken(12), name, year, exchange_date: exchange, budget, admin_token: randomToken(24) };
  const p = await runDraw(env, members, year, rules);

  const stmts = [q(env, 'INSERT INTO groups (id, name, year, exchange_date, budget, admin_token, rules, created_at) VALUES (?,?,?,?,?,?,?,?)',
    group.id, name, year, exchange, budget, group.admin_token, JSON.stringify(rules), nowIso())];
  members.forEach(m => stmts.push(q(env, 'INSERT INTO members (id, group_id, name, phone, token, sort) VALUES (?,?,?,?,?,?)',
    m.id, group.id, m.name, m.phone, m.token, m.sort)));
  await batch(env, stmts.concat(drawStmts(env, group, members, p)));
  return json({
    group_id: group.id,
    admin_token: group.admin_token,
    admin_link: adminLink(env, group.admin_token),
    members: members.map(m => ({ name: m.name, token: m.token, link: memberLink(env, m.token), has_phone: !!m.phone }))
  });
}

// ---------- routes: member ----------

function withMember(handler) {
  return async c => {
    const t = c.url.searchParams.get('t') || '';
    const m = /^[A-Za-z0-9]{24}$/.test(t) && await one(c.env,
      `SELECT m.*, g.name AS g_name, g.year AS g_year, g.budget AS g_budget, g.exchange_date AS g_exchange,
              g.reveal_all_at AS g_reveal_all_at
       FROM members m JOIN groups g ON g.id = m.group_id WHERE m.token = ?`, t);
    if (!m) fail(404, "That link isn't valid. Ask JJ for your link.");
    c.member = m;
    return handler(c);
  };
}

async function wishesOf(env, memberId) {
  return all(env, 'SELECT id, text, url FROM wishes WHERE member_id = ? AND deleted_at IS NULL ORDER BY created_at, rowid', memberId);
}

async function receiverOf(env, m) {
  return one(env, 'SELECT r.* FROM assignments a JOIN members r ON r.id = a.receiver_id WHERE a.group_id = ? AND a.giver_id = ?', m.group_id, m.id);
}

async function santaOf(env, m) {
  return one(env, 'SELECT s.* FROM assignments a JOIN members s ON s.id = a.giver_id WHERE a.group_id = ? AND a.receiver_id = ?', m.group_id, m.id);
}

async function getMe(c) {
  const { env, member: m } = c;
  const now = nowIso();
  if (!m.link_opened_at) await q(env, 'UPDATE members SET link_opened_at = ? WHERE id = ?', now, m.id).run();
  const receiver = await receiverOf(env, m);
  const thread = await all(env,
    'SELECT id, kind, text, created_at, from_id FROM messages WHERE from_id = ? OR to_id = ? ORDER BY created_at', m.id, m.id);
  await q(env, 'UPDATE messages SET read_at = ? WHERE to_id = ? AND read_at IS NULL', now, m.id).run();
  const out = {
    group: {
      name: m.g_name, year: m.g_year, budget: m.g_budget, exchange_date: m.g_exchange,
      days_left: Math.max(0, daysBetween(ctDate(new Date()), m.g_exchange))
    },
    me: { id: m.id, name: m.name, confirmed_at: m.confirmed_at, revealed_at: m.revealed_at, wishes: await wishesOf(env, m.id) },
    receiver: receiver ? { name: receiver.name, wishes: await wishesOf(env, receiver.id) } : null,
    thread: thread.map(x => ({ id: x.id, kind: x.kind, text: x.text, created_at: x.created_at, mine: x.from_id === m.id })),
    revealed: !!m.revealed_at
  };
  if (m.g_reveal_all_at) {
    out.all_pairs = await all(env,
      `SELECT g.name AS giver, r.name AS receiver FROM assignments a
       JOIN members g ON g.id = a.giver_id JOIN members r ON r.id = a.receiver_id
       WHERE a.group_id = ? ORDER BY g.sort`, m.group_id);
  }
  return json(out);
}

async function reveal(c) {
  const { env, member: m } = c;
  const at = m.revealed_at || nowIso();
  if (!m.revealed_at) await q(env, 'UPDATE members SET revealed_at = ? WHERE id = ?', at, m.id).run();
  return json({ revealed_at: at });
}

async function putWishes(c) {
  const { env, member: m } = c;
  const list = c.body;
  if (!Array.isArray(list)) fail(400, 'Send the wish list as an array.');
  if (list.length > MAX_WISHES) fail(400, `Max ${MAX_WISHES} wishes.`);
  const rows = list.map(w => ({
    id: w && typeof w.id === 'string' ? w.id : null,
    text: text(w && w.text, 300, 'Wish') || fail(400, 'Every wish needs a description.'),
    url: cleanUrl(w && w.url)
  }));
  const existing = await wishesOf(env, m.id);
  const ids = new Set(existing.map(w => w.id));
  const keep = new Set();
  const now = nowIso();
  const stmts = [];
  let added = 0;
  for (const w of rows) {
    if (w.id && ids.has(w.id) && !keep.has(w.id)) {
      keep.add(w.id);
      stmts.push(q(env, 'UPDATE wishes SET text = ?, url = ? WHERE id = ?', w.text, w.url, w.id));
    } else {
      added++;
      stmts.push(q(env, 'INSERT INTO wishes (id, member_id, text, url, created_at) VALUES (?,?,?,?,?)',
        crypto.randomUUID(), m.id, w.text, w.url, now));
    }
  }
  for (const w of existing) if (!keep.has(w.id)) stmts.push(q(env, 'UPDATE wishes SET deleted_at = ? WHERE id = ?', now, w.id));
  if (rows.length) stmts.push(q(env, "DELETE FROM outbox WHERE member_id = ? AND kind = 'wish_nudge' AND sent_at IS NULL", m.id));
  if (added) {
    const santa = await santaOf(env, m);
    const since = new Date(Date.now() - 86400000).toISOString();
    const recent = santa && await one(env, "SELECT id FROM outbox WHERE member_id = ? AND kind = 'new_wish' AND created_at > ?", santa.id, since);
    if (santa && !recent) stmts.push(outboxStmt(env, santa, 'new_wish', newWishBody(memberLink(env, santa.token)), clampQuiet(new Date())));
  }
  await batch(env, stmts);
  return json({ wishes: await wishesOf(env, m.id) });
}

async function confirm(c) {
  const { env, member: m } = c;
  const at = m.confirmed_at || nowIso();
  await batch(env, [
    q(env, 'UPDATE members SET confirmed_at = ? WHERE id = ?', at, m.id),
    q(env, "DELETE FROM outbox WHERE member_id = ? AND kind = 'reminder' AND sent_at IS NULL", m.id)
  ]);
  return json({ confirmed_at: at });
}

async function unconfirm(c) {
  await q(c.env, 'UPDATE members SET confirmed_at = NULL WHERE id = ?', c.member.id).run();
  return json({ confirmed_at: null });
}

async function addMessage(c, kind, to) {
  const { env, member: m } = c;
  const t = text(c.body && c.body.text, 1000, 'Message') || fail(400, 'Type something first.');
  const id = crypto.randomUUID();
  const at = nowIso();
  const body = kind === 'question' ? questionBody(memberLink(env, to.token)) : answerBody(memberLink(env, to.token));
  await batch(env, [
    q(env, 'INSERT INTO messages (id, group_id, from_id, to_id, kind, text, created_at) VALUES (?,?,?,?,?,?,?)',
      id, m.group_id, m.id, to.id, kind, t, at),
    outboxStmt(env, to, kind, body, clampQuiet(new Date()))
  ]);
  return json({ id, kind, text: t, created_at: at, mine: true });
}

async function askQuestion(c) {
  const receiver = await receiverOf(c.env, c.member);
  if (!receiver) fail(400, "You don't have a giftee yet.");
  return addMessage(c, 'question', receiver);
}

async function answerQuestion(c) {
  const { env, member: m } = c;
  const mid = c.body && c.body.message_id;
  const qn = typeof mid === 'string' && await one(env, "SELECT * FROM messages WHERE id = ? AND to_id = ? AND kind = 'question'", mid, m.id);
  if (!qn) fail(404, "Couldn't find that question.");
  const asker = await one(env, 'SELECT * FROM members WHERE id = ?', qn.from_id);
  return addMessage(c, 'answer', asker);
}

// ---------- routes: admin ----------

function withAdmin(handler) {
  return async c => {
    const a = c.url.searchParams.get('a') || '';
    const g = /^[A-Za-z0-9]{24}$/.test(a) && await one(c.env, 'SELECT * FROM groups WHERE admin_token = ?', a);
    if (!g) fail(404, "That admin link isn't valid.");
    c.group = g;
    return handler(c);
  };
}

async function getAdmin(c) {
  const { env, group: g } = c;
  const members = await all(env,
    `SELECT m.*,
       (SELECT count(*) FROM wishes w WHERE w.member_id = m.id AND w.deleted_at IS NULL) AS wish_count,
       (SELECT count(*) FROM outbox o WHERE o.member_id = m.id AND o.sent_at IS NULL) AS pending_texts
     FROM members m WHERE m.group_id = ? ORDER BY m.sort`, g.id);
  const sent = await all(env,
    `SELECT o.member_id, o.kind, o.body, o.sent_at FROM outbox o JOIN members m ON m.id = o.member_id
     WHERE m.group_id = ? AND o.sent_at IS NOT NULL ORDER BY o.sent_at DESC`, g.id);
  const last = {};
  sent.forEach(s => { if (!last[s.member_id]) last[s.member_id] = { kind: s.kind, body: s.body, sent_at: s.sent_at }; });
  const out = {
    group: {
      id: g.id, name: g.name, year: g.year, budget: g.budget, exchange_date: g.exchange_date,
      days_left: Math.max(0, daysBetween(ctDate(new Date()), g.exchange_date)),
      reveal_all_at: g.reveal_all_at, created_at: g.created_at, admin_link: adminLink(env, g.admin_token)
    },
    members: members.map(m => ({
      id: m.id, name: m.name, phone: m.phone, link: memberLink(env, m.token),
      link_opened_at: m.link_opened_at, revealed_at: m.revealed_at, confirmed_at: m.confirmed_at,
      wish_count: m.wish_count, last_text: last[m.id] || null, pending_texts: m.pending_texts
    })),
    pending_texts: members.reduce((s, m) => s + m.pending_texts, 0),
    confirmed_count: members.filter(m => m.confirmed_at).length,
    can_redraw: !members.some(m => m.revealed_at)
  };
  if (c.url.searchParams.get('spoilers') === '1') {
    out.assignments = await all(env,
      `SELECT gv.name AS giver, r.name AS receiver FROM assignments a
       JOIN members gv ON gv.id = a.giver_id JOIN members r ON r.id = a.receiver_id
       WHERE a.group_id = ? ORDER BY gv.sort`, g.id);
  }
  return json(out);
}

async function groupMember(c) {
  const m = await one(c.env, 'SELECT * FROM members WHERE id = ? AND group_id = ?', c.params[0], c.group.id);
  if (!m) fail(404, 'No such person in this draw.');
  return m;
}

async function updateMember(c) {
  const { env } = c;
  const m = await groupMember(c);
  const b = c.body || {};
  const name = b.name !== undefined ? (text(b.name, 40, 'Name') || fail(400, 'Name can’t be empty.')) : m.name;
  const phone = b.phone !== undefined ? normalizePhone(b.phone) : m.phone;
  await q(env, 'UPDATE members SET name = ?, phone = ? WHERE id = ?', name, phone, m.id).run();
  return json({ id: m.id, name, phone });
}

async function resend(c) {
  const { env } = c;
  const m = await groupMember(c);
  if (!m.phone) fail(400, `${m.name} has no phone number. Add one first.`);
  await outboxStmt(env, m, 'resend', inviteBody(m.name, memberLink(env, m.token)), clampQuiet(new Date())).run();
  return json({ ok: true });
}

async function redraw(c) {
  const { env, group: g } = c;
  const members = await all(env, 'SELECT * FROM members WHERE group_id = ? ORDER BY sort', g.id);
  if (members.some(m => m.revealed_at)) fail(403, 'Someone already saw their name, so no redraw.');
  const rules = g.rules ? JSON.parse(g.rules) : { couples: [], no_repeat: true };
  const p = await runDraw(env, members, g.year, rules);
  await batch(env, [
    q(env, 'DELETE FROM outbox WHERE sent_at IS NULL AND member_id IN (SELECT id FROM members WHERE group_id = ?)', g.id)
  ].concat(drawStmts(env, g, members, p)));
  return json({ ok: true });
}

async function revealAll(c) {
  const at = c.group.reveal_all_at || nowIso();
  await q(c.env, 'UPDATE groups SET reveal_all_at = ? WHERE id = ?', at, c.group.id).run();
  return json({ reveal_all_at: at });
}

// ---------- routes: banjo ----------

function withBanjo(handler) {
  return c => {
    if (!safeEqual(c.req.headers.get('X-Banjo-Key') || '', c.env.BANJO_KEY || '')) fail(401, 'Bad Banjo key.');
    return handler(c);
  };
}

async function due(c) {
  const { env } = c;
  const now = new Date();
  await scheduleReminders(env.DB, now, env.PAGES_ORIGIN);
  const rows = await all(env,
    `SELECT o.id, o.kind, o.body, m.phone, m.name FROM outbox o
     JOIN members m ON m.id = o.member_id JOIN groups g ON g.id = m.group_id
     WHERE o.sent_at IS NULL AND o.due_at <= ? AND m.phone IS NOT NULL AND m.phone != ''
       AND NOT (o.kind IN ('reminder', 'wish_nudge') AND g.exchange_date <= ?)
     ORDER BY o.due_at, o.created_at LIMIT 20`, now.toISOString(), ctDate(now));
  return json(rows.map(r => ({ outbox_id: r.id, phone: r.phone, body: r.body, kind: r.kind, member: r.name })));
}

async function sent(c) {
  const ids = c.body && c.body.ids;
  if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some(x => typeof x !== 'string')) fail(400, 'Send {ids:[...]}.');
  const r = await q(c.env, `UPDATE outbox SET sent_at = ? WHERE sent_at IS NULL AND id IN (${ids.map(() => '?').join(',')})`,
    nowIso(), ...ids).run();
  return json({ updated: (r.meta && r.meta.changes) || 0 });
}

// ---------- router ----------

const ROUTES = [
  ['GET', /^\/health$/, () => json({ ok: true })],
  ['POST', /^\/groups$/, createGroup],
  ['GET', /^\/me$/, withMember(getMe)],
  ['POST', /^\/me\/reveal$/, withMember(reveal)],
  ['PUT', /^\/me\/wishes$/, withMember(putWishes)],
  ['POST', /^\/me\/confirm$/, withMember(confirm)],
  ['DELETE', /^\/me\/confirm$/, withMember(unconfirm)],
  ['POST', /^\/me\/question$/, withMember(askQuestion)],
  ['POST', /^\/me\/answer$/, withMember(answerQuestion)],
  ['GET', /^\/admin$/, withAdmin(getAdmin)],
  ['PUT', /^\/admin\/member\/([^/]+)$/, withAdmin(updateMember)],
  ['POST', /^\/admin\/resend\/([^/]+)$/, withAdmin(resend)],
  ['POST', /^\/admin\/redraw$/, withAdmin(redraw)],
  ['POST', /^\/admin\/reveal-all$/, withAdmin(revealAll)],
  ['GET', /^\/banjo\/due$/, withBanjo(due)],
  ['POST', /^\/banjo\/sent$/, withBanjo(sent)]
];

async function route(req, env) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  let pathMatched = false;
  for (const [method, re, handler] of ROUTES) {
    const match = path.match(re);
    if (!match) continue;
    pathMatched = true;
    if (method !== req.method) continue;
    const c = { req, env, url, params: match.slice(1).map(decodeURIComponent) };
    if (req.method === 'POST' || req.method === 'PUT') {
      const raw = await req.text();
      if (new TextEncoder().encode(raw).length > MAX_BODY) fail(413, 'That is too much text in one go (10KB max).');
      if (raw.trim()) {
        try { c.body = JSON.parse(raw); } catch (e) { fail(400, "That request wasn't valid JSON."); }
      }
    }
    return handler(c);
  }
  return pathMatched ? json({ error: 'Method not allowed.' }, 405) : json({ error: 'Not found.' }, 404);
}

export default {
  async fetch(req, env) {
    const cors = corsHeaders(req.headers.get('Origin'), env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    let res;
    try {
      res = await route(req, env);
    } catch (e) {
      if (!e.status) console.error(e && e.stack || e);
      res = json({ error: e.status ? e.message : 'Something broke on our end. Try again.' }, e.status || 500);
    }
    for (const k in cors) res.headers.set(k, cors[k]);
    return res;
  }
};
