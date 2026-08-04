// 検証ハーネス 層3（jsdom）: 実 index.html を Node 内で実行し、
// (1) 私の編集でJSパース/実行エラーが出ていないか (2)②の関数が実ページで期待通り動くか を検証。
// 実行: NODE_PATH=~/.cache/claude-node/node_modules node test/jsdom-harness.cjs
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const jsErrors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => jsErrors.push(e.message + (e.detail ? ' | ' + String(e.detail).slice(0, 200) : '')));

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  virtualConsole: vc,
  url: 'https://entry.luxepartytokyo.com/index.html?e=EV-MS45773V&type=free',
  beforeParse(window) {
    // ネットワーク遮断環境で load handler を通すため fetch をモック
    window.fetch = (url, opts) => {
      const body = opts && opts.body ? String(opts.body) : '';
      let resp = { ok: true };
      if (String(url).includes('getEvents') || body.includes('getEvents')) resp = { ok: true, events: [] };
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(resp), text: () => Promise.resolve('') });
    };
    if (!window.AbortController) window.AbortController = class { constructor(){ this.signal = {}; } abort(){} };
  }
});

setTimeout(() => {
  const w = dom.window;
  let pass = 0, fail = 0;
  const A = (n, c) => { if (c) { pass++; console.log('✅ ' + n); } else { fail++; console.log('❌ ' + n); } };

  A('実HTMLのJSパース/実行エラー ゼロ', jsErrors.length === 0);
  jsErrors.forEach(e => console.log('   ⚠ ' + e));

  A('subIdFor 定義済み', typeof w.subIdFor === 'function');
  A('clearPendingSubId 定義済み', typeof w.clearPendingSubId === 'function');
  A('submitForm 定義済み', typeof w.submitForm === 'function');
  A('genSubId 定義済み', typeof w.genSubId === 'function');

  if (typeof w.subIdFor === 'function') {
    const x1 = w.subIdFor('k1'), x2 = w.subIdFor('k1'), y1 = w.subIdFor('k2');
    A('実ページ subIdFor: 同一key→同一ID（連打で重複しない）', x1 === x2);
    A('実ページ subIdFor: 別key→別ID（誤dedupしない）', y1 !== x1);
    w.clearPendingSubId();
    A('実ページ subIdFor: clear後は新規ID（次の申込は別行）', w.subIdFor('k1') !== x1);
  }

  console.log('\n=== 層3(jsdom) 結果: ' + pass + ' 合格 / ' + fail + ' 不合格 ===');
  process.exit(fail === 0 ? 0 : 1);
}, 600);
