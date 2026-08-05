// 検証ハーネス 層3（jsdom）: 実 admin.html を Node 内で実行し、
// (1) 私の編集で admin.html にJSパース/実行エラーが出ていないか
// (2) チェックイン備考＋種別訂正の関数群が実ページで定義・動作するか を検証。
// 実行: NODE_PATH=~/.cache/claude-node/node_modules node test/jsdom-admin-checkin.cjs
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
const jsErrors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => jsErrors.push(e.message + (e.detail ? ' | ' + String(e.detail).slice(0, 200) : '')));

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  virtualConsole: vc,
  url: 'https://entry.luxepartytokyo.com/admin.html',
  beforeParse(window) {
    window.fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }), text: () => Promise.resolve('') });
    if (!window.AbortController) window.AbortController = class { constructor(){ this.signal = {}; } abort(){} };
    // カメラ/QR系APIのスタブ（未定義参照での実行時エラー回避）
    window.navigator.mediaDevices = window.navigator.mediaDevices || { getUserMedia: () => Promise.reject(new Error('no cam')) };
  }
});

setTimeout(() => {
  const w = dom.window;
  let pass = 0, fail = 0;
  const A = (n, c) => { if (c) { pass++; console.log('✅ ' + n); } else { fail++; console.log('❌ ' + n); } };

  // load時の実行エラーのうち、カメラ/ネットワーク由来の既知ノイズは除外
  const fatal = jsErrors.filter(e => !/getUserMedia|mediaDevices|fetch|NetworkError|not implemented|Failed to|camera|ZXing|BarcodeDetector/i.test(e));
  A('admin.html の致命的JSパース/実行エラー ゼロ', fatal.length === 0);
  fatal.forEach(e => console.log('   ⚠ ' + e));

  A('effPT 定義済み', typeof w.effPT === 'function');
  A('hasPTCorrection 定義済み', typeof w.hasPTCorrection === 'function');
  A('setCiType 定義済み', typeof w.setCiType === 'function');
  A('saveCheckinInfoFromOverlay 定義済み', typeof w.saveCheckinInfoFromOverlay === 'function');
  A('saveGuestEdit 定義済み', typeof w.saveGuestEdit === 'function');
  A('openEditGuest 定義済み', typeof w.openEditGuest === 'function');

  if (typeof w.effPT === 'function') {
    A('実ページ effPT: actual優先(free)', w.effPT({ pay_type: 'paid', actual_pay_type: 'free' }) === 'free');
    A('実ページ effPT: 訂正なしは申込へ', w.effPT({ pay_type: 'paid', actual_pay_type: '' }) === 'paid');
  }

  A('populateCiEditor 定義済み', typeof w.populateCiEditor === 'function');
  A('ciReadType 定義済み', typeof w.ciReadType === 'function');

  // 新規DOM要素が存在するか（ok=新規完了 / dup=入場済み の両scope）
  A('完了オーバーレイに実態訂正エディタ(ok)が存在', !!w.document.getElementById('cam-ci-editor-ok'));
  A('入場済みオーバーレイに実態訂正エディタ(dup)が存在', !!w.document.getElementById('cam-ci-editor-dup'));
  A('編集モーダルに実態種別セレクトが存在', !!w.document.getElementById('eg-actual-type'));
  A('編集モーダルに備考textareaが存在', !!w.document.getElementById('eg-note'));

  // setCiType / ciReadType が scope 単位で active を付け替える
  if (typeof w.setCiType === 'function' && w.document.getElementById('cam-ci-type-btns-ok')) {
    w.setCiType('ok', 'free');
    const activeFree = w.document.querySelector('#cam-ci-type-btns-ok .cam-ci-type[data-v="free"]');
    A('setCiType("ok","free") で free ボタンが active', activeFree && activeFree.classList.contains('active'));
    A('ciReadType("ok") が free を返す', w.ciReadType('ok') === 'free');
    w.setCiType('ok', '');
    A('setCiType("ok","") で active 解除', activeFree && !activeFree.classList.contains('active'));
    A('ciReadType("ok") が空を返す', w.ciReadType('ok') === '');
    // dup scope は ok と独立
    w.setCiType('dup', 'paid');
    A('ciReadType("dup") が paid（scope独立）', w.ciReadType('dup') === 'paid');
    A('ok scope は影響を受けない', w.ciReadType('ok') === '');
  }

  // 金額/支払方法（中4）
  A('setCiMethod 定義済み', typeof w.setCiMethod === 'function');
  A('ciReadMethod 定義済み', typeof w.ciReadMethod === 'function');
  A('ciMarkDirty 定義済み', typeof w.ciMarkDirty === 'function');
  if (typeof w.setCiType === 'function') {
    w.setCiType('ok', 'paid');
    A('有料選択で金額/支払方法欄が表示', w.document.getElementById('cam-ci-pay-ok').style.display === 'block');
    w.setCiMethod('ok', 'card');
    A('ciReadMethod("ok")=card', w.ciReadMethod('ok') === 'card');
    w.setCiType('ok', 'free');
    A('無料選択で金額/支払方法欄が非表示', w.document.getElementById('cam-ci-pay-ok').style.display === 'none');
  }

  // populateCiEditor: VIPは非表示、通常ゲストは表示、金額/method反映
  if (typeof w.populateCiEditor === 'function') {
    w.populateCiEditor('ok', { guest_id: 'VIP-3', actual_pay_type: '', staff_note: '' });
    A('VIPは実態訂正エディタ非表示', w.document.getElementById('cam-ci-editor-ok').style.display === 'none');
    w.populateCiEditor('ok', { guest_id: 'G-abc12345', actual_pay_type: 'paid', staff_note: 'メモ', amount: 5000, payment_method: 'cash' });
    A('通常ゲストは実態訂正エディタ表示', w.document.getElementById('cam-ci-editor-ok').style.display === 'block');
    A('既存備考が反映される', w.document.getElementById('cam-ci-note-ok').value === 'メモ');
    A('既存actual_pay_typeが反映される(paid)', w.ciReadType('ok') === 'paid');
    A('paidなら金額欄表示', w.document.getElementById('cam-ci-pay-ok').style.display === 'block');
    A('既存金額が反映される', Number(w.document.getElementById('cam-ci-amount-ok').value) === 5000);
    A('既存支払方法が反映される', w.ciReadMethod('ok') === 'cash');
  }

  console.log('\n=== 層3(admin jsdom) 結果: ' + pass + ' 合格 / ' + fail + ' 不合格 ===');
  process.exit(fail === 0 ? 0 : 1);
}, 800);
