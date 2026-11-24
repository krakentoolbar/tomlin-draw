// Tomlin Draw v2 Worker: D1 state, draw, wish lists, outbox for Banjo's texts. See ../SPEC.md.

const REMINDER_DAYS = [24, 17, 10, 7, 5, 3, 2, 1];
const NUDGE_DAYS = [24, 19];
const MAX_BODY = 10240;
const MAX_WISHES = 30;
const DRAW_TRIES = 5000;
const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const PREVIEW_MAX_BYTES = 400 * 1024;
const PREVIEW_TIMEOUT_MS = 6000;
const PREVIEW_MAX_TRIES = 4; // 1 Worker try + up to 3 Banjo tries
const PREVIEW_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

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

// ---------- link previews (pure parts exported for test.mjs) ----------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (m, e) => {
    e = e.toLowerCase();
    if (e[0] !== '#') return ENTITIES[e];
    const n = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    try { return String.fromCodePoint(n); } catch (x) { return m; }
  });
}

function attrs(tag) {
  const o = {};
  for (const m of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g))
    o[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  return o;
}

function absUrl(v, base) {
  if (!v) return null;
  try {
    const u = new URL(String(v).trim().replace(/\\\//g, '/'), base);
    return /^https?:$/.test(u.protocol) ? u.href.slice(0, 1000) : null;
  } catch (e) { return null; }
}

const alnum = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const isAmazon = host => /(^|\.)amazon\.[a-z.]+$|(^|\.)amzn\.(to|com)$/.test(host);

// "target.com" -> "target", "shop.lego.com" -> "lego", "argos.co.uk" -> "argos"
function siteLabel(site) {
  const parts = String(site || '').split('.');
  const i = parts.length >= 3 && /^(co|com|org|net)$/.test(parts[parts.length - 2]) ? parts.length - 3 : parts.length - 2;
  return parts[Math.max(0, i)] || '';
}

function cleanTitle(t, site) {
  t = String(t || '').replace(/\s+/g, ' ').trim();
  if (isAmazon(site)) {
    const prefixed = /^amazon(\.[a-z.]+)?\s*:\s*/i.test(t);
    t = t.replace(/^amazon(\.[a-z.]+)?\s*:\s*/i, '').replace(/\s+[:|\u2013\u2014-]\s+amazon\.[a-z.]+(\s+:\s+.*)?$/i, '');
    if (prefixed) t = t.replace(/\s+:\s+[^:]{1,40}$/, ''); // "Amazon.com: Thing : Electronics"
  }
  const label = alnum(siteLabel(site));
  if (label.length >= 3) {
    for (let i = 0; i < 2; i++) {
      const m = t.match(/^(.*\S)\s+[|:\u2013\u2014-]\s+([^|:\u2013\u2014]{1,40})$/);
      if (m && alnum(m[2]).includes(label)) t = m[1];
    }
    const lead = t.match(/^([^|:]{1,30})\s*[|:]\s+(.+)$/);
    if (lead && alnum(lead[1]).includes(label)) t = lead[2];
  }
  return t.length > 120 ? t.slice(0, 119).trimEnd() + '\u2026' : t;
}

const JUNK_TITLE = /robot check|captcha|are you a human|access denied|page not found|404|just a moment|attention required|something went wrong|spend less\. smile more|^sign in/i;
function usableTitle(title, site) {
  return !!title && title.length >= 2 && !JUNK_TITLE.test(title) && alnum(title) !== alnum(site) && alnum(title) !== alnum(siteLabel(site));
}

export function previewFromHtml(html, url) {
  html = String(html || '');
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch (e) {}
  const site = host.replace(/^www\./, '') || null;
  const meta = {};
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    const k = (a.property || a.name || '').toLowerCase();
    if (k && a.content && !(k in meta)) meta[k] = a.content.trim();
  }
  let title = meta['og:title'] || meta['twitter:title'] || '';
  if (!title) { const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i); if (t) title = decodeEntities(t[1]); }
  let image = meta['og:image:secure_url'] || meta['og:image'] || meta['twitter:image'] || null;
  if (!image && isAmazon(host)) {
    const m = html.match(/data-old-hires="(https?:[^"]+)"/i) || html.match(/"hiRes":"(https?:[^"]+)"/) || html.match(/"large":"(https?:[^"]+)"/);
    if (m) image = m[1];
  }
  if (!image) {
    const tag = (html.match(/<img\b[^>]*\bid=["']?landingImage\b[^>]*>/i) || [])[0];
    if (tag) image = attrs(tag).src || null;
  }
  title = cleanTitle(title, site);
  return { title: title || null, image: absUrl(image, url), site };
}

// Only public http(s) hosts: no loopback, private ranges, link-local, or bare intranet names.
export function isPublicUrl(u) {
  let x;
  try { x = new URL(u); } catch (e) { return false; }
  if (!/^https?:$/.test(x.protocol) || x.username || x.password) return false;
  const h = x.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h.includes(':')) return !/^(::1?$|::ffff:|f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:)/.test(h);
  if (!h.includes('.') || /(^|\.)(localhost|local|internal|lan|home\.arpa)$/.test(h)) return false;
  const v4 = h.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (!v4) return true;
  const a = +v4[1], b = +v4[2];
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127));
}

