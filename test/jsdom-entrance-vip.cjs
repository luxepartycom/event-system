// 検証ハーネス 層3（jsdom）: entrance.html の VIP画面を admin と同じ構成へ揃えた件。
//   ① 予約一覧が最上部・その下に座席表
//   ② 座席表は admin と同じ Drive画像方式（旧SVGフロアマップは撤去）
//   ③ Drive共有URL → 直リンク変換
//   ④ 画像が出ないときは共有設定を案内する
//   ⑤ 更新ボタン
// 実行: NODE_PATH=~/.cache/claude-node/node_modules node test/jsdom-entrance-vip.cjs
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

let pass = 0, fail = 0;
const A = (n, c) => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const EVENTS = { ok: true, events: [
  { event_id:'EV-A', name:'テスト会', date:'2026-08-09T15:00:00.000Z', status:'active',
    vip_seat_image:'https://drive.google.com/file/d/1opkofDUwWuyqxpTdqeVfMSglVziaJyNS/view?usp=drive_link' },
  { event_id:'EV-B', name:'画像なし会', date:'2026-09-01T15:00:00.000Z', status:'active' }
]};
const TABLES = { ok:true, tables:[{ table_id:'T1', guest_id:'VIP-1', table_name:'V5', table_type:'ROYAL',
  capacity:4, price:300000, status:'confirmed', reserved_by:'中川彰悟', checked_count:0, event_id:'EV-A' }] };
const RESV = { ok:true, reservations:[{ reservation_id:'R1', guest_id:'VIP-1', table_name:'V5', table_type:'ROYAL',
  name:'中川彰悟', status:'confirmed', payment_method:'stripe', event_id:'EV-A' }] };

function boot(counter) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'entrance.html'), 'utf8');
  const errs = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errs.push(e.message));
  const dom = new JSDOM(html, {
    runScripts:'dangerously', pretendToBeVisual:true, virtualConsole:vc,
    url:'https://entry.luxepartytokyo.com/entrance.html',
    beforeParse(w) {
      w.navigator.mediaDevices = w.navigator.mediaDevices || { getUserMedia: () => Promise.reject(new Error('x')) };
      const R = o => Promise.resolve({ ok:true, status:200, text:()=>Promise.resolve(JSON.stringify(o)), json:()=>Promise.resolve(o) });
      w.fetch = (url, init) => {
        const u = String(url);
        if (init && init.method === 'POST') return R({ ok:true });
        if (/getVipTables/.test(u))       { counter.t++; return R(TABLES); }
        if (/getVipReservations/.test(u)) { counter.r++; return R(RESV); }
        if (/getEvents/.test(u))          { counter.e++; return R(EVENTS); }
        return R({ ok:true });
      };
    }
  });
  return { dom, errs };
}

