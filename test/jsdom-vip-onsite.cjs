// 検証ハーネス 層3（jsdom）: VIPのその場販売。
//   ① entrance にも新規VIP登録フォームがある
//   ② メールアドレスは任意（QR/現金では不要・メール送信方式でのみ必須）
//   ③ QR選択 → 決済QRを表示（お客様の端末で決済）
//   ④ 現金選択 → createVipCash で即確定
//   ⑤ 既存のメール送信方式を壊していない
// 実行: NODE_PATH=~/.cache/claude-node/node_modules node test/jsdom-vip-onsite.cjs
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

let pass = 0, fail = 0;
const A = (n, c) => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ROOT = path.join(__dirname, '..');

const TABLES = { ok:true, tables:[
  { table_id:'T1', table_name:'V5', table_type:'ROYAL', capacity:4, price:300000, status:'available', event_id:'EV-A' },
  { table_id:'T2', table_name:'V6', table_type:'SOFA',  capacity:2, price:100000, status:'confirmed', event_id:'EV-A', reserved_by:'既存様', guest_id:'VIP-9' }
]};
const RESV = { ok:true, reservations:[] };
const EVENTS = { ok:true, events:[{ event_id:'EV-A', name:'テスト会', status:'active' }] };

function boot(file, sent) {
  const errs = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errs.push(e.message));
  const dom = new JSDOM(fs.readFileSync(path.join(ROOT, file), 'utf8'), {
    runScripts:'dangerously', pretendToBeVisual:true, virtualConsole:vc,
    url:'https://entry.luxepartytokyo.com/' + file,
    beforeParse(w) {
      w.navigator.mediaDevices = w.navigator.mediaDevices || { getUserMedia: () => Promise.reject(new Error('x')) };
      w.confirm = () => true;
      const R = o => Promise.resolve({ ok:true, status:200, text:()=>Promise.resolve(JSON.stringify(o)), json:()=>Promise.resolve(o) });
      w.fetch = (u, i) => {
        let url = String(u);
        // E0b: 読み取り（apiGet）は POST の本文で来る（GAS の橋）。GET と同じ扱いにする
        if (i && i.method === 'POST') { const rb = JSON.parse(i.body); if (['auth','ping','getEvents','getGuests','getPromoUrls','getPromoGroups','getVipTables','getVipReservations','migrateEventPlans'].includes(rb.action)) { url += '?action=' + rb.action; i = null; } }
        if (i && i.method === 'POST' && /script\.google\.com/.test(url)) {
          const b = JSON.parse(i.body);
          sent.push(b);
          if (b.action === 'createVipStripeLink') return R({ ok:true, guest_id:'VIP-1', table_name:'V5', checkout_url:'https://checkout.stripe.com/c/pay/VIPTEST' });
          if (b.action === 'createVipCash')       return R({ ok:true, guest_id:'VIP-2', table_name:'V5', amount:300000, payment_method:'cash', qr_url:'https://entry.luxepartytokyo.com/vip-ticket.html?id=VIP-2' });
          if (b.action === 'createVipTransfer')   return R({ ok:true, guest_id:'VIP-3', table_name:'V5' });
          return R({ ok:true });
        }
        if (/getVipTables/.test(url))       return R(TABLES);
        if (/getVipReservations/.test(url)) return R(RESV);
        if (/getEvents/.test(url))          return R(EVENTS);
        return R({ ok:true });
      };
    }
  });
  return { dom, errs };
}

// admin と entrance で要素IDが違う（entrance は -e サフィックス）
const CONF = {
  'admin.html':    { suffix:'',   submit:'submitVipRegistration',  loadArgs:'vipEventId = "EV-A"',  tablesVar:'vipTables' },
  'entrance.html': { suffix:'-e', submit:'submitVipRegistrationE', loadArgs:'vipEventIdE = "EV-A"', tablesVar:'vipTablesE' }
};

