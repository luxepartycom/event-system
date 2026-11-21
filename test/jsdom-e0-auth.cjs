// 検証ハーネス 層3（jsdom）: E0 鍵なしで個人情報を返す操作を塞ぐ ── 画面側
// 設計: event-operations/ops/design-E0-auth.md（末尾「改めた区分（確定）」が正）
// 実 admin.html / entrance.html を Node 内で実行し、入口（apiGet / apiPost / apiPostCheckIn / doLogin）から通す。
// 実行: NODE_PATH=~/.cache/claude-node/node_modules node test/jsdom-e0-auth.cjs
//   E0_ADMIN_HTML / E0_ENTRANCE_HTML で差し替え可（壊して落ちることを確かめる用）
//
// 守りたいこと:
//  - ログイン中の要求には合言葉（_pw）が付く。auth には付けない
//  - 断られたら（forbidden）ログインへ戻す。同時に何本断られても戻すのは1回
//  - admin.html は受付の合言葉（role=entrance）でログインさせない
//  - entrance.html：受付の流れ（getGuests・checkIn・saveGuestCheckinInfo・VIP受付）は受付の合言葉で送る。
//    管理の操作は管理者の合言葉を別に聞いて送り、この画面の間だけ覚える
//  - 合言葉を localStorage に残さない。版の印が出ている
// データはすべて架空。
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ADMIN_PW = 'test-admin-pw-0001';
const ENT_PW   = 'test-entrance-pw-0001';
const VERSION  = 'E0-2026-11-21';

let pass = 0, fail = 0;
const A = (n, c) => { if (c) { pass++; console.log('✅ ' + n); } else { fail++; console.log('❌ ' + n); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// 途中で止まった（待ち続けた・黙って終わった）ときに合格扱いにしない
let finished = false;
process.on('exit', () => { if (!finished) { console.log('❌ 途中で止まった（最後まで走っていない）'); process.exitCode = 1; } });
setTimeout(() => { console.log('❌ 時間切れ（どこかで待ち続けている）'); process.exit(1); }, 30000);

const FILES = {
  admin:    process.env.E0_ADMIN_HTML    || path.join(__dirname, '..', 'admin.html'),
  entrance: process.env.E0_ENTRANCE_HTML || path.join(__dirname, '..', 'entrance.html')
};

// 要求を記録し、handler(action, params, method) の返す値で応答する偽の fetch
function makePage(which, opts) {
  opts = opts || {};
  const html = fs.readFileSync(FILES[which], 'utf8');
  const reqs = [];
  const errors = [];
  const state = { handler: opts.handler || (() => ({ ok: true })) };
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errors.push(String(e.message)));
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    url: 'https://entry.luxepartytokyo.com/' + which + '.html',
    beforeParse(window) {
      if (opts.session) Object.keys(opts.session).forEach(k => window.sessionStorage.setItem(k, opts.session[k]));
      if (opts.local)   Object.keys(opts.local).forEach(k => window.localStorage.setItem(k, opts.local[k]));
      window.fetch = (url, init) => {
        const u = new URL(String(url), 'https://script.google.com/');
        let method = 'GET', params = {};
        if (init && init.method === 'POST') {
          method = 'POST';
          try { params = JSON.parse(init.body); } catch (e) { params = { _raw: init.body }; }
        } else {
          u.searchParams.forEach((v, k) => { params[k] = v; });
        }
        const rec = { method, url: String(url), params };
        reqs.push(rec);
        let resp = state.handler(params.action, params, method);
        if (resp === undefined) resp = { ok: true };
        return Promise.resolve({ ok: true, status: 200,
          json: () => Promise.resolve(resp), text: () => Promise.resolve(JSON.stringify(resp)) });
      };
      if (!window.AbortController) window.AbortController = class { constructor(){ this.signal = {}; } abort(){} };
      window.navigator.mediaDevices = window.navigator.mediaDevices || { getUserMedia: () => Promise.reject(new Error('no cam')) };
      window.confirm = () => true;
      window.alert = () => {};
    }
  });
  const reloads = () => errors.filter(e => /navigation/i.test(e)).length;
  return { w: dom.window, reqs, errors, state, reloads };
}
const lastOf = (page, action) => page.reqs.filter(r => r.params.action === action).pop();
const fatalErrors = (page) => page.errors.filter(e => !/navigation|getUserMedia|mediaDevices|not implemented|camera|ZXing|BarcodeDetector/i.test(e));

