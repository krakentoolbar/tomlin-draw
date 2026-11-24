// node worker/test.mjs  (Node >= 20, no dependencies; the API flow test needs node:sqlite, Node >= 22.5)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker, {
  drawNames, firstName, reminderDates, ctAt, ctDate, ctOffsetMinutes, clampQuiet, addDays,
  randomToken, inviteBody, reminderBody, normalizePhone, scheduleReminders
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

if (sqlite) {
  const env = { DB: fakeD1(), PAGES_ORIGIN: 'https://krakentoolbar.github.io', BANJO_KEY: 'k' };
  const call = async (method, path, body, headers = {}) => {
    const res = await worker.fetch(new Request('https://w.test' + path, {
      method, headers: { 'Content-Type': 'application/json', Origin: 'https://krakentoolbar.github.io', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body)
    }), env);
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
}

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
