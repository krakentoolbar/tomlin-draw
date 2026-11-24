// node worker/test.mjs  (Node >= 20, no dependencies; the API flow test needs node:sqlite, Node >= 22.5)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker, {
  drawNames, firstName, reminderDates, ctAt, ctDate, ctOffsetMinutes, clampQuiet, addDays,
  randomToken, inviteBody, reminderBody, normalizePhone, scheduleReminders, previewFromHtml, isPublicUrl
} from './src/index.js';

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('ok   ' + name); }
  catch (e) { console.log('FAIL ' + name + '\n     ' + (e.stack || e)); process.exitCode = 1; }
}

const FAMILY = ['JJ', 'Kait', 'Hewitt', 'Sonja', 'Micah', 'Lucas', 'Sarah'];
const HISTORY = [
  ['Hewitt', 'Kait'], ['JJ', 'Micah'], ['Kait', 'Lucas'], ['Lucas', 'Sarah'], ['Micah', 'Sonja'], ['Sarah', 'JJ'], ['Sonja', 'Hewitt'],
  ['Hewitt', 'JJ'], ['JJ', 'Lucas'], ['Kait', 'Sonja'], ['Lucas', 'Hewitt'], ['Micah', 'Kait'], ['Sarah', 'Micah'], ['Sonja', 'Sarah']
];

await test('derangement never self-assigns and is a permutation', () => {
  for (let i = 0; i < 500; i++) {
    const p = drawNames(FAMILY, new Set());
    p.forEach((r, g) => assert.notEqual(r, g));
    assert.equal(new Set(p).size, FAMILY.length);
  }
});

await test('respects couples + history forbidden pairs', () => {
  const f = new Set(HISTORY.map(([g, r]) => g.toLowerCase() + '|' + r.toLowerCase()));
  f.add('jj|kait'); f.add('kait|jj');
  for (let i = 0; i < 300; i++) {
    const p = drawNames(FAMILY, f);
    assert.ok(p, 'expected a valid draw');
    p.forEach((r, g) => assert.ok(!f.has(firstName(FAMILY[g]) + '|' + firstName(FAMILY[r]))));
  }
});

await test('impossible rules return null', () => {
  assert.equal(drawNames(['A'], new Set()), null);
  assert.equal(drawNames(['A', 'B'], new Set(['a|b'])), null);
  assert.equal(drawNames(['A', 'B', 'C'], new Set(['a|b', 'a|c'])), null);
});

await test('reminder dates for 2026-12-25', () => {
  const d = reminderDates('2026-12-25');
  assert.deepEqual(d.reminder.map(x => x.date),
    ['2026-12-01', '2026-12-08', '2026-12-15', '2026-12-18', '2026-12-20', '2026-12-22', '2026-12-23', '2026-12-24']);
  assert.deepEqual(d.wish_nudge.map(x => x.date), ['2026-12-01', '2026-12-06']);
  assert.equal(reminderDates('2026-12-24').reminder[0].date, '2026-11-30');
});

await test('10:00 CT on 2026-12-01 is 16:00Z (CST), 2026-07-01 is 15:00Z (CDT)', () => {
  assert.equal(ctAt('2026-12-01', 10).toISOString(), '2026-12-01T16:00:00.000Z');
  assert.equal(ctAt('2026-07-01', 10).toISOString(), '2026-07-01T15:00:00.000Z');
  assert.equal(ctOffsetMinutes(new Date('2026-12-01T16:00:00Z')), -360);
  assert.equal(ctOffsetMinutes(new Date('2026-07-01T15:00:00Z')), -300);
  assert.equal(ctAt('2026-11-01', 9).toISOString(), '2026-11-01T15:00:00.000Z'); // DST ends 2am that day
  assert.equal(ctDate(new Date('2026-12-02T03:00:00Z')), '2026-12-01');
});

await test('quiet hours clamp to 9a CT', () => {
  assert.equal(clampQuiet(new Date('2026-12-02T04:00:00Z')).toISOString(), '2026-12-02T15:00:00.000Z'); // 10p CT -> 9a next day
  assert.equal(clampQuiet(new Date('2026-12-02T12:00:00Z')).toISOString(), '2026-12-02T15:00:00.000Z'); // 6a CT -> 9a
  assert.equal(clampQuiet(new Date('2026-12-02T18:00:00Z')).toISOString(), '2026-12-02T18:00:00.000Z'); // noon stays
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});

