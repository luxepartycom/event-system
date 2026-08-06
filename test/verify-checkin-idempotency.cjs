// 検証ハーネス 層1.5（実コード実行）: gas/コード.js を Node 上で読み込み、
// SpreadsheetApp / LockService / ContentService を偽物に差し替えて doPost('checkIn') を直接叩く。
// ロジックを書き写して検証すると「写し間違い」を検証できないので、必ず実コードを走らせる。
//
// 実行: node test/verify-checkin-idempotency.cjs
const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

let pass = 0, fail = 0;
const A = (n, c) => { if (c) { pass++; console.log('✅ ' + n); } else { fail++; console.log('❌ ' + n); } };

// ── 偽スプレッドシート ────────────────────────────────────────
function makeSheet(name, grid) {
  const g = grid.map(r => r.slice());
  const width = () => g.reduce((m, r) => Math.max(m, r.length), 0);
  const pad = () => { const w = width(); g.forEach(r => { while (r.length < w) r.push(''); }); };
  const s = {
    _name: name,
    _grid: g,
    getName: () => name,
    getLastRow: () => g.length,
    getLastColumn: () => width(),
    appendRow: (row) => { g.push(row.slice()); pad(); },
    getDataRange: () => s.getRange(1, 1, Math.max(g.length, 1), Math.max(width(), 1)),
    clearContents: () => { g.length = 1; },
    getRange: (r, c, nr, nc) => {
      nr = nr || 1; nc = nc || 1;
      return {
        getValues: () => {
          pad();
          const out = [];
          for (let i = 0; i < nr; i++) {
            const row = g[r - 1 + i] || [];
            const line = [];
            for (let j = 0; j < nc; j++) line.push(row[c - 1 + j] === undefined ? '' : row[c - 1 + j]);
            out.push(line);
          }
          return out;
        },
        getValue: () => { pad(); return (g[r - 1] || [])[c - 1] === undefined ? '' : g[r - 1][c - 1]; },
        setValue: (v) => {
          while (g.length < r) g.push([]);
          const row = g[r - 1];
          while (row.length < c) row.push('');
          row[c - 1] = v;
          pad();
          s._writes++;
        },
        setValues: (vals) => {
          vals.forEach((line, i) => line.forEach((v, j) => {
            while (g.length < r + i) g.push([]);
            const row = g[r - 1 + i];
            while (row.length < c + j) row.push('');
            row[c - 1 + j] = v;
          }));
          pad();
          s._writes++;
        }
      };
    },
    _writes: 0
  };
  return s;
}

const GUEST_HDR = ['guest_id','event_id','name','email','gender','invited_by','pay_type','amount',
                   'pay_confirmed','arrived','payment_method','first_time','staff_note','actual_pay_type','arrived_at'];
function guestRow(o) {
  return GUEST_HDR.map(h => (o[h] === undefined ? '' : o[h]));
}
const VIP_HDR = ['table_id','event_id','guest_id','table_name','table_type','capacity','price',
                 'status','reserved_by','payment_method'];
function vipRow(o) { return VIP_HDR.map(h => (o[h] === undefined ? '' : o[h])); }

