// 検証ハーネス 層3（jsdom）: VIPタブの並び替え・更新ボタン・速度改善・卓番号表示。
// 実行: NODE_PATH=~/.cache/claude-node/node_modules node test/jsdom-vip-tab.cjs
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

let pass = 0, fail = 0;
const A = (n, c) => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const TABLES = { ok: true, tables: [
  { table_id:'T1', guest_id:'VIP-1', table_name:'V5', table_type:'ROYAL', capacity:4, price:300000, status:'confirmed', reserved_by:'中川彰悟', checked_count:0, event_id:'EV-A' }
]};
const RESV = { ok: true, reservations: [
  { reservation_id:'R1', guest_id:'VIP-1', table_name:'V5', table_type:'ROYAL', name:'中川彰悟', status:'confirmed', payment_method:'stripe', event_id:'EV-A' }
]};

function boot(counter) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
  const errs = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errs.push(e.message));
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    url: 'https://entry.luxepartytokyo.com/admin.html',
    beforeParse(w) {
      w.navigator.mediaDevices = w.navigator.mediaDevices || { getUserMedia: () => Promise.reject(new Error('no cam')) };
      w.confirm = () => true;
      w.fetch = (url, init) => {
        const u = String(url);
        const isPost = init && init.method === 'POST';
        if (!isPost) {
          if (/getVipTables/.test(u))       { counter.tables++;  return resp(TABLES); }
          if (/getVipReservations/.test(u)) { counter.resv++;    return resp(RESV); }
          if (/action=ping/.test(u))        { counter.ping++;    return resp({ ok:true }); }
          return resp({ ok: true, events: [] });
        }
        const b = JSON.parse(init.body);
        if (b.action === 'checkIn') {
          counter.checkin++;
          return resp({ ok:true, status:'checked_in', guest_id:b.guest_id, name:'中川彰悟',
            vip_info:{ table_name:'V5', table_type:'ROYAL', capacity:4, checked_count:1, is_over:false } });
        }
        return resp({ ok: true });
      };
      function resp(o){ return Promise.resolve({ ok:true, status:200, text:()=>Promise.resolve(JSON.stringify(o)), json:()=>Promise.resolve(o) }); }
    }
  });
  return { dom, errs };
}

(async () => {
  const counter = { tables:0, resv:0, ping:0, checkin:0 };
  const { dom, errs } = boot(counter);
  await sleep(400);
  const w = dom.window, doc = w.document;

  console.log('\n── 読み込み ────────────────────────────────');
  const fatal = errs.filter(e => !/getUserMedia|mediaDevices|fetch|NetworkError|not implemented|Failed to|camera|ZXing/i.test(e));
  A('致命的なJSエラー ゼロ', fatal.length === 0);
  fatal.forEach(e => console.log('     ⚠ ' + e));

  console.log('\n── ① セクションの並び順 ─────────────────────');
  {
    const vc = doc.getElementById('vip-content');
    A('vip-content がある', !!vc);
    const html = vc.innerHTML;
    const iResv = html.indexOf('予約一覧');
    const iSeat = html.indexOf('座席表（座席画像）');
    const iTbl  = html.indexOf('テーブル一覧');
    const iReg  = html.indexOf('新規VIP登録');
    A('予約一覧が最上部', iResv >= 0 && iResv < iSeat);
    A('その下が座席表',   iSeat >= 0 && iSeat < iTbl);
    A('テーブル一覧・新規登録が続く', iTbl < iReg);
  }

  console.log('\n── ④ 更新ボタン ────────────────────────────');
  {
    A('refreshVipReservations 定義済み', typeof w.refreshVipReservations === 'function');
    A('refreshVipTables 定義済み',       typeof w.refreshVipTables === 'function');
    A('refreshVipSeat 定義済み',         typeof w.refreshVipSeat === 'function');
    const btns = [...doc.querySelectorAll('#vip-content button')].map(b => b.getAttribute('onclick') || '');
    A('予約一覧に更新ボタンがある',   btns.some(o => o.includes('refreshVipReservations')));
    A('座席表に更新ボタンがある',     btns.some(o => o.includes('refreshVipSeat')));
    A('テーブル一覧に更新ボタンがある', btns.some(o => o.includes('refreshVipTables')));
  }

  console.log('\n── ③ 表示速度：キャッシュ即表示 ──────────────');
  {
    const sel = doc.getElementById('vip-event-sel');
    sel.innerHTML = '<option value="EV-A">テスト会</option>';
    sel.value = 'EV-A';
    await w.onVipEventChange();
    await sleep(120);
    A('初回は取得が走る', counter.tables === 1 && counter.resv === 1);
    A('暖機pingを撃つ', counter.ping >= 1);
    A('予約一覧が描画される', doc.getElementById('vip-reservation-list').textContent.includes('中川彰悟'));

    const before = counter.tables;
    await w.loadVipData();          // 2回目＝キャッシュ即表示
    A('2回目は描画を待たずに済む（中身が残る）',
      doc.getElementById('vip-reservation-list').textContent.includes('中川彰悟'));
    await sleep(150);
    A('裏で最新化している', counter.tables > before);
  }

  console.log('\n── ② 来場ボタン：再取得を待たない ─────────────');
  {
    const t0 = Date.now();
    const before = counter.tables;
    await w.manualVipCheckIn('VIP-1', '中川彰悟', null);
    const elapsed = Date.now() - t0;
    A('チェックイン要求は1回だけ', counter.checkin === 1);
    A('再取得の完了を待たずに戻る', elapsed < 200);
    A('手元データが即座に来場済みになる',
      w.eval('vipTables[0].arrived') === 'TRUE' && w.eval('vipTables[0].checked_count') === 1);
    await sleep(200);
    A('裏で最新化される', counter.tables > before);
  }

  console.log('\n── ⑤ スキャン後の卓番号表示 ────────────────');
  {
    const d = { ok:true, status:'checked_in', guest_id:'VIP-1', name:'中川彰悟', pay_type:'paid', amount:300000,
                vip_info:{ table_name:'V5', table_type:'ROYAL', capacity:4, checked_count:1, is_over:false } };
    w.showCamOverlay(d, 'ok');
    const el = doc.getElementById('cam-ok-vip');
    A('VIP表示が出る', el && el.style.display === 'block');
    const nameSize = (w.getComputedStyle(doc.getElementById('cam-ok-name')).fontSize) || '1.3rem';
    A('卓番号が名前と同じ大きさ(1.3rem)で出る', /font-size:1\.3rem/.test(el.innerHTML));
    A('卓番号が最初に来る（主役）', el.innerHTML.indexOf('V5') < el.innerHTML.indexOf('ROYAL'));
    A('人数も残っている', el.innerHTML.includes('1 / 4名'));
    // 超過時
    d.vip_info = { table_name:'V5', table_type:'ROYAL', capacity:4, checked_count:5, is_over:true };
    w.showCamOverlay(d, 'ok');
    A('超過時も卓番号が1.3rem', /font-size:1\.3rem/.test(doc.getElementById('cam-ok-vip').innerHTML));
    A('超過の警告文が残る', doc.getElementById('cam-ok-vip').innerHTML.includes('上限超過'));
    console.log('     名前のサイズ = ' + nameSize);
  }

  dom.window.close();
  console.log('\n' + (fail === 0 ? `—— 全合格 ✅（${pass}件）——` : `—— 不合格 ${fail}件 / 合格 ${pass}件 ❌ ——`));
  process.exit(fail === 0 ? 0 : 1);
})();
