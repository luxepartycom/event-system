// 検証ハーネス 層3（jsdom）: 受付端末 entrance.html を Node 内で実行し、
// チェックイン備考＋種別訂正機能が admin.html と同等に動くかを検証（重大1の移植確認）。
// 実行: NODE_PATH=~/.cache/claude-node/node_modules node test/jsdom-entrance-checkin.cjs
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, '..', 'entrance.html'), 'utf8');
const jsErrors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => jsErrors.push(e.message + (e.detail ? ' | ' + String(e.detail).slice(0, 200) : '')));

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  virtualConsole: vc,
  url: 'https://entry.luxepartytokyo.com/entrance.html',
  beforeParse(window) {
    window.fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }), text: () => Promise.resolve('') });
    if (!window.AbortController) window.AbortController = class { constructor(){ this.signal = {}; } abort(){} };
    window.navigator.mediaDevices = window.navigator.mediaDevices || { getUserMedia: () => Promise.reject(new Error('no cam')) };
  }
});

setTimeout(() => {
  const w = dom.window;
  let pass = 0, fail = 0;
  const A = (n, c) => { if (c) { pass++; console.log('✅ ' + n); } else { fail++; console.log('❌ ' + n); } };

  const fatal = jsErrors.filter(e => !/getUserMedia|mediaDevices|fetch|NetworkError|not implemented|Failed to|camera|ZXing|BarcodeDetector/i.test(e));
  A('entrance.html の致命的JSパース/実行エラー ゼロ', fatal.length === 0);
  fatal.forEach(e => console.log('   ⚠ ' + e));

  ['effPT','hasPTCorrection','setCiType','ciReadType','setCiMethod','ciReadMethod',
   'ciMarkDirty','populateCiEditor','saveCheckinInfoFromOverlay'].forEach(fn => {
    A('entrance ' + fn + ' 定義済み', typeof w[fn] === 'function');
  });

  A('entrance 完了オーバーレイに実態訂正エディタ(ok)', !!w.document.getElementById('cam-ci-editor-ok'));
  A('entrance 入場済みオーバーレイに実態訂正エディタ(dup)', !!w.document.getElementById('cam-ci-editor-dup'));

  if (typeof w.effPT === 'function') {
    A('entrance effPT: actual優先(free)', w.effPT({ pay_type: 'paid', actual_pay_type: 'free' }) === 'free');
    A('entrance effPT: 訂正なしは申込へ', w.effPT({ pay_type: 'paid', actual_pay_type: '' }) === 'paid');
  }
  if (typeof w.setCiType === 'function') {
    w.setCiType('ok', 'paid');
    A('entrance 有料選択で金額欄表示', w.document.getElementById('cam-ci-pay-ok').style.display === 'block');
    w.setCiMethod('ok', 'paypay');
    A('entrance ciReadMethod=paypay', w.ciReadMethod('ok') === 'paypay');
    A('entrance ciReadType=paid', w.ciReadType('ok') === 'paid');
  }
  if (typeof w.populateCiEditor === 'function') {
    w.populateCiEditor('dup', { guest_id: 'VIP-1' });
    A('entrance VIPはdupエディタ非表示', w.document.getElementById('cam-ci-editor-dup').style.display === 'none');
    w.populateCiEditor('dup', { guest_id: 'G-y', actual_pay_type: 'free', staff_note: 'n' });
    A('entrance 通常ゲストはdupエディタ表示', w.document.getElementById('cam-ci-editor-dup').style.display === 'block');
    A('entrance dup備考反映', w.document.getElementById('cam-ci-note-dup').value === 'n');
  }

  console.log('\n=== 層3(entrance jsdom) 結果: ' + pass + ' 合格 / ' + fail + ' 不合格 ===');
  process.exit(fail === 0 ? 0 : 1);
}, 800);