// ── 環境を1つ作る（毎テストで新品にする）────────────────────────
function buildEnv(opts) {
  opts = opts || {};
  const sheets = {
    guests: makeSheet('guests', [GUEST_HDR.slice(),
      guestRow({ guest_id:'G-FREE', event_id:'EV-1', name:'無料 太郎', gender:'male', pay_type:'free', amount:0 }),
      guestRow({ guest_id:'G-PAID', event_id:'EV-1', name:'当日 花子', gender:'female', pay_type:'paid', amount:5000 }),
      guestRow({ guest_id:'G-STRIPE', event_id:'EV-1', name:'事前 次郎', gender:'male', pay_type:'paid', amount:5000, pay_confirmed:'TRUE', payment_method:'stripe' }),
      guestRow({ guest_id:'G-OLD', event_id:'EV-0', name:'旧イベント 三郎', gender:'male', pay_type:'free', amount:0 })
    ]),
    guests_archive: makeSheet('guests_archive', [GUEST_HDR.slice()]),
    vip_tables: makeSheet('vip_tables', [VIP_HDR.slice(),
      vipRow({ table_id:'T1', event_id:'EV-1', guest_id:'VIP-1', table_name:'VIP A', table_type:'ROYAL',
               capacity:4, price:200000, status:'confirmed', reserved_by:'VIP 一郎' })
    ]),
    events: makeSheet('events', [['event_id','name','date','status'], ['EV-1','テスト会','2026-08-08','active']])
  };

  let lockHeld = false;
  const sandbox = {
    console,
    SpreadsheetApp: {
      openById: () => ({ getId: () => 'FAKE', getSheetByName: (n) => sheets[n] || null, getSheets: () => Object.values(sheets) }),
      getActiveSpreadsheet: () => ({ getSheetByName: (n) => sheets[n] || null }),
      flush: () => {}
    },
    LockService: {
      getScriptLock: () => ({
        tryLock: () => {
          if (opts.lockAlwaysFails) return false;
          if (lockHeld) return false;
          lockHeld = true; return true;
        },
        releaseLock: () => { lockHeld = false; }
      })
    },
    ContentService: {
      MimeType: { JSON: 'json', TEXT: 'text' },
      createTextOutput: (t) => ({ _t: t, setMimeType: function () { return this; }, getContent: function () { return this._t; } })
    },
    Utilities: { formatDate: () => '2026-08-08 20:00', base64Encode: (x) => String(x) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty: () => {} }) },
    CacheService: { getScriptCache: () => ({ get: () => null, put: () => {} }) },
    Logger: { log: () => {} },
    ScriptApp: { getProjectTriggers: () => [], newTrigger: () => ({ timeBased: () => ({ everyMinutes: () => ({ create: () => {} }) }) }) },
    MailApp: { sendEmail: () => {}, getRemainingDailyQuota: () => 100 },
    GmailApp: { sendEmail: () => {} },
    UrlFetchApp: { fetch: () => ({ getContentText: () => '{}', getResponseCode: () => 200 }) },
    HtmlService: { createHtmlOutput: (h) => ({ setTitle: function () { return this; } }) },
    Session: { getScriptTimeZone: () => 'Asia/Tokyo' }
  };
  sandbox.globalThis = sandbox;

  const code = fs.readFileSync(path.join(__dirname, '..', 'gas', 'コード.js'), 'utf8');
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'コード.js' });
  return { sandbox, sheets };
}

function post(env, body) {
  const out = env.sandbox.doPost({ postData: { contents: JSON.stringify(body) } });
  return JSON.parse(out.getContent());
}
function cell(sheet, rowNum, colName) {
  const hdr = sheet._grid[0].map(String);
  const i = hdr.indexOf(colName);
  return i < 0 ? undefined : sheet._grid[rowNum - 1][i];
}
function rowOf(sheet, guestId) {
  const hdr = sheet._grid[0].map(String);
  const gi = hdr.indexOf('guest_id');
  for (let i = 1; i < sheet._grid.length; i++) if (String(sheet._grid[i][gi]) === guestId) return i + 1;
  return -1;
}

console.log('── 1. 通常ゲスト：初回チェックイン ─────────────────');
{
  const env = buildEnv();
  const d = post(env, { action:'checkIn', guest_id:'G-FREE', event_id:'EV-1', checkin_token:'TOK-A' });
  A('ok=true / status=checked_in', d.ok === true && d.status === 'checked_in');
  A('replay=false（初回）', d.replay === false);
  A('名前が返る', d.name === '無料 太郎');
  const r = rowOf(env.sheets.guests, 'G-FREE');
  A('シートに arrived=TRUE', cell(env.sheets.guests, r, 'arrived') === 'TRUE');
  A('シートに arrived_at が入る', !!cell(env.sheets.guests, r, 'arrived_at'));
  A('シートに checkin_token が保存される', cell(env.sheets.guests, r, 'checkin_token') === 'TOK-A');
}

console.log('\n── 2. 【本命】同じトークンの再送＝replayで成功を返す ──────');
{
  const env = buildEnv();
  post(env, { action:'checkIn', guest_id:'G-FREE', event_id:'EV-1', checkin_token:'TOK-A' });
  const at1 = cell(env.sheets.guests, rowOf(env.sheets.guests,'G-FREE'), 'arrived_at');
  const d2 = post(env, { action:'checkIn', guest_id:'G-FREE', event_id:'EV-1', checkin_token:'TOK-A' });
  A('再送は ok=true（通信エラー扱いにしない）', d2.ok === true);
  A('status=checked_in', d2.status === 'checked_in');
  A('replay=true', d2.replay === true);
  A('arrived_at は書き換わらない（二重処理なし）',
    cell(env.sheets.guests, rowOf(env.sheets.guests,'G-FREE'), 'arrived_at') === at1);
}

