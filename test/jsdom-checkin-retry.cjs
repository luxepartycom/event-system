// 検証ハーネス 層3（jsdom）: 実 admin.html / entrance.html を Node 内で動かし、
// 「サーバは成功・応答だけ落ちた」状況を fetch スタブで再現して、
// 画面が『❌ 通信エラー』で終わらず、同一トークンの再送で成功に収束することを確認する。
//
// 実行: NODE_PATH=~/.cache/claude-node/node_modules node test/jsdom-checkin-retry.cjs
const fs   = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

let pass = 0, fail = 0;
const A = (n, c) => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n); } };

// サーバ側の状態を持つ偽GAS。checkIn は本物と同じ冪等ルールで応答する。
function makeFakeServer() {
  const state = { arrived: false, token: null };
  return {
    state,
    handle(body) {
      if (body.action === 'ping') return { ok: true };
      if (body.action !== 'checkIn') return { ok: true };
      if (state.arrived) {
        if (body.checkin_token && state.token === body.checkin_token) {
          return { ok: true, status: 'checked_in', replay: true, guest_id: body.guest_id, name: 'テスト 太郎', pay_type: 'free', amount: 0 };
        }
        return { ok: false, status: 'duplicate', message: '入場済みです', guest_id: body.guest_id, name: 'テスト 太郎' };
      }
      state.arrived = true;
      state.token = body.checkin_token || null;
      return { ok: true, status: 'checked_in', replay: false, guest_id: body.guest_id, name: 'テスト 太郎', pay_type: 'free', amount: 0 };
    }
  };
}