async function readCapped(res, max) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let out = '', n = 0;
  while (n < max) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value.subarray(0, max - n);
    n += chunk.length;
    out += dec.decode(chunk, { stream: true });
  }
  reader.cancel().catch(() => {});
  return out + dec.decode();
}

// {title, image, site} with a usable title, or null. Never throws.
export async function fetchPreview(url) {
  if (!isPublicUrl(url)) return null;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PREVIEW_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': PREVIEW_UA, 'Accept-Language': 'en-US' }, redirect: 'follow', cf: { cacheTtl: 0 }, signal: ac.signal
    });
    if (!res.ok || !/html/i.test(res.headers.get('Content-Type') || 'text/html')) { if (res.body) res.body.cancel().catch(() => {}); return null; }
    const p = previewFromHtml(await readCapped(res, PREVIEW_MAX_BYTES), res.url || url);
    return usableTitle(p.title, p.site) ? p : null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
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
      `SELECT m.*, (SELECT count(*) FROM wishes w WHERE w.member_id = m.id AND w.added_by IS NULL AND w.deleted_at IS NULL) AS wish_count
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

// The owner's own rows. Rows other people added (Santa notes, extra gifts) never reach the owner.
async function wishesOf(env, memberId) {
  return all(env, `SELECT id, text, url, preview_title, preview_image, preview_site FROM wishes
    WHERE member_id = ? AND added_by IS NULL AND deleted_at IS NULL ORDER BY created_at, rowid`, memberId);
}

// A list as everyone EXCEPT its owner sees it: incl. rows others added, and rows the owner deleted after they were bought.
async function listRows(env, where, ...args) {
  return all(env, `SELECT w.*, b.name AS buyer_name FROM wishes w LEFT JOIN members b ON b.id = w.bought_by
    WHERE ${where} AND (w.deleted_at IS NULL OR w.bought_by IS NOT NULL) ORDER BY w.created_at, w.rowid`, ...args);
}

const wishOut = (w, bought) => ({
  id: w.id, text: w.text, url: w.url, preview_title: w.preview_title, preview_image: w.preview_image,
  preview_site: w.preview_site, on_list: !w.added_by, bought
});

function groupOut(m) {
  return {
    name: m.g_name, year: m.g_year, budget: m.g_budget, exchange_date: m.g_exchange,
    days_left: Math.max(0, daysBetween(ctDate(new Date()), m.g_exchange))
  };
}

// Fetch previews for up to 3 of a member's untried links. Runs after the response via waitUntil when available.
async function refreshPreviews(env, memberId) {
  const rows = await all(env, `SELECT id, url FROM wishes WHERE member_id = ? AND preview_status = 'pending' AND preview_tried = 0
    AND deleted_at IS NULL ORDER BY created_at, rowid LIMIT 3`, memberId);
  await Promise.all(rows.map(async w => {
    const p = await fetchPreview(w.url);
    if (p) await q(env, `UPDATE wishes SET preview_title = ?, preview_image = ?, preview_site = ?, preview_status = 'ok',
      preview_tried = preview_tried + 1 WHERE id = ? AND url = ?`, p.title, p.image, p.site, w.id, w.url).run();
    else await q(env, 'UPDATE wishes SET preview_tried = preview_tried + 1 WHERE id = ? AND url = ?', w.id, w.url).run();
  }));
}

function inBackground(c, job) {
  const p = job.catch(e => console.error('preview', e && e.stack || e));
  if (c.ctx && typeof c.ctx.waitUntil === 'function') return c.ctx.waitUntil(p);
  return p;
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
  const recvWishes = receiver ? await listRows(env, 'w.member_id = ?', receiver.id) : [];
  const out = {
    group: groupOut(m),
    me: {
      id: m.id, name: m.name, confirmed_at: m.confirmed_at, revealed_at: m.revealed_at,
      bought_wish_id: m.bought_wish_id, bought_note: m.bought_note, wishes: await wishesOf(env, m.id)
    },
    receiver: receiver ? {
      name: receiver.name,
      wishes: recvWishes.map(w => wishOut(w, w.bought_kind ? { kind: w.bought_kind, mine: w.bought_by === m.id } : null))
    } : null,
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
  const byId = new Map(existing.map(w => [w.id, w]));
  const keep = new Set();
  const now = nowIso();
  const stmts = [];
  let added = 0;
  for (const w of rows) {
    if (w.id && byId.has(w.id) && !keep.has(w.id)) {
      keep.add(w.id);
      if (byId.get(w.id).url === w.url) stmts.push(q(env, 'UPDATE wishes SET text = ? WHERE id = ?', w.text, w.id));
      else stmts.push(q(env, `UPDATE wishes SET text = ?, url = ?, preview_title = NULL, preview_image = NULL, preview_site = NULL,
        preview_status = ?, preview_tried = 0 WHERE id = ?`, w.text, w.url, w.url ? 'pending' : null, w.id));
    } else {
      added++;
      stmts.push(q(env, 'INSERT INTO wishes (id, member_id, text, url, created_at, preview_status) VALUES (?,?,?,?,?,?)',
        crypto.randomUUID(), m.id, w.text, w.url, now, w.url ? 'pending' : null));
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
  await inBackground(c, refreshPreviews(env, m.id));
  return json({ wishes: await wishesOf(env, m.id) });
}

// Undo this Santa's current pick: soft-delete a note row they created, un-mark a list item. keepId survives.
function clearPickStmts(env, m, now, keepId = '') {
  return [
    q(env, `UPDATE wishes SET deleted_at = ?, bought_by = NULL, bought_at = NULL, bought_kind = NULL
      WHERE bought_by = ? AND bought_kind = 'santa' AND added_by = ? AND id != ?`, now, m.id, m.id, keepId),
    q(env, "UPDATE wishes SET bought_by = NULL, bought_at = NULL, bought_kind = NULL WHERE bought_by = ? AND bought_kind = 'santa' AND id != ?",
      m.id, keepId)
  ];
}

// Body (optional): {wish_id} = an item on the receiver's list, or {note} = what they got instead.
async function confirm(c) {
  const { env, member: m } = c;
  const b = c.body || {};
  const now = nowIso();
  const at = m.confirmed_at || now;
  if (b.wish_id != null && typeof b.wish_id !== 'string') fail(400, 'wish_id should be text.');
  const wishId = b.wish_id || null;
  const note = text(b.note, 200, 'Note');
  if (wishId && note) fail(400, 'Pick a list item or type what you got, not both.');
  const stmts = [q(env, "DELETE FROM outbox WHERE member_id = ? AND kind = 'reminder' AND sent_at IS NULL", m.id)];
  let out = { confirmed_at: at, bought_wish_id: m.bought_wish_id, bought_note: m.bought_note };
  if (wishId || note) {
    const receiver = await receiverOf(env, m);
    if (!receiver) fail(400, "You don't have a giftee yet.");
    if (wishId) {
      const w = await one(env, 'SELECT * FROM wishes WHERE id = ? AND member_id = ? AND deleted_at IS NULL', wishId, receiver.id);
      if (!w) fail(404, "That item isn't on your person's list anymore.");
      if (w.bought_by && w.bought_by !== m.id) fail(409, 'Someone already bought that one. Pick another, or type what you got.');
      stmts.push(...clearPickStmts(env, m, now, w.id),
        q(env, "UPDATE wishes SET bought_by = ?, bought_at = ?, bought_kind = 'santa' WHERE id = ?", m.id, now, w.id));
      out = { confirmed_at: at, bought_wish_id: w.id, bought_note: null };
    } else {
      stmts.push(...clearPickStmts(env, m, now),
        q(env, `INSERT INTO wishes (id, member_id, text, created_at, added_by, bought_by, bought_at, bought_kind)
          VALUES (?,?,?,?,?,?,?,'santa')`, crypto.randomUUID(), receiver.id, note, now, m.id, m.id, now));
      out = { confirmed_at: at, bought_wish_id: null, bought_note: note };
    }
  }
  stmts.push(q(env, 'UPDATE members SET confirmed_at = ?, bought_wish_id = ?, bought_note = ? WHERE id = ?',
    at, out.bought_wish_id, out.bought_note, m.id));
  await batch(env, stmts);
  return json(out);
}

async function unconfirm(c) {
  const { env, member: m } = c;
  await batch(env, clearPickStmts(env, m, nowIso()).concat(
    q(env, 'UPDATE members SET confirmed_at = NULL, bought_wish_id = NULL, bought_note = NULL WHERE id = ?', m.id)));
  return json({ confirmed_at: null, bought_wish_id: null, bought_note: null });
}

// ---------- routes: family view + extra gifts ----------

async function getFamily(c) {
  const { env, member: me } = c;
  const members = await all(env,
    `SELECT m.id, m.name, s.confirmed_at AS santa_confirmed FROM members m
     LEFT JOIN assignments a ON a.group_id = m.group_id AND a.receiver_id = m.id
     LEFT JOIN members s ON s.id = a.giver_id
     WHERE m.group_id = ? ORDER BY m.sort`, me.group_id);
  const rows = await listRows(env, 'w.member_id IN (SELECT id FROM members WHERE group_id = ? AND id != ?)', me.group_id, me.id);
  const own = await wishesOf(env, me.id);
  return json({
    group: groupOut(me),
    viewer_id: me.id,
    members: members.map(x => x.id === me.id
      ? { id: x.id, name: x.name, confirmed: false, wishes: own.map(w => wishOut(w, null)) }
      : {
        id: x.id, name: x.name, confirmed: !!x.santa_confirmed,
        wishes: rows.filter(w => w.member_id === x.id).map(w => wishOut(w, w.bought_kind
          ? { kind: w.bought_kind, by_name: w.bought_kind === 'extra' ? w.buyer_name : null, at: w.bought_at } : null))
      })
  });
}

async function groupWish(c) {
  const { env, member: m } = c;
  const w = await one(env,
    `SELECT w.*, b.name AS buyer_name FROM wishes w JOIN members o ON o.id = w.member_id LEFT JOIN members b ON b.id = w.bought_by
     WHERE w.id = ? AND o.group_id = ? AND (w.deleted_at IS NULL OR w.bought_by = ?)`, c.params[0], m.group_id, m.id);
  if (!w) fail(404, "Couldn't find that item.");
  if (w.member_id === m.id) fail(403, "That's your own list. No peeking.");
  return w;
}

async function markBought(c) {
  const { env, member: m } = c;
  const w = await groupWish(c);
  if (w.bought_by && w.bought_by !== m.id)
    fail(409, w.bought_kind === 'santa' ? 'Their Santa already got that one.' : `${w.buyer_name || 'Someone'} already got that one.`);
  if (!w.bought_by) await q(env, "UPDATE wishes SET bought_by = ?, bought_at = ?, bought_kind = 'extra' WHERE id = ?", m.id, nowIso(), w.id).run();
  return getFamily(c);
}

async function unmarkBought(c) {
  const { env, member: m } = c;
  const w = await groupWish(c);
  if (w.bought_by !== m.id) fail(409, "You didn't mark that one.");
  if (w.bought_kind === 'santa') fail(409, 'That is your Santa gift. Undo it from your own page.');
  // An extra gift I added myself goes away entirely; a list item just goes back to unbought.
  await q(env, `UPDATE wishes SET bought_by = NULL, bought_at = NULL, bought_kind = NULL,
    deleted_at = CASE WHEN added_by = ? THEN ? ELSE deleted_at END WHERE id = ?`, m.id, nowIso(), w.id).run();
  return getFamily(c);
}

// Body {member_id, text, url?}: a gift that isn't on their list, bought by me.
async function addExtra(c) {
  const { env, member: m } = c;
  const b = c.body || {};
  const target = typeof b.member_id === 'string' && await one(env, 'SELECT * FROM members WHERE id = ? AND group_id = ?', b.member_id, m.group_id);
  if (!target) fail(404, 'No such person in this draw.');
  if (target.id === m.id) fail(403, "You can't add gifts to your own list.");
  const t = text(b.text, 300, 'Gift') || fail(400, 'Say what you got them.');
  const url = cleanUrl(b.url);
  const now = nowIso();
  await q(env, `INSERT INTO wishes (id, member_id, text, url, created_at, added_by, bought_by, bought_at, bought_kind, preview_status)
    VALUES (?,?,?,?,?,?,?,?,'extra',?)`, crypto.randomUUID(), target.id, t, url, now, m.id, m.id, now, url ? 'pending' : null).run();
  if (url) await inBackground(c, refreshPreviews(env, target.id));
  return getFamily(c);
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
       (SELECT count(*) FROM wishes w WHERE w.member_id = m.id AND w.added_by IS NULL AND w.deleted_at IS NULL) AS wish_count,
       (SELECT text FROM wishes w WHERE w.id = m.bought_wish_id) AS bought_wish,
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
      wish_count: m.wish_count, bought_wish: m.bought_wish, bought_note: m.bought_note, last_text: last[m.id] || null, pending_texts: m.pending_texts
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

// Links the Worker couldn't preview (Amazon blocks datacenter IPs); Banjo retries from a home IP.
async function pendingPreviews(c) {
  const rows = await all(c.env, `SELECT id, url FROM wishes WHERE preview_status = 'pending' AND preview_tried BETWEEN 1 AND ?
    AND url IS NOT NULL AND deleted_at IS NULL ORDER BY created_at, rowid LIMIT 10`, PREVIEW_MAX_TRIES - 1);
  return json(rows.map(r => ({ wish_id: r.id, url: r.url })));
}

// Body {results:[{wish_id, title, image, site, ok}]}. ok:false (or an unusable title) counts a try; the 4th failed try = 'failed'.
async function savePreviews(c) {
  const { env } = c;
  const list = c.body && c.body.results;
  if (!Array.isArray(list) || !list.length || list.length > 50) fail(400, 'Send {results:[...]}.');
  let updated = 0;
  for (const r of list) {
    if (!r || typeof r.wish_id !== 'string') fail(400, 'Every result needs a wish_id.');
    const w = await one(env, "SELECT id, url FROM wishes WHERE id = ? AND preview_status = 'pending' AND preview_tried >= 1", r.wish_id);
    if (!w) continue;
    const site = (typeof r.site === 'string' && r.site.trim().slice(0, 100)) || previewFromHtml('', w.url).site;
    const title = r.ok && typeof r.title === 'string' ? cleanTitle(r.title.slice(0, 2000), site) : '';
    if (usableTitle(title, site)) {
      await q(env, `UPDATE wishes SET preview_title = ?, preview_image = ?, preview_site = ?, preview_status = 'ok',
        preview_tried = preview_tried + 1 WHERE id = ?`, title, absUrl(r.image, w.url), site, w.id).run();
    } else {
      await q(env, `UPDATE wishes SET preview_tried = preview_tried + 1,
        preview_status = CASE WHEN preview_tried + 1 >= ? THEN 'failed' ELSE 'pending' END WHERE id = ?`, PREVIEW_MAX_TRIES, w.id).run();
    }
    updated++;
  }
  return json({ updated });
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
  ['GET', /^\/family$/, withMember(getFamily)],
  ['POST', /^\/wish\/extra$/, withMember(addExtra)],
  ['POST', /^\/wish\/([^/]+)\/bought$/, withMember(markBought)],
  ['DELETE', /^\/wish\/([^/]+)\/bought$/, withMember(unmarkBought)],
  ['GET', /^\/admin$/, withAdmin(getAdmin)],
  ['PUT', /^\/admin\/member\/([^/]+)$/, withAdmin(updateMember)],
  ['POST', /^\/admin\/resend\/([^/]+)$/, withAdmin(resend)],
  ['POST', /^\/admin\/redraw$/, withAdmin(redraw)],
  ['POST', /^\/admin\/reveal-all$/, withAdmin(revealAll)],
  ['GET', /^\/banjo\/due$/, withBanjo(due)],
  ['POST', /^\/banjo\/sent$/, withBanjo(sent)],
  ['GET', /^\/banjo\/previews$/, withBanjo(pendingPreviews)],
  ['POST', /^\/banjo\/previews$/, withBanjo(savePreviews)]
];

async function route(req, env, ctx) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  let pathMatched = false;
  for (const [method, re, handler] of ROUTES) {
    const match = path.match(re);
    if (!match) continue;
    pathMatched = true;
    if (method !== req.method) continue;
    const c = { req, env, ctx, url, params: match.slice(1).map(decodeURIComponent) };
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
  async fetch(req, env, ctx) {
    const cors = corsHeaders(req.headers.get('Origin'), env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    let res;
    try {
      res = await route(req, env, ctx);
    } catch (e) {
      if (!e.status) console.error(e && e.stack || e);
      res = json({ error: e.status ? e.message : 'Something broke on our end. Try again.' }, e.status || 500);
    }
    for (const k in cors) res.headers.set(k, cors[k]);
    return res;
  }
};