console.log('\n── 3. 別トークンでの再スキャンは従来どおり duplicate ───────');
{
  const env = buildEnv();
  post(env, { action:'checkIn', guest_id:'G-FREE', event_id:'EV-1', checkin_token:'TOK-A' });
  const d = post(env, { action:'checkIn', guest_id:'G-FREE', event_id:'EV-1', checkin_token:'TOK-B' });
  A('ok=false / duplicate（本当の二度読みは検出する）', d.ok === false && d.status === 'duplicate');
  A('duplicate でも名前を返す', d.name === '無料 太郎');
}

console.log('\n── 4. トークン無しの旧クライアントでも壊れない（後方互換）───');
{
  const env = buildEnv();
  const d1 = post(env, { action:'checkIn', guest_id:'G-FREE', event_id:'EV-1' });
  A('トークン無しでもチェックインできる', d1.ok === true && d1.status === 'checked_in');
  const d2 = post(env, { action:'checkIn', guest_id:'G-FREE', event_id:'EV-1' });
  A('トークン無しの二度目は duplicate', d2.ok === false && d2.status === 'duplicate');
}

console.log('\n── 5. 当日払い：payment_required → 方法確定 → 再送replay ───');
{
  const env = buildEnv();
  const d1 = post(env, { action:'checkIn', guest_id:'G-PAID', event_id:'EV-1', checkin_token:'TOK-P' });
  A('payment_required が返る', d1.ok === false && d1.status === 'payment_required');
  A('payment_required の時点では書き込まない',
    cell(env.sheets.guests, rowOf(env.sheets.guests,'G-PAID'), 'arrived') !== 'TRUE');
  const d2 = post(env, { action:'checkIn', guest_id:'G-PAID', event_id:'EV-1', payment_method:'cash', checkin_token:'TOK-P' });
  A('現金指定でチェックイン成功', d2.ok === true && d2.payment_method === 'cash');
  const r = rowOf(env.sheets.guests, 'G-PAID');
  A('pay_confirmed=TRUE', cell(env.sheets.guests, r, 'pay_confirmed') === 'TRUE');
  const d3 = post(env, { action:'checkIn', guest_id:'G-PAID', event_id:'EV-1', payment_method:'cash', checkin_token:'TOK-P' });
  A('同トークン再送は replay 成功', d3.ok === true && d3.replay === true);
  A('replay 応答に保存済みの支払方法が乗る', d3.payment_method === 'cash');
}

console.log('\n── 6. 別イベントのQR（従来は黙って別行を入場済みにしていた）──');
{
  const env = buildEnv();
  const d = post(env, { action:'checkIn', guest_id:'G-OLD', event_id:'EV-1', checkin_token:'TOK-W' });
  A('wrong_event を返す', d.ok === false && d.status === 'wrong_event');
  A('別イベント行を入場済みにしない',
    cell(env.sheets.guests, rowOf(env.sheets.guests,'G-OLD'), 'arrived') !== 'TRUE');
  const d2 = post(env, { action:'checkIn', guest_id:'G-OLD', event_id:'EV-0', checkin_token:'TOK-W2' });
  A('正しいイベントを選べば通る', d2.ok === true && d2.status === 'checked_in');
}

console.log('\n── 7. 存在しないID ───────────────────────────────');
{
  const env = buildEnv();
  const d = post(env, { action:'checkIn', guest_id:'G-NOPE', event_id:'EV-1', checkin_token:'T' });
  A('not_found', d.ok === false && d.status === 'not_found');
}

console.log('\n── 8. VIP：スキャン毎に加算・同トークン再送は加算しない ─────');
{
  const env = buildEnv();
  const d1 = post(env, { action:'checkIn', guest_id:'VIP-1', event_id:'EV-1', checkin_token:'V-A' });
  A('1人目 checked_count=1', d1.ok === true && d1.vip_info.checked_count === 1);
  const d1b = post(env, { action:'checkIn', guest_id:'VIP-1', event_id:'EV-1', checkin_token:'V-A' });
  A('同トークン再送は加算しない（=1のまま）', d1b.vip_info.checked_count === 1);
  A('再送は replay=true', d1b.replay === true);
  const d2 = post(env, { action:'checkIn', guest_id:'VIP-1', event_id:'EV-1', checkin_token:'V-B' });
  A('2人目（別トークン）は加算される =2', d2.vip_info.checked_count === 2);
}