(async () => {
  for (const file of Object.keys(CONF)) {
    const c = CONF[file];
    console.log('\n══ ' + file + ' ══════════════════════════════');
    const sent = [];
    const { dom, errs } = boot(file, sent);
    await sleep(400);
    const w = dom.window, doc = w.document;
    const id = base => doc.getElementById(base + c.suffix);

    const fatal = errs.filter(e => !/getUserMedia|mediaDevices|fetch|NetworkError|not implemented|Failed to|camera|ZXing/i.test(e));
    A('致命的なJSエラー ゼロ', fatal.length === 0);
    fatal.forEach(e => console.log('     ⚠ ' + e));

    console.log('  ── ① フォームの存在 ──');
    A('登録フォームがある',   !!id('vip-reg-table') && !!id('vip-reg-name'));
    A('決済方法の選択がある', !!id('vip-reg-pay'));
    A('登録関数が定義済み',   typeof w[c.submit] === 'function');
    const opts = [...id('vip-reg-pay').options].map(o => o.value);
    A('QR方式がある',   opts.includes('qr'));
    A('現金方式がある', opts.includes('cash'));
    A('従来のメール方式も残る', opts.includes('stripe') && opts.includes('transfer'));

    console.log('  ── ② メールは任意 ──');
    A('ラベルが「任意」になっている',
      /任意/.test(doc.querySelector('label[for], label') ? id('vip-reg-email').previousElementSibling.textContent : ''));

    // 準備：テーブル一覧を手元に入れる
    w.eval(c.tablesVar + ' = ' + JSON.stringify(TABLES.tables));
    w.eval(c.loadArgs);
    if (typeof w.renderVipRegTableSelectE === 'function') w.renderVipRegTableSelectE();
    if (typeof w.renderVipTableSelect === 'function')     w.renderVipTableSelect();
    await sleep(50);
    const optIds = [...id('vip-reg-table').options].map(o => o.value).filter(Boolean);
    A('空き卓だけが選べる', optIds.includes('T1') && !optIds.includes('T2'));

    console.log('  ── ③ QRで販売 ──');
    id('vip-reg-table').value = 'T1';
    id('vip-reg-pay').value   = 'qr';
    id('vip-reg-name').value  = '当日 太郎';
    id('vip-reg-email').value = '';           // 空欄で通ること
    await w[c.submit]();
    await sleep(120);
    const qrReq = sent.find(x => x.action === 'createVipStripeLink');
    A('メール未入力でもエラーにならない', id('vip-reg-error' ) === null ? true : id('vip-reg-error').style.display !== 'block');
    A('createVipStripeLink を呼ぶ', !!qrReq);
    A('table_id と氏名を送る', qrReq && qrReq.table_id === 'T1' && qrReq.name === '当日 太郎');
    const modal = doc.getElementById('qr-payment-modal');
    A('QRモーダルが開く', modal && modal.style.display === 'flex');
    const img = doc.querySelector('#qr-code-display img');
    A('QRの中身が決済URL', !!img && decodeURIComponent(img.src).includes('https://checkout.stripe.com/c/pay/VIPTEST'));

    console.log('  ── ④ 現金で販売 ──');
    sent.length = 0;
    id('vip-reg-table').value = 'T1';
    id('vip-reg-pay').value   = 'cash';
    id('vip-reg-name').value  = '現金 花子';
    id('vip-reg-email').value = '';
    await w[c.submit]();
    await sleep(120);
    const cashReq = sent.find(x => x.action === 'createVipCash');
    A('createVipCash を呼ぶ', !!cashReq);
    A('Stripeは呼ばない', !sent.some(x => x.action === 'createVipStripeLink'));
    A('入力欄がクリアされる', id('vip-reg-name').value === '');

    console.log('  ── ⑤ メール送信方式は宛先必須のまま ──');
    sent.length = 0;
    id('vip-reg-table').value = 'T1';
    id('vip-reg-pay').value   = 'stripe';
    id('vip-reg-name').value  = 'メール 三郎';
    id('vip-reg-email').value = '';
    await w[c.submit]();
    await sleep(80);
    A('宛先なしは送信せずエラー表示', sent.length === 0 && id('vip-reg-error').style.display === 'block');
    A('文言でその場販売へ誘導', /QRを表示|現金/.test(id('vip-reg-error').textContent));
    id('vip-reg-email').value = 'a@example.com';
    await w[c.submit]();
    await sleep(120);
    A('宛先ありなら従来どおり送信', sent.some(x => x.action === 'createVipStripeLink'));

    console.log('  ── 既存機能の生存 ──');
    A('チェックインは健在',   typeof w.processCheckIn === 'function');
    A('招待者警告は健在',     typeof w.isInviterUnknown === 'function');
    A('単発決済QRは健在',     typeof w.generateQrPayment === 'function');
    A('現金受取は健在',       typeof w.recordCashCharge === 'function');

    dom.window.close();
  }

  console.log('\n' + (fail === 0 ? `—— 全合格 ✅（${pass}件）——` : `—— 不合格 ${fail}件 / 合格 ${pass}件 ❌ ——`));
  process.exit(fail === 0 ? 0 : 1);
})();