(async () => {
  const counter = { t:0, r:0, e:0 };
  const { dom, errs } = boot(counter);
  await sleep(400);
  const w = dom.window, doc = w.document;

  console.log('\n── 読み込み ────────────────────────────────');
  const fatal = errs.filter(e => !/getUserMedia|mediaDevices|fetch|NetworkError|not implemented|Failed to|camera|ZXing|Could not load img/i.test(e));
  A('致命的なJSエラー ゼロ', fatal.length === 0);
  fatal.forEach(e => console.log('     ⚠ ' + e));

  console.log('\n── ① 並び順（予約一覧 → 座席表）────────────');
  {
    const vc = doc.getElementById('vip-content-e');
    A('vip-content-e がある', !!vc);
    const h = vc.innerHTML;
    const iResv = h.indexOf('予約一覧');
    const iSeat = h.indexOf('座席表');
    A('予約一覧がある',  iResv >= 0);
    A('座席表がある',    iSeat >= 0);
    A('予約一覧が座席表より上', iResv >= 0 && iSeat >= 0 && iResv < iSeat);
  }

  console.log('\n── ② 旧SVGフロアマップが撤去されている ────────');
  {
    A('旧フロアマップの器が無い',   !doc.getElementById('floor-b1f-e') && !doc.getElementById('floor-1f-e'));
    A('旧タブが無い',               !doc.getElementById('floortab-b1f-e'));
    A('旧オーバーレイが無い',       !doc.getElementById('vip-svg-tables-e-b1f'));
    A('renderVipMapE は残っていない', typeof w.renderVipMapE === 'undefined');
    A('showFloorE は残っていない',    typeof w.showFloorE === 'undefined');
    A('座席表の器がある',           !!doc.getElementById('vip-seat-img-e') && !!doc.getElementById('vip-seat-placeholder-e'));
  }

  console.log('\n── ③ Drive共有URLの直リンク変換 ──────────────');
  {
    A('toDirectImageUrlE 定義済み', typeof w.toDirectImageUrlE === 'function');
    const f = w.toDirectImageUrlE;
    A('/file/d/<id>/view を変換',
      f('https://drive.google.com/file/d/ABC_123-x/view?usp=drive_link') === 'https://drive.google.com/thumbnail?id=ABC_123-x&sz=w2000');
    A('?id=<id> 形式も変換',
      f('https://drive.google.com/open?id=ABC_123-x') === 'https://drive.google.com/thumbnail?id=ABC_123-x&sz=w2000');
    A('Drive以外はそのまま',  f('https://example.com/a.png') === 'https://example.com/a.png');
    A('空は空のまま',          f('') === '' && f(null) === '');
    A('adminと同じ変換結果',   f('https://drive.google.com/file/d/XYZ/view') === 'https://drive.google.com/thumbnail?id=XYZ&sz=w2000');
  }

  console.log('\n── 実データでの描画 ────────────────────────');
  {
    const sel = doc.getElementById('vip-event-sel-e') || doc.querySelector('[id^="vip-event-sel"]');
    A('イベント選択がある', !!sel);
    w.eval('allEvents = ' + JSON.stringify(EVENTS.events));
    w.eval('vipEventIdE = "EV-A"');
    w.renderVipSeatImageE();
    const img = doc.getElementById('vip-seat-img-e');
    A('画像が表示状態になる', img.style.display === 'block');
    A('直リンクへ変換されている', img.getAttribute('src') === 'https://drive.google.com/thumbnail?id=1opkofDUwWuyqxpTdqeVfMSglVziaJyNS&sz=w2000');
    A('プレースホルダは隠れる', doc.getElementById('vip-seat-placeholder-e').style.display === 'none');

    w.eval('vipEventIdE = "EV-B"');   // 画像未設定のイベント
    w.renderVipSeatImageE();
    A('未設定なら画像を出さない', doc.getElementById('vip-seat-img-e').style.display === 'none');
    A('未設定の案内を出す', doc.getElementById('vip-seat-placeholder-e').textContent.includes('未設定'));
  }

  console.log('\n── ④ 読み込み失敗時の案内 ──────────────────');
  {
    A('onVipSeatImgErrorE 定義済み', typeof w.onVipSeatImgErrorE === 'function');
    w.onVipSeatImgErrorE();
    const t = doc.getElementById('vip-seat-placeholder-e').textContent;
    A('原因（共有設定）を案内する', t.includes('共有設定') && t.includes('リンクを知っている全員'));
    A('画像は隠す', doc.getElementById('vip-seat-img-e').style.display === 'none');
  }

  console.log('\n── ⑤ 更新ボタン ────────────────────────────');
  {
    A('refreshVipE 定義済み', typeof w.refreshVipE === 'function');
    const btns = [...doc.querySelectorAll('#vip-content-e button')].map(b => b.getAttribute('onclick') || '');
    A('更新ボタンが設置されている', btns.filter(o => o.includes('refreshVipE')).length >= 2);
    w.eval('vipEventIdE = "EV-A"');
    const before = counter.r;
    await w.refreshVipE(null);
    A('押すと再取得が走る', counter.r > before);
    A('予約一覧が描画される', doc.getElementById('vip-reservation-list-e').textContent.includes('中川彰悟'));
  }

  console.log('\n── 既存機能が壊れていないこと ────────────────');
  {
    A('チェックイン処理は健在',      typeof w.processCheckIn === 'function');
    A('招待者警告は健在',            typeof w.isInviterUnknown === 'function');
    A('VIP手動来場は健在',           typeof w.manualVipCheckInE === 'function');
    A('予約一覧の描画は健在',        typeof w.renderVipReservationsE === 'function');
  }

  dom.window.close();
  console.log('\n' + (fail === 0 ? `—— 全合格 ✅（${pass}件）——` : `—— 不合格 ${fail}件 / 合格 ${pass}件 ❌ ——`));
  process.exit(fail === 0 ? 0 : 1);
})();