console.log('\n── 9. 【Codex指摘】VIP：順序逆転しても二重加算しない ───────');
{
  // A加算 → 応答消失 → 別客Bを加算 → 遅れてAの再送が到着、という並び。
  // 直近1件だけ覚える方式だとここでAを新規と誤認して二重加算する。
  const env = buildEnv();
  post(env, { action:'checkIn', guest_id:'VIP-1', event_id:'EV-1', checkin_token:'V-A' });
  post(env, { action:'checkIn', guest_id:'VIP-1', event_id:'EV-1', checkin_token:'V-B' });
  const late = post(env, { action:'checkIn', guest_id:'VIP-1', event_id:'EV-1', checkin_token:'V-A' });
  A('遅れて届いたAの再送で加算されない（=2のまま）', late.vip_info.checked_count === 2);
  A('遅延再送も replay=true', late.replay === true);
}

console.log('\n── 10. VIP：定員超過の検知は生きているか ────────────────');
{
  const env = buildEnv();
  let last;
  for (let i = 1; i <= 5; i++) last = post(env, { action:'checkIn', guest_id:'VIP-1', event_id:'EV-1', checkin_token:'V-' + i });
  A('5人目で capacity=4 を超え is_over=true', last.vip_info.checked_count === 5 && last.vip_info.is_over === true);
}

console.log('\n── 11. ロックが取れないときは busy（黙って進まない）────────');
{
  const env = buildEnv({ lockAlwaysFails: true });
  const d = post(env, { action:'checkIn', guest_id:'G-FREE', event_id:'EV-1', checkin_token:'T' });
  A('status=busy / retryable=true', d.ok === false && d.status === 'busy' && d.retryable === true);
  A('busy のときシートを書き換えない',
    cell(env.sheets.guests, rowOf(env.sheets.guests,'G-FREE'), 'arrived') !== 'TRUE');
}

console.log('\n── 12. アーカイブ済みゲストも従来どおり引ける ──────────────');
{
  const env = buildEnv();
  env.sheets.guests_archive.appendRow(guestRow({ guest_id:'G-ARC', event_id:'EV-1', name:'アーカイブ 四郎', pay_type:'free', amount:0 }));
  const d = post(env, { action:'checkIn', guest_id:'G-ARC', event_id:'EV-1', checkin_token:'T-ARC' });
  A('guests_archive から見つかる', d.ok === true && d.name === 'アーカイブ 四郎');
  const d2 = post(env, { action:'checkIn', guest_id:'G-ARC', event_id:'EV-1', checkin_token:'T-ARC' });
  A('アーカイブ側でも replay が効く', d2.ok === true && d2.replay === true);
}

console.log('\n── 13. Stripe事前決済は支払い選択を挟まず即完了 ─────────────');
{
  const env = buildEnv();
  const d = post(env, { action:'checkIn', guest_id:'G-STRIPE', event_id:'EV-1', checkin_token:'T-S' });
  A('即 checked_in', d.ok === true && d.status === 'checked_in');
  A('payment_method=stripe が返る', d.payment_method === 'stripe');
}

console.log('\n── 14. VIP：別イベントのQRは wrong_event ──────────────────');
{
  const env = buildEnv();
  env.sheets.vip_tables.appendRow(vipRow({ table_id:'T0', event_id:'EV-0', guest_id:'VIP-OLD', table_name:'旧A',
                                           capacity:4, status:'confirmed', reserved_by:'旧 VIP' }));
  const d = post(env, { action:'checkIn', guest_id:'VIP-OLD', event_id:'EV-1', checkin_token:'VT1' });
  A('VIPでも wrong_event を返す', d.ok === false && d.status === 'wrong_event');
  const d2 = post(env, { action:'checkIn', guest_id:'VIP-1', event_id:'EV-1', checkin_token:'VT2' });
  A('同イベントのVIPは通る', d2.ok === true && d2.vip_info.checked_count === 1);
}

console.log('\n── 15. 同一VIP IDが複数イベントに在るとき正しい方を選ぶ ────');
{
  const env = buildEnv();
  env.sheets.vip_tables.appendRow(vipRow({ table_id:'T2', event_id:'EV-2', guest_id:'VIP-1', table_name:'別会A',
                                           capacity:2, status:'confirmed', reserved_by:'別会 VIP' }));
  const d = post(env, { action:'checkIn', guest_id:'VIP-1', event_id:'EV-2', checkin_token:'VX1' });
  A('EV-2 側のテーブルが選ばれる', d.vip_info.table_name === '別会A');
  A('EV-1 側は加算されていない', Number(cell(env.sheets.vip_tables, 2, 'checked_count') || 0) === 0);
}