function boot(file, fetchImpl) {
  const html = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const jsErrors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => jsErrors.push(e.message));
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    url: 'https://entry.luxepartytokyo.com/' + file,
    beforeParse(window) {
      window.fetch = fetchImpl(window);
      window.navigator.mediaDevices = window.navigator.mediaDevices || { getUserMedia: () => Promise.reject(new Error('no cam')) };
    }
  });
  return { dom, jsErrors };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function runFile(file) {
  console.log('\n══ ' + file + ' ══════════════════════════════════');
  const server = makeFakeServer();
  let attempts = 0;
  let failFirstN = 0;   // 「サーバは処理するが応答は返さない」回数

  const fetchImpl = (window) => (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : {};
    if (init && init.method === 'POST') {
      attempts++;
      const result = server.handle(body);           // ← サーバ側は必ず処理する
      if (attempts <= failFirstN) {
        // 応答だけが返らない = 今回の障害そのもの
        return Promise.reject(new TypeError('Load failed'));
      }
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(result)) });
    }
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{"ok":true}'), json: () => Promise.resolve({ ok: true }) });
  };

  const { dom, jsErrors } = boot(file, fetchImpl);
  await sleep(300);
  const w = dom.window;

  const fatal = jsErrors.filter(e => !/getUserMedia|mediaDevices|fetch|NetworkError|not implemented|Failed to|camera|ZXing|BarcodeDetector/i.test(e));
  A('致命的なJSパース/実行エラー ゼロ', fatal.length === 0);
  fatal.forEach(e => console.log('     ⚠ ' + e));

  A('apiPostCheckIn 定義済み', typeof w.apiPostCheckIn === 'function');
  A('ciTokenFor 定義済み',     typeof w.ciTokenFor === 'function');
  A('ciShowRetry 定義済み',    typeof w.ciShowRetry === 'function');
  A('retryLastCheckin 定義済み', typeof w.retryLastCheckin === 'function');
  A('再試行UI(ci-retry-area) が存在', !!w.document.getElementById('ci-retry-area'));

  // トークンはスキャンをまたいで同じ値が返る（再送で二重処理しないための前提）
  if (typeof w.ciTokenFor === 'function') {
    const t1 = w.ciTokenFor('G-X'), t2 = w.ciTokenFor('G-X');
    A('同一ゲストのトークンは再取得しても同じ', t1 === t2);
    w.ciTokenClear('G-X');
    A('clear後は新しいトークンになる', w.ciTokenFor('G-X') !== t1);
    w.ciTokenClear('G-X');
  }

  // ── 本番相当のシナリオ：1回目の応答が落ちる → 2回目で replay 成功 ──
  const sel = w.document.getElementById('scan-event-sel');
  sel.innerHTML = '<option value="EV-1">テスト会</option>';
  sel.value = 'EV-1';
  w.allGuests = [];

  failFirstN = 1;   // 1回目だけ応答が返らない
  attempts = 0;
  await w.processCheckIn('G-TEST');
  await sleep(100);

  const msg = w.document.getElementById('scan-msg').textContent;
  A('サーバ側は入場済みになっている', server.state.arrived === true);
  A('2回目の送信が行われた（自動再送）', attempts >= 2);
  A('画面は「通信エラー」で終わらない', msg.indexOf('通信エラー') < 0);
  A('画面が「チェックイン完了」になる（再送で収束）', msg.indexOf('チェックイン完了') >= 0);
  A('再送で確認した旨が表示される', msg.indexOf('再送で確認') >= 0);
  A('再試行UIは出ていない', w.document.getElementById('ci-retry-area').style.display !== 'block');
  A('checkinBusy が解放されている', w.eval('checkinBusy') === false); // let宣言はwindowプロパティにならないためevalで読む
  console.log('     scan-msg = ' + msg);

  // ── 全滅シナリオ：3回とも応答が落ちる → 再試行導線が出る ──
  const server2 = makeFakeServer();
  let attempts2 = 0, failAll = true;
  const fetchImpl2 = () => (url, init) => {
    if (init && init.method === 'POST') {
      attempts2++;
      server2.handle(JSON.parse(init.body));
      if (failAll) return Promise.reject(new TypeError('Load failed'));
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(server2.handle(JSON.parse(init.body)))) });
    }
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{"ok":true}'), json: () => Promise.resolve({ ok: true }) });
  };
  const boot2 = boot(file, fetchImpl2);
  await sleep(300);
  const w2 = boot2.dom.window;
  const sel2 = w2.document.getElementById('scan-event-sel');
  sel2.innerHTML = '<option value="EV-1">テスト会</option>';
  sel2.value = 'EV-1';
  w2.allGuests = [];

  await w2.processCheckIn('G-TEST2');
  await sleep(100);
  A('3回試行して諦める', attempts2 === 3);
  A('再試行UIが表示される', w2.document.getElementById('ci-retry-area').style.display === 'block');
  A('全滅時も checkinBusy は解放される', w2.eval('checkinBusy') === false);
  const rmsg = w2.document.getElementById('ci-retry-msg').textContent;
  A('「入場済みの可能性」を伝える文言がある', rmsg.indexOf('入場済み') >= 0);
  A('「二重チェックインにならない」と明示', rmsg.indexOf('二重チェックイン') >= 0);

  // 回線が戻ってから再試行 → 同じトークンで replay 成功
  failAll = false;
  await w2.retryLastCheckin();
  await sleep(100);
  const msg2 = w2.document.getElementById('scan-msg').textContent;
  A('再試行ボタンで完了に収束する', msg2.indexOf('チェックイン完了') >= 0);
  console.log('     scan-msg = ' + msg2);

  // ── サーバが internal_error(retryable) を返す：自動再送で収束するか ──
  const server3 = makeFakeServer();
  let n3 = 0;
  const boot3 = boot(file, () => (url, init) => {
    if (init && init.method === 'POST') {
      n3++;
      const body = JSON.parse(init.body);
      if (n3 === 1) {
        server3.handle(body);   // サーバは処理したが、応答は internal_error
        return Promise.resolve({ ok: true, status: 200,
          text: () => Promise.resolve(JSON.stringify({ ok:false, status:'internal_error', retryable:true, message:'処理が中断しました' })) });
      }
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(server3.handle(body))) });
    }
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{"ok":true}'), json: () => Promise.resolve({ ok: true }) });
  });
  await sleep(300);
  const w3 = boot3.dom.window;
  const s3 = w3.document.getElementById('scan-event-sel');
  s3.innerHTML = '<option value="EV-1">テスト会</option>'; s3.value = 'EV-1';
  await w3.processCheckIn('G-T3');
  await sleep(100);
  A('internal_error は自動再送される', n3 >= 2);
  A('再送後に完了へ収束する', w3.document.getElementById('scan-msg').textContent.indexOf('チェックイン完了') >= 0);

  // ── HTTP 500 / 壊れたJSON / HTMLエラーページ を切り分けて報告するか ──
  for (const [label, resp] of [
    ['HTTP 500 + JSON',  { ok:false, status:500, text: () => Promise.resolve('{"ok":false}') }],
    ['HTTP 200 + 壊れJSON', { ok:true,  status:200, text: () => Promise.resolve('{"ok":') }],
    ['HTTP 200 + HTML',  { ok:true,  status:200, text: () => Promise.resolve('<!DOCTYPE html><html>ページが見つかりません</html>') }]
  ]) {
    const b = boot(file, () => (url, init) =>
      (init && init.method === 'POST')
        ? Promise.resolve(resp)
        : Promise.resolve({ ok:true, status:200, text: () => Promise.resolve('{"ok":true}'), json: () => Promise.resolve({ ok:true }) }));
    await sleep(250);
    const wb = b.dom.window;
    const sb = wb.document.getElementById('scan-event-sel');
    sb.innerHTML = '<option value="EV-1">テスト会</option>'; sb.value = 'EV-1';
    await wb.processCheckIn('G-T4');
    await sleep(50);
    const shown = wb.document.getElementById('ci-retry-msg').textContent;
    A(label + ' → 再試行UIに落ちる', wb.document.getElementById('ci-retry-area').style.display === 'block');
    A(label + ' → 原因が文言に出る（「通信エラー」で潰さない）',
      /HTTP 500|JSONではありません/.test(shown));
    b.dom.window.close();
  }

  // ── 支払ボタン連打：2本目を弾き、表示とサーバ値がずれないか ──
  {
    const paid = { arrived:false, token:null, method:null };
    let calls = 0;
    const b = boot(file, () => (url, init) => {
      if (init && init.method === 'POST') {
        const body = JSON.parse(init.body);
        if (body.action !== 'checkIn') return Promise.resolve({ ok:true, status:200, text: () => Promise.resolve('{"ok":true}') });
        calls++;
        if (!paid.arrived) { paid.arrived = true; paid.token = body.checkin_token; paid.method = body.payment_method; }
        const replay = paid.token === body.checkin_token;
        return new Promise(r => setTimeout(() => r({ ok:true, status:200, text: () => Promise.resolve(JSON.stringify(
          { ok:true, status:'checked_in', replay, guest_id:body.guest_id, name:'テスト 太郎', pay_type:'paid', amount:5000, payment_method: paid.method }
        )) }), 60));
      }
      return Promise.resolve({ ok:true, status:200, text: () => Promise.resolve('{"ok":true}'), json: () => Promise.resolve({ ok:true }) });
    });
    await sleep(250);
    const wb = b.dom.window;
    const sb = wb.document.getElementById('scan-event-sel');
    sb.innerHTML = '<option value="EV-1">テスト会</option>'; sb.value = 'EV-1';
    wb.eval('pendingGuest = "G-PAY"');
    const p1 = wb.confirmPayment('cash');
    const p2 = wb.confirmPayment('card');   // 連打
    await Promise.all([p1, p2]);
    await sleep(80);
    A('連打しても送信は1本だけ', calls === 1);
    A('サーバに保存された方法は現金', paid.method === 'cash');
    A('画面表示も現金（カードに化けない）',
      wb.document.getElementById('scan-msg').textContent.indexOf('現金') >= 0);
    b.dom.window.close();
  }

  // ── 失敗後にイベント選択を切り替えても、再試行は元のイベント／同じトークンで送る ──
  {
    const seen = [];
    let down = true;
    const b = boot(file, () => (url, init) => {
      if (init && init.method === 'POST') {
        const body = JSON.parse(init.body);
        if (body.action === 'checkIn') {
          seen.push({ event_id: body.event_id, token: body.checkin_token });
          if (down) return Promise.reject(new TypeError('Load failed'));
          return Promise.resolve({ ok:true, status:200, text: () => Promise.resolve(JSON.stringify(
            { ok:true, status:'checked_in', replay:true, guest_id:body.guest_id, name:'テスト 太郎', pay_type:'free', amount:0 })) });
        }
      }
      return Promise.resolve({ ok:true, status:200, text: () => Promise.resolve('{"ok":true}'), json: () => Promise.resolve({ ok:true }) });
    });
    await sleep(250);
    const wb = b.dom.window;
    const sb = wb.document.getElementById('scan-event-sel');
    sb.innerHTML = '<option value="EV-1">A</option><option value="EV-2">B</option>';
    sb.value = 'EV-1';
    await wb.processCheckIn('G-CTX');
    await sleep(50);
    A('失敗後に再試行UIが出る', wb.document.getElementById('ci-retry-area').style.display === 'block');
    const firstTok = seen[0].token;
    sb.value = 'EV-2';                     // 受付が待っている間にイベントを切り替えてしまった
    down = false;
    await wb.retryLastCheckin();
    await sleep(50);
    const last = seen[seen.length - 1];
    A('再試行は失敗時のイベント(EV-1)へ送る', last.event_id === 'EV-1');
    A('再試行は同じトークンで送る', last.token === firstTok);
    b.dom.window.close();
  }

  dom.window.close();
  boot2.dom.window.close();
  boot3.dom.window.close();
}

(async () => {
  await runFile('admin.html');
  await runFile('entrance.html');
  console.log('\n' + (fail === 0 ? `—— 全合格 ✅（${pass}件）——` : `—— 不合格 ${fail}件 / 合格 ${pass}件 ❌ ——`));
  process.exit(fail === 0 ? 0 : 1);
})();