(async () => {
  // ════════════════ admin.html ════════════════
  console.log('── admin.html ─────────────────────────────────');
  {
    const p = makePage('admin', { local: { lpt_charge_auth: 'old-leftover' } });
    await sleep(500);
    const w = p.w;
    A('admin: JS の致命的エラーなし', fatalErrors(p).length === 0);
    fatalErrors(p).forEach(e => console.log('   ⚠ ' + e));
    A('admin: 版の印 ' + VERSION + ' が出ている', (w.document.getElementById('e0-ver') || {}).textContent === VERSION);
    A('admin: 旧版が localStorage に残した合言葉を消す', w.localStorage.getItem('lpt_charge_auth') === null);

    w.sessionStorage.setItem('lpt_auth', ADMIN_PW);
    await w.apiGet({ action: 'getGuests', event_id: 'EV-T1' });
    A('admin: apiGet に _pw が付く', (lastOf(p, 'getGuests') || { params: {} }).params._pw === ADMIN_PW);
    await w.apiPost({ action: 'getMailList', event_id: 'EV-T1' });
    A('admin: apiPost に _pw が付く', (lastOf(p, 'getMailList') || { params: {} }).params._pw === ADMIN_PW);
    await w.apiPostCheckIn({ action: 'checkIn', guest_id: 'G-T1', event_id: 'EV-T1', checkin_token: 'CItest' });
    A('admin: apiPostCheckIn にも _pw が付く', (lastOf(p, 'checkIn') || { params: {} }).params._pw === ADMIN_PW);
    await w.apiGet({ action: 'auth', password: 'x' });
    A('admin: auth には _pw を付けない', !('_pw' in (lastOf(p, 'auth') || { params: { _pw: 1 } }).params));
    A('admin: 呼び出し元の引数を書き換えない', (() => { const o = { action: 'getGuests' }; w.apiGet(o); return !('_pw' in o); })());

    // 断られたら1回だけログインへ戻す
    p.state.handler = (a) => (a === 'getMailList' || a === 'getCampaignStatus') ? { ok: false, status: 'forbidden' } : { ok: true };
    const before = p.reloads();
    await Promise.all([
      w.apiPost({ action: 'getMailList' }), w.apiPost({ action: 'getCampaignStatus' }), w.apiPost({ action: 'getMailList' })
    ]);
    await sleep(50);
    A('admin: forbidden が3本来ても戻すのは1回', p.reloads() - before === 1);
    A('admin: 戻すときに合言葉を捨てる', w.sessionStorage.getItem('lpt_auth') === null);
    A('admin: 戻した理由の印を残す', w.sessionStorage.getItem('lpt_auth_expired') === '1');
  }
  {
    // ログイン：受付の合言葉（role=entrance）では開けない
    const p = makePage('admin', { handler: (a) => a === 'auth' ? { ok: true, role: 'entrance' } : { ok: true, events: [] } });
    await sleep(400);
    const w = p.w;
    w.document.getElementById('login-pw').value = ENT_PW;
    await w.doLogin();
    A('admin: role=entrance ではログインしない（合言葉を保存しない）', w.sessionStorage.getItem('lpt_auth') === null);
    A('admin: role=entrance では管理画面を出さない', w.document.getElementById('app').style.display === 'none');
    A('admin: 受付用では開けないと伝える', w.document.getElementById('login-err').style.display === 'block'
      && /受付/.test(w.document.getElementById('login-err').textContent));
  }
  {
    const p = makePage('admin', { handler: (a) => a === 'auth' ? { ok: true, role: 'admin' } : { ok: true, events: [] } });
    await sleep(400);
    const w = p.w;
    w.document.getElementById('login-pw').value = ADMIN_PW;
    await w.doLogin();
    A('admin: role=admin ならログインする', w.sessionStorage.getItem('lpt_auth') === ADMIN_PW
      && w.document.getElementById('app').style.display === 'block');
  }
  {
    // 前のセッションが受付の合言葉で残っていたら、裏の確認で追い出す
    const p = makePage('admin', { session: { lpt_auth: ENT_PW },
      handler: (a) => a === 'auth' ? { ok: true, role: 'entrance' } : { ok: true, events: [] } });
    await sleep(600);
    A('admin: 保存済みの合言葉が受付用なら追い出す', p.w.sessionStorage.getItem('lpt_auth') === null && p.reloads() === 1);
  }
  {
    // 断られて戻った後の画面は理由を出す
    const p = makePage('admin', { session: { lpt_auth_expired: '1' } });
    await sleep(400);
    const err = p.w.document.getElementById('login-err');
    A('admin: 戻った後のログイン画面に理由を出す', err.style.display === 'block' && /期限|変更/.test(err.textContent));
    A('admin: 理由の印は1回で消す', p.w.sessionStorage.getItem('lpt_auth_expired') === null);
  }

  // ════════════════ entrance.html ════════════════
  console.log('\n── entrance.html ──────────────────────────────');
  const entHandler = (a, prm) => {
    if (a === 'auth') {
      if (prm.password === ADMIN_PW) return { ok: true, role: 'admin' };
      if (prm.password === ENT_PW)   return { ok: true, role: 'entrance' };
      return { ok: false, message: 'パスワードが違います' };
    }
    return { ok: true };
  };
  {
    const p = makePage('entrance', { local: { lpt_charge_auth: 'old-leftover' }, handler: entHandler });
    await sleep(500);
    const w = p.w;
    A('entrance: JS の致命的エラーなし', fatalErrors(p).length === 0);
    fatalErrors(p).forEach(e => console.log('   ⚠ ' + e));
    A('entrance: 版の印 ' + VERSION + ' が出ている', (w.document.getElementById('e0-ver') || {}).textContent === VERSION);
    A('entrance: 旧版が localStorage に残した合言葉を消す', w.localStorage.getItem('lpt_charge_auth') === null);

    w.sessionStorage.setItem('lpt_auth', ENT_PW);
    // 受付当日の流れ：一覧 → 入場 → 備考 → VIP
    await w.apiGet({ action: 'getGuests', event_id: 'EV-T1' });
    A('entrance: getGuests は受付の合言葉で送る', (lastOf(p, 'getGuests') || { params: {} }).params._pw === ENT_PW);
    await w.apiPostCheckIn({ action: 'checkIn', guest_id: 'G-T1', event_id: 'EV-T1', checkin_token: 'CItest' });
    A('entrance: checkIn は受付の合言葉で送る', (lastOf(p, 'checkIn') || { params: {} }).params._pw === ENT_PW);
    await w.apiPost({ action: 'saveGuestCheckinInfo', guest_id: 'G-T1' });
    A('entrance: saveGuestCheckinInfo は受付の合言葉で送る', (lastOf(p, 'saveGuestCheckinInfo') || { params: {} }).params._pw === ENT_PW);
    await w.apiGet({ action: 'getVipReservations', event_id: 'EV-T1' });
    await w.apiPost({ action: 'confirmVipPayment', guest_id: 'VIP-T1' });
    await w.apiPost({ action: 'createVipCash', table_id: 'T1' });
    A('entrance: VIP 受付も受付の合言葉で送る',
      ['getVipReservations', 'confirmVipPayment', 'createVipCash'].every(a => (lastOf(p, a) || { params: {} }).params._pw === ENT_PW));
    A('entrance: 受付の流れでは管理者の合言葉を聞かない', !w.document.getElementById('e0-admin-pw'));

    // 管理の操作：管理者の合言葉を聞く
    const nBefore = p.reqs.length;
    const pr = w.apiPost({ action: 'getMailList', event_id: 'EV-T1' });
    await sleep(30);
    const ov = w.document.getElementById('e0-admin-pw');
    A('entrance: 管理の操作では管理者の合言葉を聞く', !!ov);
    A('entrance: 聞いている間は送らない', !p.reqs.slice(nBefore).some(r => r.params.action === 'getMailList'));
    if (ov) {
      A('entrance: 入力欄は伏せ字', w.document.getElementById('e0-admin-pw-input').type === 'password');
      w.document.getElementById('e0-admin-pw-input').value = 'test-wrong-pw-9999';
      w.document.getElementById('e0-admin-pw-ok').click();
      await sleep(30);
      A('entrance: 違うパスワードなら閉じずに知らせる', !!w.document.getElementById('e0-admin-pw')
        && /違/.test(w.document.getElementById('e0-admin-pw-err').textContent));
      w.document.getElementById('e0-admin-pw-input').value = ENT_PW;
      w.document.getElementById('e0-admin-pw-ok').click();
      await sleep(30);
      A('entrance: 受付のパスワード（role=entrance）は管理者として受け付けない', !!w.document.getElementById('e0-admin-pw'));
      w.document.getElementById('e0-admin-pw-input').value = ADMIN_PW;
      w.document.getElementById('e0-admin-pw-ok').click();
    }
    const dML = await pr;
    const authReq = lastOf(p, 'auth') || { params: {} };
    A('entrance: 管理者の合言葉は auth で role=admin を確かめる', authReq.params.password === ADMIN_PW && authReq.params.mode === undefined && !('_pw' in authReq.params));
    A('entrance: 確かめたら管理者の合言葉で送る', (lastOf(p, 'getMailList') || { params: {} }).params._pw === ADMIN_PW && dML.ok === true);
    A('entrance: 閉じる', !w.document.getElementById('e0-admin-pw'));
    A('entrance: 管理者の合言葉を storage に置かない',
      ![...Array(w.sessionStorage.length).keys()].some(i => w.sessionStorage.getItem(w.sessionStorage.key(i)) === ADMIN_PW) &&
      ![...Array(w.localStorage.length).keys()].some(i => w.localStorage.getItem(w.localStorage.key(i)) === ADMIN_PW));
    await w.apiPost({ action: 'sendMailMag', event_id: 'EV-T1' });
    A('entrance: 2回目からは聞かずに管理者の合言葉で送る', !w.document.getElementById('e0-admin-pw')
      && (lastOf(p, 'sendMailMag') || { params: {} }).params._pw === ADMIN_PW);
    await w.apiGet({ action: 'getGuests', event_id: 'EV-T1' });
    A('entrance: 管理の後も受付の操作は受付の合言葉のまま', (lastOf(p, 'getGuests') || { params: {} }).params._pw === ENT_PW);

    // 管理者の合言葉が断られたら：覚えた値を捨てて次に聞き直す。受付のログインは保つ
    p.state.handler = (a, prm) => a === 'archiveEvent' ? { ok: false, status: 'forbidden' } : entHandler(a, prm);
    const r0 = p.reloads();
    await w.apiPost({ action: 'archiveEvent', event_id: 'EV-T1' });
    A('entrance: 管理の操作が断られても受付のログインは保つ', w.sessionStorage.getItem('lpt_auth') === ENT_PW && p.reloads() === r0);
    const pr2 = w.apiPost({ action: 'addEvent', name: '架空の会' });
    await sleep(30);
    A('entrance: 断られた後は管理者の合言葉を聞き直す', !!w.document.getElementById('e0-admin-pw'));
    if (w.document.getElementById('e0-admin-pw')) w.document.getElementById('e0-admin-pw-cancel').click();
    const dc = await pr2;
    A('entrance: やめたら送らずに理由を返す', dc.ok === false && dc.status === 'admin_required' && !lastOf(p, 'addEvent'));

    // 受付の合言葉が断られたら：1回だけログインへ戻す
    p.state.handler = (a) => (a === 'getGuests' || a === 'checkIn') ? { ok: false, status: 'forbidden' } : { ok: true };
    const r1 = p.reloads();
    await Promise.all([w.apiGet({ action: 'getGuests' }), w.apiGet({ action: 'getGuests' }), w.apiPost({ action: 'checkIn', guest_id: 'G-T1' })]);
    await sleep(50);
    A('entrance: 受付の合言葉が断られたら1回だけログインへ戻す', p.reloads() - r1 === 1 && w.sessionStorage.getItem('lpt_auth') === null);
  }
  {
    // 同時に2つの管理の操作 → 聞くのは1回
    const p = makePage('entrance', { session: {}, handler: entHandler });
    await sleep(500);
    const w = p.w;
    w.sessionStorage.setItem('lpt_auth', ENT_PW);
    const a1 = w.apiPost({ action: 'getMailList' });
    const a2 = w.apiPost({ action: 'getCampaignStatus' });
    await sleep(30);
    A('entrance: 同時の管理操作でも聞く画面は1つ', w.document.querySelectorAll('#e0-admin-pw').length === 1);
    w.document.getElementById('e0-admin-pw-input').value = ADMIN_PW;
    w.document.getElementById('e0-admin-pw-ok').click();
    await Promise.all([a1, a2]);
    A('entrance: 両方とも管理者の合言葉で送る',
      (lastOf(p, 'getMailList') || { params: {} }).params._pw === ADMIN_PW && (lastOf(p, 'getCampaignStatus') || { params: {} }).params._pw === ADMIN_PW);
    A('entrance: auth は1回だけ', p.reqs.filter(r => r.params.action === 'auth' && r.params.password === ADMIN_PW).length === 1);
  }
  {
    // 設計の Critical 1 の一覧（受付の合言葉のまま呼ばれていた管理の操作）は全部、管理者の合言葉を求める
    const CRIT = ['addEvent','updateEventDescription','updateEventStatus','archiveEvent','deletePromoUrl','savePromoUrl',
      'aiGroupNames','savePromoGroups','exportPromoReport','getMailList','sendMailMag','getCampaignStatus','sendMailMagTest'];
    const p = makePage('entrance', { handler: entHandler });
    await sleep(500);
    const w = p.w;
    w.sessionStorage.setItem('lpt_auth', ENT_PW);
    const leaked = [];
    for (const a of CRIT) {
      const pr = w.apiPost({ action: a });
      await sleep(10);
      const asked = !!w.document.getElementById('e0-admin-pw');
      if (asked) w.document.getElementById('e0-admin-pw-cancel').click();
      await pr;
      if (!asked || lastOf(p, a)) leaked.push(a);
    }
    A('entrance: 管理の操作 ' + CRIT.length + ' 種はすべて管理者の合言葉を求め、受付の合言葉では送らない', leaked.length === 0);
    leaked.forEach(x => console.log('   ⚠ ' + x));
  }
  {
    // 配線：実画面の関数（ゲスト一覧の取得・受付終了・メール配信の一覧）から通す
    const p = makePage('entrance', { handler: entHandler });
    await sleep(500);
    const w = p.w;
    w.sessionStorage.setItem('lpt_auth', ENT_PW);
    await w.loadGuestsForEvent('EV-T1');
    A('entrance 配線: ゲスト一覧（loadGuestsForEvent）は受付の合言葉で送る', (lastOf(p, 'getGuests') || { params: {} }).params._pw === ENT_PW);
    const pc = w.closeEvent('EV-T1');
    await sleep(30);
    A('entrance 配線: 受付終了（closeEvent）は管理者の合言葉を聞く', !!w.document.getElementById('e0-admin-pw'));
    if (w.document.getElementById('e0-admin-pw')) w.document.getElementById('e0-admin-pw-cancel').click();
    await pc;
    A('entrance 配線: やめたら受付終了を送らない', !lastOf(p, 'updateEventStatus'));
    // ※ entrance.html にはメール配信のタブが無い（loadMmGuests 等は画面から呼べない死んだコード）
    const pm = w.archiveEvent('EV-T1');
    await sleep(30);
    A('entrance 配線: アーカイブ（archiveEvent）は管理者の合言葉を聞く', !!w.document.getElementById('e0-admin-pw'));
    if (w.document.getElementById('e0-admin-pw')) {
      w.document.getElementById('e0-admin-pw-input').value = ADMIN_PW;
      w.document.getElementById('e0-admin-pw-ok').click();
    }
    await pm;
    A('entrance 配線: アーカイブは管理者の合言葉で送る', (lastOf(p, 'archiveEvent') || { params: {} }).params._pw === ADMIN_PW);
  }
  {
    // 保存済みの合言葉が管理者のもの（受付モードで role が違う）なら追い出す（既存の挙動を保つ）
    const p = makePage('entrance', { session: { lpt_auth: ADMIN_PW },
      handler: (a) => a === 'auth' ? { ok: false } : { ok: true, events: [] } });
    await sleep(600);
    A('entrance: 保存済みの合言葉が受付用でなければ追い出す', p.w.sessionStorage.getItem('lpt_auth') === null && p.reloads() === 1);
  }

  // ════════════════ 合言葉を localStorage に置かない（両画面の源） ════════════════
  ['admin', 'entrance'].forEach(k => {
    const src = fs.readFileSync(FILES[k], 'utf8');
    A(k + ': 合言葉を localStorage に書く行が無い', !/localStorage\.setItem\(\s*['"]lpt_charge_auth/.test(src) && !/localStorage\.setItem\(\s*['"]lpt_auth/.test(src));
  });

  finished = true;
  console.log('\n' + (fail === 0 ? '—— 全合格 ✅（' + pass + '件）——' : '—— 不合格 ' + fail + '件 / 合格 ' + pass + '件 ❌ ——'));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.log('❌ 例外: ' + (e && e.stack || e)); process.exit(1); });