console.log('\n── 16. VIP：履歴上限を超えるスキャン数でも直近の再送は防げる ──');
{
  const env = buildEnv();
  for (let i = 0; i < 210; i++) post(env, { action:'checkIn', guest_id:'VIP-1', event_id:'EV-1', checkin_token:'Vn' + i });
  const n = post(env, { action:'checkIn', guest_id:'VIP-1', event_id:'EV-1', checkin_token:'Vn209' }).vip_info.checked_count;
  A('直近トークンの再送は加算しない（210のまま）', n === 210);
  // ※履歴200件を超えて溢れた極端に古いトークンの遅延再送のみ再加算される（設計上の限界）
}

console.log('\n── 17. 【Codex指摘】書込途中で落ちても二重計上しない（例外注入）─');
{
  const env = buildEnv();
  const g = env.sheets.guests;
  const arrIdx = g._grid[0].map(String).indexOf('arrived') + 1;
  const origGetRange = g.getRange;
  let boom = true;
  g.getRange = function (r, c, nr, nc) {
    const rng = origGetRange(r, c, nr, nc);
    if (boom && c === arrIdx && !nr) return Object.assign({}, rng, { setValue: () => { throw new Error('書き込み中断'); } });
    return rng;
  };
  const d1 = post(env, { action:'checkIn', guest_id:'G-FREE', event_id:'EV-1', checkin_token:'TOKX' });
  A('中断時は internal_error / retryable=true', d1.ok === false && d1.status === 'internal_error' && d1.retryable === true);
  A('arrived は立っていない', cell(g, rowOf(g,'G-FREE'), 'arrived') !== 'TRUE');
  boom = false;
  const d2 = post(env, { action:'checkIn', guest_id:'G-FREE', event_id:'EV-1', checkin_token:'TOKX' });
  A('同トークン再送でやり直せる', d2.ok === true && d2.status === 'checked_in');
  A('結果は入場済み1回ぶん', cell(g, rowOf(g,'G-FREE'), 'arrived') === 'TRUE');
}

console.log('\n── 18. 【Codex指摘】VIP：正本セル書込後に落ちても加算は1回 ───');
{
  const env = buildEnv();
  const vt = env.sheets.vip_tables;
  const origGR = vt.getRange;
  let boom = true;
  vt.getRange = function (r, c, nr, nc) {
    const rng = origGR(r, c, nr, nc);
    const cntCol = vt._grid[0].map(String).indexOf('checked_count') + 1;
    if (boom && c === cntCol && !nr) return Object.assign({}, rng, { setValue: () => { throw new Error('ミラー書込中断'); } });
    return rng;
  };
  const d1 = post(env, { action:'checkIn', guest_id:'VIP-1', event_id:'EV-1', checkin_token:'VB1' });
  A('ミラー書込で落ちると internal_error', d1.ok === false && d1.status === 'internal_error');
  boom = false;
  const d2 = post(env, { action:'checkIn', guest_id:'VIP-1', event_id:'EV-1', checkin_token:'VB1' });
  A('再送しても頭数は1のまま（二重加算なし）', d2.vip_info.checked_count === 1);
  A('再送は replay 扱い', d2.replay === true);
  A('checked_count 列も1へ復旧する', Number(cell(vt, 2, 'checked_count')) === 1);
}

console.log('\n── 18b.【Codex指摘】VIP：arrived だけ書けずに落ちても再送で復旧 ─');
{
  // checked_count までは書けたが arrived で落ちたケース。
  // count が一致しているので「count がズレていたら直す」だけの作りでは永久に空のまま残る。
  const env = buildEnv();
  const vt = env.sheets.vip_tables;
  const origGR = vt.getRange;
  let boom = true;
  vt.getRange = function (r, c, nr, nc) {
    const rng = origGR(r, c, nr, nc);
    const arrCol = vt._grid[0].map(String).indexOf('arrived') + 1;
    if (boom && arrCol > 0 && c === arrCol && !nr) return Object.assign({}, rng, { setValue: () => { throw new Error('arrived書込中断'); } });
    return rng;
  };
  const d1 = post(env, { action:'checkIn', guest_id:'VIP-1', event_id:'EV-1', checkin_token:'VC1' });
  A('arrived 書込で落ちると internal_error', d1.ok === false && d1.status === 'internal_error');
  A('checked_count は書けている', Number(cell(vt, 2, 'checked_count')) === 1);
  A('arrived は空のまま', String(cell(vt, 2, 'arrived') || '') !== 'TRUE');
  boom = false;
  const d2 = post(env, { action:'checkIn', guest_id:'VIP-1', event_id:'EV-1', checkin_token:'VC1' });
  A('再送は replay（加算しない）', d2.replay === true && d2.vip_info.checked_count === 1);
  A('arrived ミラーが復旧する', String(cell(vt, 2, 'arrived')) === 'TRUE');
}