await test('tokens, bodies, phones', () => {
  assert.match(randomToken(24), /^[A-Za-z0-9]{24}$/);
  assert.match(randomToken(12), /^[A-Za-z0-9]{12}$/);
  assert.equal(inviteBody('Hewitt', 'L'), "Hewitt, Tomlin Christmas draw is in. Tap to see who you got (don't share): L");
  assert.equal(reminderBody('Sonja', 10, 'L'), 'Sonja, friendly nudge: 10 days to Christmas. Tap "I bought it" once you\'re done: L');
  assert.match(reminderBody('Sonja', 1, 'L'), /^Sonja, last call: 1 day to/);
  assert.equal(normalizePhone('(615) 555-0100'), '+16155550100');
  assert.equal(normalizePhone(''), null);
  assert.throws(() => normalizePhone('123'));
});

const AMAZON_HTML = `<html><head><title>Amazon.com: Sony WH-1000XM5 Wireless Headphones : Electronics</title></head><body>
  <img alt="Sony" src="https://m.media-amazon.com/images/I/small.jpg" data-old-hires="https://m.media-amazon.com/images/I/big.jpg" id="landingImage">
  <script>var data = {"colorImages":{"initial":[{"hiRes":"https:\\/\\/m.media-amazon.com\\/images\\/I\\/hires.jpg"}]}}</script></body></html>`;

await test('previewFromHtml: Amazon-like page and generic og: page', () => {
  assert.deepEqual(previewFromHtml(AMAZON_HTML, 'https://www.amazon.com/dp/B0TEST?tag=x'),
    { title: 'Sony WH-1000XM5 Wireless Headphones', image: 'https://m.media-amazon.com/images/I/big.jpg', site: 'amazon.com' });
  const noHires = AMAZON_HTML.replace(/data-old-hires="[^"]*"/, '');
  assert.equal(previewFromHtml(noHires, 'https://amazon.com/dp/B0TEST').image, 'https://m.media-amazon.com/images/I/hires.jpg');
  const onlyImg = '<title>Lamp - Amazon.com</title><img src="https://m.media-amazon.com/l.jpg" id="landingImage">';
  assert.deepEqual(previewFromHtml(onlyImg, 'https://www.amazon.com/x'), { title: 'Lamp', image: 'https://m.media-amazon.com/l.jpg', site: 'amazon.com' });
  const og = `<head><title>Cozy Throw : Target</title><meta property="og:title" content="Cozy Throw &amp; Pillow Set">
    <meta content='/i/throw.png' property='og:image'></head>`;
  assert.deepEqual(previewFromHtml(og, 'https://www.target.com/p/x'),
    { title: 'Cozy Throw & Pillow Set', image: 'https://www.target.com/i/throw.png', site: 'target.com' });
  assert.equal(previewFromHtml('<title>Cozy Throw : Target</title>', 'https://www.target.com/p/x').title, 'Cozy Throw');
  assert.equal(previewFromHtml(`<title>${'x'.repeat(300)}</title>`, 'https://a.com').title.length, 120);
  assert.deepEqual(previewFromHtml('nothing here', 'https://shop.example.com/'), { title: null, image: null, site: 'shop.example.com' });
  assert.ok(isPublicUrl('https://www.amazon.com/dp/1') && isPublicUrl('http://8.8.8.8/'));
  for (const u of ['http://localhost/', 'http://127.0.0.1/', 'http://10.0.0.5/', 'http://192.168.1.1/', 'http://169.254.169.254/',
    'http://[::1]/', 'http://router/', 'ftp://a.com/', 'http://2130706433/', 'http://u:p@a.com/']) assert.equal(isPublicUrl(u), false, u);
});

// ---------- API flow against an in-memory D1 shim (node:sqlite) ----------
let sqlite = null;
try { sqlite = await import('node:sqlite'); } catch (e) { console.log('skip API flow (node:sqlite unavailable)'); }

