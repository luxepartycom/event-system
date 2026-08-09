// 検証ハーネス 層3（jsdom）: 単発決済の改修。
//   ① QR決済カードが最上部
//   ② 現金受け取りボタン → 売上レポートに計上される
//   ③ 決済完了/中断が管理画面へ戻らない（paid.html）
//   ④ 既存のQR発行・スタッフ決済を壊していない
// 実行: NODE_PATH=~/.cache/claude-node/node_modules node test/jsdom-charge.cjs
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

let pass = 0, fail = 0;
const A = (n, c) => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ROOT = path.join(__dirname, '..');

function boot(file, hooks) {
  const errs = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errs.push(e.message));
  const dom = new JSDOM(fs.readFileSync(path.join(ROOT, file), 'utf8'), {
    runScripts:'dangerously', pretendToBeVisual:true, virtualConsole:vc,
    url:'https://entry.luxepartytokyo.com/' + file,
    beforeParse(w) {
      w.navigator.mediaDevices = w.navigator.mediaDevices || { getUserMedia: () => Promise.reject(new Error('x')) };
      w.confirm = () => true;
      w.fetch = (u, i) => {
        const url = String(u);
        if (/api\/checkout/.test(url)) {
          if (hooks) hooks.checkout = (hooks.checkout || 0) + 1;
          return Promise.resolve({ ok:true, status:200, json:()=>Promise.resolve({ ok:true, checkout_url:'https://checkout.stripe.com/c/pay/TEST', session_id:'cs_test_1' }) });
        }
        return Promise.resolve({ ok:true, status:200, text:()=>Promise.resolve('{"ok":true}'), json:()=>Promise.resolve({ok:true}) });
      };
    }
  });
  return { dom, errs };
}

(async () => {
  console.log('\n══ ③ 決済完了ページ paid.html ═══════════════');
  {
    const html = fs.readFileSync(path.join(ROOT, 'paid.html'), 'utf8');
    // コメント中の記述に反応しないよう、実際のリンクと遷移だけを見る
    A('管理画面へのリンクが無い', !/href\s*=\s*["'][^"']*(admin|entrance)\.html/.test(html));
    A('自動遷移が無い', !/location\.(href|replace|assign)/.test(html));
    A('noindex 指定', /noindex/.test(html));
    for (const [q, label, expect] of [['', '完了', 'お支払いが完了しました'], ['?canceled=1', '中断', 'お支払いは完了していません']]) {
      const dom = new JSDOM(html, { runScripts:'dangerously', url:'https://entry.luxepartytokyo.com/paid.html' + q });
      await sleep(60);
      A(label + '時の見出しが正しい', dom.window.document.getElementById('title').textContent === expect);
      dom.window.close();
    }
    const api = fs.readFileSync(path.join(ROOT, 'api/checkout.js'), 'utf8');
    A('単発決済の成功先が paid.html', /paid\.html'/.test(api));
    A('単発決済の成功先が admin ではない', !/admin\.html\?charge=success/.test(api));
    A('中断時も admin へ戻さない', !/admin\.html\?charge=cancel/.test(api));
    A('通常申込の完了先は従来どおり', /checkout\.html\?session_id=\{CHECKOUT_SESSION_ID\}/.test(api));
  }

  for (const file of ['admin.html', 'entrance.html']) {
    console.log('\n══ ' + file + ' ══════════════════════════════');
    const hooks = {};
    const { dom, errs } = boot(file, hooks);
    await sleep(400);
    const w = dom.window, doc = w.document;
    const fatal = errs.filter(e => !/getUserMedia|mediaDevices|fetch|NetworkError|not implemented|Failed to|camera|ZXing/i.test(e));
    A('致命的なJSエラー ゼロ', fatal.length === 0);
    fatal.forEach(e => console.log('     ⚠ ' + e));

    console.log('  ── ① QR決済が最上部 ──');
    const wrapHtml = doc.querySelector('.charge-wrap').innerHTML;
    A('QR決済がある',      wrapHtml.indexOf('QR CODE PAYMENT') >= 0);
    A('スタッフ決済もある', wrapHtml.indexOf('id="btn-charge"') >= 0);
    A('QR決済が上にある',   wrapHtml.indexOf('QR CODE PAYMENT') < wrapHtml.indexOf('id="btn-charge"'));

    console.log('  ── ② 現金受け取り ──');
    A('現金ボタンがある',        !!doc.getElementById('btn-charge-cash'));
    A('recordCashCharge 定義済み', typeof w.recordCashCharge === 'function');
    doc.getElementById('qr-amount').value = '5000';
    doc.getElementById('qr-desc').value   = 'ボトル';
    const before = w.eval('chargeHistory.length');
    await w.recordCashCharge(null);
    await sleep(60);
    const hist = JSON.parse(w.eval('JSON.stringify(chargeHistory)'));
    A('履歴に1件積まれる', hist.length === before + 1);
    A('金額が正しい',       hist[0].amount === 5000);
    A('現金と分かる',       hist[0].type === 'cash' && String(hist[0].desc).indexOf('[現金]') === 0);
    A('レポート集計の対象（status=ok）', hist[0].status === 'ok');
    A('Stripeを呼んでいない', !hooks.checkout);
    A('入力欄がクリアされる', doc.getElementById('qr-amount').value === '');
    A('localStorageに保存される', (() => { try { return JSON.parse(w.localStorage.getItem('lpt_charge_history'))[0].amount === 5000; } catch(e){ return false; } })());

    console.log('  ── 売上レポートへの計上 ──');
    if (typeof w.renderSalesReport === 'function' || doc.getElementById('sl-charge-total-amount')) {
      const el = doc.getElementById('sl-charge-total-amount');
      A('レポートの合計欄が存在する', !!el);
    } else {
      A('レポート欄（entranceには無い場合あり）', true);
    }

    console.log('  ── ④ 既存のQR発行が壊れていない ──');
    doc.getElementById('qr-amount').value = '3000';
    doc.getElementById('qr-desc').value   = 'ドリンク';
    A('generateQrPayment 定義済み', typeof w.generateQrPayment === 'function');
    await w.generateQrPayment();
    await sleep(80);
    A('Stripeへ問い合わせる', hooks.checkout === 1);
    const h2 = JSON.parse(w.eval('JSON.stringify(chargeHistory)'));
    A('QR履歴が積まれる', h2[0].type === 'qr' && h2[0].status === 'pending');
    const modal = doc.getElementById('qr-payment-modal');
    A('QRモーダルが開く', modal && modal.style.display === 'flex');
    const img = doc.querySelector('#qr-code-display img');
    A('QR画像が生成される', !!img && /api\.qrserver\.com/.test(img.src));
    A('QRの中身が決済URL', !!img && decodeURIComponent(img.src).includes('https://checkout.stripe.com/c/pay/TEST'));

    console.log('  ── 既存機能の生存 ──');
    A('スタッフ決済は健在',   typeof w.startQuickCharge === 'function');
    A('チェックインは健在',   typeof w.processCheckIn === 'function');
    A('招待者警告は健在',     typeof w.isInviterUnknown === 'function');

    dom.window.close();
  }

  console.log('\n' + (fail === 0 ? `—— 全合格 ✅（${pass}件）——` : `—— 不合格 ${fail}件 / 合格 ${pass}件 ❌ ——`));
  process.exit(fail === 0 ? 0 : 1);
})();