console.log('\n── 19. 【Codex指摘】不正トークンを弾く（式注入・カンマ・長大）──');
{
  const bad = ['=SUM(A1:A9)', 'tok,with,comma', 'x'.repeat(200), '<script>', "tok';--"];
  let allSafe = true;
  bad.forEach(t => {
    const envN = buildEnv();
    const d = post(envN, { action:'checkIn', guest_id:'G-FREE', event_id:'EV-1', checkin_token: t });
    if (cell(envN.sheets.guests, rowOf(envN.sheets.guests,'G-FREE'), 'checkin_token')) allSafe = false;
    if (d.ok !== true) allSafe = false;   // チェックイン自体は通す（トークン無し扱い）
  });
  A('不正トークンはシートへ保存されない', allSafe);
  const env = buildEnv();
  post(env, { action:'checkIn', guest_id:'G-FREE', event_id:'EV-1', checkin_token:'CI-G_FREE-abc-123' });
  A('正当な形式は保存される',
    cell(env.sheets.guests, rowOf(env.sheets.guests,'G-FREE'), 'checkin_token') === 'CI-G_FREE-abc-123');
}

console.log('\n── 20. 既存データ（checked_count のみ）の VIP 行を引き継ぐ ───');
{
  const env = buildEnv();
  const vt = env.sheets.vip_tables;
  vt._grid[0].push('checked_count');
  vt._grid[1].push(3);
  const d = post(env, { action:'checkIn', guest_id:'VIP-1', event_id:'EV-1', checkin_token:'VL1' });
  A('既存の頭数3を引き継いで4になる', d.vip_info.checked_count === 4);
}

console.log('\n── 21. アーカイブは列構成がズレてもヘッダー名で正しく貼る ────');
{
  // guests に checkin_token が増えた後にアーカイブしても、
  // guests_archive のヘッダーとデータが1列ずれない（ずれると以後の検索が壊れる）。
  const env = buildEnv();
  post(env, { action:'checkIn', guest_id:'G-FREE', event_id:'EV-1', checkin_token:'ARC1' });
  const g = env.sheets.guests;
  A('guests に checkin_token 列が増えている', g._grid[0].map(String).indexOf('checkin_token') >= 0);
  const d = post(env, { action:'archiveEvent', event_id:'EV-1' });
  A('アーカイブが成功する', d.ok === true);
  const a = env.sheets.guests_archive;
  const aHdr = a._grid[0].map(String);
  A('archive 側にも checkin_token 列が生える', aHdr.indexOf('checkin_token') >= 0);
  const gi = aHdr.indexOf('guest_id');
  let arcRow = -1;
  for (let i = 1; i < a._grid.length; i++) if (String(a._grid[i][gi]) === 'G-FREE') arcRow = i;
  A('アーカイブ行が見つかる', arcRow > 0);
  A('name 列がずれずに入る', String(a._grid[arcRow][aHdr.indexOf('name')]) === '無料 太郎');
  A('arrived 列がずれずに入る', String(a._grid[arcRow][aHdr.indexOf('arrived')]) === 'TRUE');
  A('checkin_token がずれずに入る', String(a._grid[arcRow][aHdr.indexOf('checkin_token')]) === 'ARC1');
  const d2 = post(env, { action:'checkIn', guest_id:'G-FREE', event_id:'EV-1', checkin_token:'ARC1' });
  A('アーカイブ後も同トークン再送は replay になる', d2.ok === true && d2.replay === true);
}

console.log('\n' + (fail === 0
  ? `—— 全合格 ✅（${pass}件）——`
  : `—— 不合格 ${fail}件 / 合格 ${pass}件 ❌ ——`));
process.exit(fail === 0 ? 0 : 1);