function fakeD1() {
  const db = new sqlite.DatabaseSync(':memory:');
  const here = new URL('.', import.meta.url);
  db.exec(readFileSync(new URL('schema.sql', here), 'utf8'));
  db.exec(readFileSync(new URL('seed.sql', here), 'utf8'));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    first: async () => db.prepare(sql).get(...args) || null,
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } })
  });
  return {
    raw: db,
    prepare: sql => stmt(sql),
    batch: async list => { db.exec('BEGIN'); try { for (const s of list) await s.run(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } }
  };
}

// Link-preview fetches never leave the test: canned pages per URL, everything else 404s.
const PAGES = {
  'https://www.amazon.com/dp/B0TEST': AMAZON_HTML,
  'https://www.amazon.com/dp/B0NEW': '<title>Amazon.com: New Thing : Home</title>'
};
const fetched = [];
globalThis.fetch = async (url, init) => {
  fetched.push({ url: String(url), ua: init && init.headers && init.headers['User-Agent'] });
  const html = PAGES[String(url)];
  return html ? new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }) : new Response('no', { status: 503 });
};

if (sqlite) {
  const env = { DB: fakeD1(), PAGES_ORIGIN: 'https://krakentoolbar.github.io', BANJO_KEY: 'k' };
  const waits = [];
  const ctx = { waitUntil: p => waits.push(p) };
  const call = async (method, path, body, headers = {}) => {
    const res = await worker.fetch(new Request('https://w.test' + path, {
      method, headers: { 'Content-Type': 'application/json', Origin: 'https://krakentoolbar.github.io', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body)
    }), env, ctx);
    await Promise.all(waits.splice(0)); // let waitUntil work (previews) finish before asserting
    return { status: res.status, cors: res.headers.get('Access-Control-Allow-Origin'), data: await res.json() };
  };
  const fakePhone = i => '+1615555010' + i; // fictional 555-01xx range

  await test('API: create group, me, wishes, confirm, admin, banjo outbox', async () => {
    assert.deepEqual((await call('GET', '/health')).data, { ok: true });
    const g = await call('POST', '/groups', {
      name: 'Christmas 2026', year: 2026, exchange_date: '2026-12-25', budget: '$50', organizer_name: 'JJ',
      members: FAMILY.map((n, i) => ({ name: n, phone: i < 6 ? fakePhone(i) : '' })), couples: [['JJ', 'Kait']], no_repeat: true
    });
    assert.equal(g.status, 200, JSON.stringify(g.data));
    assert.equal(g.cors, 'https://krakentoolbar.github.io');
    assert.match(g.data.members[0].link, /^https:\/\/krakentoolbar\.github\.io\/tomlin-draw\/#r[A-Za-z0-9]{24}$/);
    const tok = Object.fromEntries(g.data.members.map(m => [m.name, m.token]));
    const a = g.data.admin_token;

    const spoil = (await call('GET', `/admin?a=${a}&spoilers=1`)).data;
    assert.equal(spoil.assignments.length, 7);
    const hist = new Set(HISTORY.map(([x, y]) => x + '|' + y).concat(['JJ|Kait', 'Kait|JJ']));
    spoil.assignments.forEach(p => assert.ok(!hist.has(p.giver + '|' + p.receiver) && p.giver !== p.receiver));
    const santaOfSonja = spoil.assignments.find(p => p.receiver === 'Sonja').giver;

    const me = (await call('GET', `/me?t=${tok.Sonja}`)).data;
    assert.equal(me.me.name, 'Sonja');
    assert.ok(me.receiver.name && me.group.days_left >= 0 && me.all_pairs === undefined);

    const w1 = await call('PUT', `/me/wishes?t=${tok.Sonja}`, [{ text: 'Socks' }, { text: 'Book', url: 'amazon.com/x' }]);
    assert.equal(w1.data.wishes.length, 2);
    assert.equal(w1.data.wishes[1].url, 'https://amazon.com/x');
    const w2 = await call('PUT', `/me/wishes?t=${tok.Sonja}`, [{ id: w1.data.wishes[0].id, text: 'Wool socks' }, { text: 'Candle' }]);
    assert.deepEqual(w2.data.wishes.map(w => w.text), ['Wool socks', 'Candle']);
    assert.equal(w2.data.wishes[0].id, w1.data.wishes[0].id);
    assert.equal((await call('PUT', `/me/wishes?t=${tok.Sonja}`, Array(31).fill({ text: 'x' }))).status, 400);
    const santaView = (await call('GET', `/me?t=${tok[santaOfSonja]}`)).data;
    assert.deepEqual(santaView.receiver.wishes.map(w => w.text), ['Wool socks', 'Candle']);

    const nw = env.DB.raw.prepare("SELECT count(*) n FROM outbox WHERE kind = 'new_wish'").get().n;
    assert.equal(nw, santaOfSonja === 'Sarah' ? 0 : 1, 'one new_wish per Santa per 24h');

    await call('POST', `/me/question?t=${tok.Sonja}`, { text: 'What size?' });
    const recv = (await call('GET', `/me?t=${tok[me.receiver.name]}`)).data;
    const qn = recv.thread.find(x => x.kind === 'question' && !x.mine);
    assert.ok(qn);
    assert.equal((await call('POST', `/me/answer?t=${tok[me.receiver.name]}`, { message_id: qn.id, text: 'M' })).status, 200);

    // Scheduler at a fixed "now": Nov 24 2026 noon CT schedules every future reminder + nudge once, idempotent.
    const db = env.DB;
    db.raw.prepare("UPDATE groups SET created_at = '2026-11-20T18:00:00.000Z'").run();
    const now = new Date('2026-11-24T18:00:00Z');
    await scheduleReminders(db, now);
    await scheduleReminders(db, now);
    const count = k => db.raw.prepare('SELECT count(*) n FROM outbox WHERE kind = ?').get(k).n;
    assert.equal(count('reminder'), 6 * 8);
    assert.equal(count('wish_nudge'), 5 * 2, 'Sonja has wishes, member 7 has no phone');
    const first = db.raw.prepare("SELECT due_at, body FROM outbox WHERE kind = 'reminder' ORDER BY due_at LIMIT 1").get();
    assert.equal(first.due_at, '2026-12-01T16:00:00.000Z');
    assert.match(first.body, /24 days to Christmas/);

    // Confirm cancels reminders; un-confirm lets the scheduler re-add them.
    await call('POST', `/me/confirm?t=${tok.JJ}`);
    const jjRem = () => db.raw.prepare("SELECT count(*) n FROM outbox o JOIN members m ON m.id = o.member_id WHERE m.name = 'JJ' AND kind = 'reminder'").get().n;
    assert.equal(jjRem(), 0);
    await scheduleReminders(db, now);
    assert.equal(jjRem(), 0);
    await call('DELETE', `/me/confirm?t=${tok.JJ}`);
    await scheduleReminders(db, now);
    assert.equal(jjRem(), 8);

    // After the exchange date nothing new is scheduled.
    const before = db.raw.prepare('SELECT count(*) n FROM outbox').get().n;
    await scheduleReminders(db, new Date('2026-12-26T18:00:00Z'));
    assert.equal(db.raw.prepare('SELECT count(*) n FROM outbox').get().n, before);

    assert.equal((await call('GET', '/banjo/due')).status, 401);
    const due = (await call('GET', '/banjo/due', undefined, { 'X-Banjo-Key': 'k' })).data;
    assert.ok(due.length >= 1 && due.length <= 20);
    assert.ok(due.every(r => r.phone && r.body && r.outbox_id && r.kind !== 'reminder'));
    const ack = (await call('POST', '/banjo/sent', { ids: due.map(r => r.outbox_id) }, { 'X-Banjo-Key': 'k' })).data;
    assert.equal(ack.updated, due.length);

    const adm = (await call('GET', `/admin?a=${a}`)).data;
    assert.equal(adm.assignments, undefined);
    assert.equal(adm.members.length, 7);
    assert.ok(adm.members.find(m => m.name === 'JJ').last_text);
    assert.equal(adm.can_redraw, true);

    assert.equal((await call('POST', `/admin/redraw?a=${a}`)).status, 200);
    assert.equal((await call('POST', `/admin/resend/${adm.members[0].id}?a=${a}`)).status, 200);
    assert.equal((await call('PUT', `/admin/member/${adm.members[6].id}?a=${a}`, { phone: fakePhone(6) })).data.phone, fakePhone(6));
    await call('POST', `/me/reveal?t=${tok.Sonja}`);
    assert.equal((await call('POST', `/admin/redraw?a=${a}`)).status, 403);
    await call('POST', `/admin/reveal-all?a=${a}`);
    assert.equal((await call('GET', `/me?t=${tok.Sonja}`)).data.all_pairs.length, 7);
    assert.equal(db.raw.prepare('SELECT count(*) n FROM history WHERE year = 2026').get().n, 7);

    assert.equal((await call('GET', '/me?t=nope')).status, 404);
    const big = await call('POST', '/groups', { name: 'x'.repeat(11000) });
    assert.equal(big.status, 413);
    const evil = await worker.fetch(new Request('https://w.test/health', { headers: { Origin: 'https://evil.example' } }), env);
    assert.equal(evil.headers.get('Access-Control-Allow-Origin'), null);
    const local = await worker.fetch(new Request('https://w.test/health', { method: 'OPTIONS', headers: { Origin: 'http://localhost:8080' } }), env);
    assert.equal(local.status, 204);
    assert.equal(local.headers.get('Access-Control-Allow-Origin'), 'http://localhost:8080');
  });

  await test('API: bought picks, extra gifts, family view visibility, previews', async () => {
    const db = env.DB.raw;
    const g = (await call('POST', '/groups', {
      name: 'Family test', year: 2027, exchange_date: '2027-12-25', members: FAMILY.map(n => ({ name: n }))
    })).data;
    const tok = Object.fromEntries(g.members.map(m => [m.name, m.token]));
    const pairs = (await call('GET', `/admin?a=${g.admin_token}&spoilers=1`)).data.assignments;
    const R = 'Sonja', S = pairs.find(p => p.receiver === R).giver;
    const [X, Y] = FAMILY.filter(n => n !== R && n !== S);
    const fam = async who => (await call('GET', `/family?t=${tok[who]}`)).data;
    const entry = async (who, of) => (await fam(who)).members.find(m => m.name === of);
    const wishBy = (list, t) => list.find(w => w.text === t);

    // Owner saves a list; the Worker previews the Amazon link, the blocked one waits for Banjo.
    const put = (await call('PUT', `/me/wishes?t=${tok[R]}`, [
      { text: 'Socks' }, { text: 'Headphones', url: 'https://www.amazon.com/dp/B0TEST' }, { text: 'Lamp', url: 'https://blocked.example/lamp' }
    ])).data.wishes;
    const id = Object.fromEntries(put.map(w => [w.text, w.id]));
    assert.ok(fetched.some(f => f.url === 'https://www.amazon.com/dp/B0TEST' && /iPhone/.test(f.ua)));
    const own = (await call('GET', `/me?t=${tok[R]}`)).data.me.wishes;
    assert.equal(wishBy(own, 'Headphones').preview_title, 'Sony WH-1000XM5 Wireless Headphones');
    assert.equal(wishBy(own, 'Headphones').preview_image, 'https://m.media-amazon.com/images/I/big.jpg');
    assert.equal(wishBy(own, 'Lamp').preview_title, null);
    const st = w => db.prepare('SELECT preview_status s, preview_tried t FROM wishes WHERE id = ?').get(id[w]);
    assert.deepEqual({ ...st('Lamp') }, { s: 'pending', t: 1 });
    assert.deepEqual({ ...st('Socks') }, { s: null, t: 0 });

    // Santa confirms a list item: hidden from the owner, "their Santa" to everyone else.
    const c1 = await call('POST', `/me/confirm?t=${tok[S]}`, { wish_id: id.Socks });
    assert.equal(c1.status, 200, JSON.stringify(c1.data));
    assert.deepEqual({ ...c1.data, confirmed_at: !!c1.data.confirmed_at }, { confirmed_at: true, bought_wish_id: id.Socks, bought_note: null });
    const ownView = await fam(R);
    const ownEntry = ownView.members.find(m => m.name === R);
    assert.equal(ownView.viewer_id, ownEntry.id);
    assert.deepEqual(Object.keys(ownView.group), ['name', 'year', 'budget', 'exchange_date', 'days_left']);
    assert.equal(ownEntry.confirmed, false);
    assert.ok(ownEntry.wishes.length === 3 && ownEntry.wishes.every(w => w.bought === null));
    assert.ok((await call('GET', `/me?t=${tok[R]}`)).data.me.wishes.every(w => !('bought' in w)));
    const xs = await entry(X, R);
    assert.equal(xs.confirmed, true);
    assert.deepEqual({ ...wishBy(xs.wishes, 'Socks').bought, at: 'x' }, { kind: 'santa', by_name: null, at: 'x' });
    assert.equal((await fam(X)).assignments, undefined);
    const santaMe = (await call('GET', `/me?t=${tok[S]}`)).data;
    assert.deepEqual(wishBy(santaMe.receiver.wishes, 'Socks').bought, { kind: 'santa', mine: true });
    assert.equal(santaMe.me.bought_wish_id, id.Socks);
    assert.equal(wishBy(santaMe.receiver.wishes, 'Headphones').preview_site, 'amazon.com');

    // A third member buys an extra list item: named to others, 409 if taken, 403 on own list.
    assert.equal((await call('POST', `/wish/${id.Socks}/bought?t=${tok[X]}`)).status, 409);
    assert.equal((await call('POST', `/wish/${id.Headphones}/bought?t=${tok[X]}`)).status, 200);
    assert.deepEqual({ ...wishBy((await entry(Y, R)).wishes, 'Headphones').bought, at: 'x' }, { kind: 'extra', by_name: X, at: 'x' });
    const taken = await call('POST', `/wish/${id.Headphones}/bought?t=${tok[Y]}`);
    assert.equal(taken.status, 409);
    assert.match(taken.data.error, new RegExp(X));
    assert.equal((await call('POST', `/wish/${id.Headphones}/bought?t=${tok[R]}`)).status, 403);
    assert.deepEqual(wishBy((await call('GET', `/me?t=${tok[S]}`)).data.receiver.wishes, 'Headphones').bought, { kind: 'extra', mine: false });
    assert.equal((await call('POST', `/me/confirm?t=${tok[S]}`, { wish_id: id.Headphones })).status, 409);

    // Extra gift that isn't on the list.
    assert.equal((await call('POST', `/wish/extra?t=${tok[X]}`, { member_id: ownView.viewer_id, text: 'Gift card' })).status, 200);
    const yView = await entry(Y, R);
    assert.equal(wishBy(yView.wishes, 'Gift card').on_list, false);
    assert.equal(wishBy(yView.wishes, 'Gift card').bought.by_name, X);
    assert.equal(wishBy((await entry(R, R)).wishes, 'Gift card'), undefined);
    assert.equal(wishBy((await call('GET', `/me?t=${tok[R]}`)).data.me.wishes, 'Gift card'), undefined);
    const xId = (await fam(X)).viewer_id;
    assert.equal((await call('POST', `/wish/extra?t=${tok[X]}`, { member_id: xId, text: 'Me' })).status, 403);

    // Owner full-replace: drops Socks (already bought), changes the Headphones url. Others' rows survive.
    const put2 = (await call('PUT', `/me/wishes?t=${tok[R]}`, [
      { id: id.Headphones, text: 'Headphones', url: 'https://www.amazon.com/dp/B0NEW' }, { id: id.Lamp, text: 'Lamp', url: 'https://blocked.example/lamp' }
    ])).data.wishes;
    assert.deepEqual(put2.map(w => w.text), ['Headphones', 'Lamp']);
    const hp = db.prepare('SELECT * FROM wishes WHERE id = ?').get(id.Headphones);
    assert.deepEqual([hp.preview_title, hp.preview_tried, hp.preview_status, hp.bought_by], ['New Thing', 1, 'ok', xId]);
    assert.deepEqual({ ...st('Lamp') }, { s: 'pending', t: 1 }, 'unchanged url keeps its preview state');
    const y2 = await entry(Y, R);
    assert.ok(wishBy(y2.wishes, 'Gift card'), 'rows added by others are not wiped');
    assert.equal(wishBy(y2.wishes, 'Socks').bought.kind, 'santa', 'owner deleting a bought item keeps it visible to others');

    // Santa switches to a note: Socks is released (and disappears, owner deleted it), a hidden note row appears.
    const c2 = (await call('POST', `/me/confirm?t=${tok[S]}`, { note: 'Spa day' })).data;
    assert.deepEqual([c2.bought_wish_id, c2.bought_note], [null, 'Spa day']);
    const y3 = await entry(Y, R);
    assert.equal(wishBy(y3.wishes, 'Socks'), undefined);
    assert.deepEqual([wishBy(y3.wishes, 'Spa day').on_list, wishBy(y3.wishes, 'Spa day').bought.kind, wishBy(y3.wishes, 'Spa day').bought.by_name],
      [false, 'santa', null]);
    assert.equal(wishBy((await entry(R, R)).wishes, 'Spa day'), undefined);
    assert.equal(wishBy((await call('GET', `/me?t=${tok[R]}`)).data.me.wishes, 'Spa day'), undefined);
    assert.equal((await call('POST', `/me/confirm?t=${tok[S]}`, { note: 'x'.repeat(201) })).status, 400);
    assert.equal((await call('POST', `/me/confirm?t=${tok[S]}`, { note: 'a', wish_id: id.Lamp })).status, 400);
    assert.equal((await call('POST', `/me/confirm?t=${tok[S]}`, { wish_id: 'nope' })).status, 404);

    // Un-confirm reverses the note case...
    assert.deepEqual((await call('DELETE', `/me/confirm?t=${tok[S]}`)).data, { confirmed_at: null, bought_wish_id: null, bought_note: null });
    const y4 = await entry(Y, R);
    assert.equal(wishBy(y4.wishes, 'Spa day'), undefined);
    assert.equal(y4.confirmed, false);
    // ...and the list-item case.
    await call('POST', `/me/confirm?t=${tok[S]}`, { wish_id: id.Lamp });
    assert.equal(wishBy((await entry(Y, R)).wishes, 'Lamp').bought.kind, 'santa');
    const adm = (await call('GET', `/admin?a=${g.admin_token}`)).data.members.find(m => m.name === S);
    assert.deepEqual([adm.bought_wish, adm.bought_note], ['Lamp', null]);
    assert.equal((await call('GET', `/admin?a=${g.admin_token}`)).data.members.find(m => m.name === R).wish_count, 2);
    await call('DELETE', `/me/confirm?t=${tok[S]}`);
    assert.equal(wishBy((await entry(Y, R)).wishes, 'Lamp').bought, null);
    assert.equal(db.prepare('SELECT bought_by FROM wishes WHERE id = ?').get(id.Lamp).bought_by, null);

    // Extra buyer undoes: list item goes back, their own extra row goes away. Only the buyer can undo.
    assert.equal((await call('DELETE', `/wish/${id.Headphones}/bought?t=${tok[Y]}`)).status, 409);
    await call('DELETE', `/wish/${id.Headphones}/bought?t=${tok[X]}`);
    const gc = wishBy((await entry(Y, R)).wishes, 'Gift card').id;
    await call('DELETE', `/wish/${gc}/bought?t=${tok[X]}`);
    const y5 = await entry(Y, R);
    assert.equal(wishBy(y5.wishes, 'Headphones').bought, null);
    assert.equal(wishBy(y5.wishes, 'Gift card'), undefined);

    // Banjo picks up what the Worker couldn't preview, from a home IP.
    assert.equal((await call('GET', '/banjo/previews')).status, 401);
    const todo = (await call('GET', '/banjo/previews', undefined, { 'X-Banjo-Key': 'k' })).data;
    assert.deepEqual(todo.filter(r => r.wish_id === id.Lamp), [{ wish_id: id.Lamp, url: 'https://blocked.example/lamp' }]);
    const saved = (await call('POST', '/banjo/previews', { results: [
      { wish_id: id.Lamp, ok: true, title: 'Brass Desk Lamp | Blocked', image: '/img/lamp.jpg', site: 'blocked.example' }
    ] }, { 'X-Banjo-Key': 'k' })).data;
    assert.equal(saved.updated, 1);
    const lamp = wishBy((await call('GET', `/me?t=${tok[R]}`)).data.me.wishes, 'Lamp');
    assert.deepEqual([lamp.preview_title, lamp.preview_image, lamp.preview_site], ['Brass Desk Lamp', 'https://blocked.example/img/lamp.jpg', 'blocked.example']);
    // A link that keeps failing: Banjo gets 3 tries, then it's 'failed' and drops out of the queue.
    await call('PUT', `/me/wishes?t=${tok[X]}`, [{ text: 'Mug', url: 'https://nope.example/mug' }]);
    const mug = db.prepare("SELECT id FROM wishes WHERE text = 'Mug'").get().id;
    for (let i = 0; i < 3; i++) {
      assert.ok((await call('GET', '/banjo/previews', undefined, { 'X-Banjo-Key': 'k' })).data.some(r => r.wish_id === mug));
      await call('POST', '/banjo/previews', { results: [{ wish_id: mug, ok: false }] }, { 'X-Banjo-Key': 'k' });
    }
    assert.equal(db.prepare('SELECT preview_status s FROM wishes WHERE id = ?').get(mug).s, 'failed');
    assert.ok(!(await call('GET', '/banjo/previews', undefined, { 'X-Banjo-Key': 'k' })).data.some(r => r.wish_id === mug));
    // No url -> no preview state; clearing a url clears it.
    await call('PUT', `/me/wishes?t=${tok[X]}`, [{ id: mug, text: 'Mug' }]);
    assert.equal(db.prepare('SELECT preview_status s FROM wishes WHERE id = ?').get(mug).s, null);
  });

  await test('migration 001 applies cleanly to the old schema', () => {
    const here = new URL('.', import.meta.url);
    const schema = readFileSync(new URL('schema.sql', here), 'utf8');
    const migration = readFileSync(new URL('migrations/001-bought-family-previews.sql', here), 'utf8');
    const NEW = ['added_by', 'bought_by', 'bought_at', 'bought_kind', 'preview_title', 'preview_image', 'preview_site',
      'preview_status', 'preview_tried', 'bought_wish_id', 'bought_note'];
    const old = schema.split('\n').filter(l => !NEW.some(c => l.trim().startsWith(c + ' '))).join('\n').replace(/,\s*\n\);/g, '\n);');
    const db = new sqlite.DatabaseSync(':memory:');
    db.exec(old);
    const cols = (d, t) => d.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name).sort();
    assert.ok(!cols(db, 'wishes').includes('bought_by') && !cols(db, 'members').includes('bought_note'), 'old schema rebuilt');
    db.exec("INSERT INTO groups VALUES ('g1','X',2026,'2026-12-25',NULL,'a',NULL,NULL,'2026-11-01')");
    db.exec("INSERT INTO members (id, group_id, name, token, sort) VALUES ('m1','g1','Sonja','t',0)");
    db.exec("INSERT INTO wishes (id, member_id, text, url, created_at) VALUES ('w1','m1','Book','https://a.com/b','2026-11-01'), ('w2','m1','Socks',NULL,'2026-11-01')");
    const stmts = migration.split('\n').filter(l => !l.trim().startsWith('--')).join('\n').split(';').map(x => x.trim()).filter(Boolean);
    assert.equal(stmts.filter(x => /^ALTER TABLE/.test(x)).length, NEW.length);
    for (const x of stmts) db.exec(x);
    const fresh = new sqlite.DatabaseSync(':memory:');
    fresh.exec(schema);
    for (const t of ['wishes', 'members']) assert.deepEqual(cols(db, t), cols(fresh, t));
    assert.deepEqual(db.prepare("SELECT id, preview_status, preview_tried FROM wishes ORDER BY id").all().map(r => ({ ...r })),
      [{ id: 'w1', preview_status: 'pending', preview_tried: 1 }, { id: 'w2', preview_status: null, preview_tried: 0 }]);
    assert.throws(() => db.exec("UPDATE wishes SET bought_kind = 'nope'"));
    db.exec(schema); // re-running schema.sql on a migrated DB is a no-op
  });
}

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
