// 検証ハーネス 層3（jsdom）: 申込データ復旧対象（invited_by="[復旧]"）の
// 受付画面での「招待者を確認してください」表示。
// 実行: NODE_PATH=~/.cache/claude-node/node_modules node test/jsdom-inviter-warn.cjs
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

let pass = 0, fail = 0;
const A = (n, c) => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function boot(file) {
  const html = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const errs = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errs.push(e.message));
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    url: 'https://entry.luxepartytokyo.com/' + file,
    beforeParse(w) {
      w.navigator.mediaDevices = w.navigator.mediaDevices || { getUserMedia: () => Promise.reject(new Error('no cam')) };
      w.fetch = () => Promise.resolve({ ok:true, status:200, text:()=>Promise.resolve('{"ok":true}'), json:()=>Promise.resolve({ok:true}) });
    }
  });
  return { dom, errs };
}

const FUKKYU = { ok:true, status:'checked_in', guest_id:'G-MSBDL971', name:'鈴木みさき',
                 gender:'female', invited_by:'[復旧]', pay_type:'free', amount:0 };
const NORMAL = { ok:true, status:'checked_in', guest_id:'G-NORMAL', name:'田中太郎',
                 gender:'male', invited_by:'LUXE_Ryu', pay_type:'paid', amount:5000 };
const VIP    = { ok:true, status:'checked_in', guest_id:'VIP-1', name:'VIP様', invited_by:'[復旧]',
                 vip_info:{ table_name:'V5', table_type:'ROYAL', capacity:4, checked_count:1, is_over:false } };

(async () => {
  for (const file of ['admin.html', 'entrance.html']) {
    console.log('\n══ ' + file + ' ══════════════════════════════');
    const { dom, errs } = boot(file);
    await sleep(300);
    const w = dom.window, doc = w.document;
    const fatal = errs.filter(e => !/getUserMedia|mediaDevices|fetch|NetworkError|not implemented|Failed to|camera|ZXing/i.test(e));
    A('致命的なJSエラー ゼロ', fatal.length === 0);
    fatal.forEach(e => console.log('     ⚠ ' + e));

    A('isInviterUnknown 定義済み', typeof w.isInviterUnknown === 'function');
    A('警告ブロック(ok)が存在',  !!doc.getElementById('cam-inviter-warn-ok'));
    A('警告ブロック(dup)が存在', !!doc.getElementById('cam-inviter-warn-dup'));

    if (typeof w.isInviterUnknown === 'function') {
      A('[復旧] を検出する',        w.isInviterUnknown({ invited_by:'[復旧]' }) === true);
      A('通常の招待者は検出しない',  w.isInviterUnknown({ invited_by:'LUXE_Ryu' }) === false);
      A('空でも誤検出しない',        w.isInviterUnknown({ invited_by:'' }) === false);
      A('未定義でも落ちない',        w.isInviterUnknown({}) === false && w.isInviterUnknown(null) === false);
    }

    console.log('  ── 復旧対象のチェックイン完了画面 ──');
    w.showCamOverlay(FUKKYU, 'ok');
    A('警告が表示される', doc.getElementById('cam-inviter-warn-ok').style.display === 'block');
    A('文言に「招待者を確認」が入る', doc.getElementById('cam-inviter-warn-ok').textContent.includes('招待者を確認'));
    A('備考欄が使える状態', doc.getElementById('cam-ci-editor-ok').style.display === 'block');

    console.log('  ── 通常ゲスト（警告を出してはいけない）──');
    w.showCamOverlay(NORMAL, 'ok');
    A('警告は非表示', doc.getElementById('cam-inviter-warn-ok').style.display === 'none');

    console.log('  ── 復旧対象が入場済みだった場合 ──');
    w.showCamOverlay(FUKKYU, 'duplicate');
    A('入場済み画面でも警告が出る', doc.getElementById('cam-inviter-warn-dup').style.display === 'block');
    w.showCamOverlay(NORMAL, 'duplicate');
    A('通常ゲストでは出ない', doc.getElementById('cam-inviter-warn-dup').style.display === 'none');

    console.log('  ── VIP（備考エディタ対象外）──');
    w.showCamOverlay(VIP, 'ok');
    A('VIPでは備考エディタを出さない', doc.getElementById('cam-ci-editor-ok').style.display === 'none');
    A('VIPでは警告も出さない',        doc.getElementById('cam-inviter-warn-ok').style.display === 'none');

    console.log('  ── 状態行のメッセージ ──');
    const sel = doc.getElementById('scan-event-sel');
    sel.innerHTML = '<option value="EV-A">t</option>'; sel.value = 'EV-A';
    w.setScanMsg('x', 'ok');
    w.showCamOverlay(FUKKYU, 'ok');
    // processCheckIn 経由の文言は実際の通信を伴うため、ここでは関数の存在と分岐のみ確認
    A('warn 種別が setScanMsg で扱える', (() => { try { w.setScanMsg('t', 'warn'); return true; } catch (e) { return false; } })());

    dom.window.close();
  }

  console.log('\n' + (fail === 0 ? `—— 全合格 ✅（${pass}件）——` : `—— 不合格 ${fail}件 / 合格 ${pass}件 ❌ ——`));
  process.exit(fail === 0 ? 0 : 1);
})();
