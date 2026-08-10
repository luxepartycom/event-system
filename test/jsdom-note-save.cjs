// 検証ハーネス 層3（jsdom）: 備考保存 → 次のスキャンへ進めるか。
// 2026-08-10 現場報告「備考を保存すると次のスキャンに飛べない」の再発防止。
//
// 原因: saveCheckinInfoFromOverlay に try/catch が無く、保存の通信が落ちると
//       ボタンが「保存中…」disabled のまま固まり、受付が先に進めなくなっていた。
// 実行: NODE_PATH=~/.cache/claude-node/node_modules node test/jsdom-note-save.cjs
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

let pass = 0, fail = 0;
const A = (n, c) => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ROOT = path.join(__dirname, '..');

// fetchMode: 'ok' | 'down' | 'html'
function boot(file, state) {
  const errs = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errs.push(e.message));
  const dom = new JSDOM(fs.readFileSync(path.join(ROOT, file), 'utf8'), {
    runScripts:'dangerously', pretendToBeVisual:true, virtualConsole:vc,
    url:'https://entry.luxepartytokyo.com/' + file,
    beforeParse(w) {
      w.navigator.mediaDevices = { getUserMedia: () => Promise.resolve({ getTracks: () => [{ stop(){} }] }) };
      w.confirm = () => { w.__asked = true; return true; };
      // ブラウザ相当のZXingスタブ（decodeFromVideoDevice は連続スキャンなので解決しない）
      w.ZXing = {
        BrowserCodeReader: { listVideoInputDevices: () => Promise.resolve([{ deviceId:'c', label:'back' }]) },
        BrowserQRCodeReader: function () { this.reset = () => {}; this.decodeFromVideoDevice = () => new Promise(() => {}); }
      };
      w.fetch = (u, i) => {
        if (i && i.method === 'POST') {
          const b = JSON.parse(i.body);
          state.posts.push(b.action);
          if (b.action === 'saveGuestCheckinInfo') {
            if (state.mode === 'down') return Promise.reject(new TypeError('Load failed'));
            if (state.mode === 'html') return Promise.resolve({ ok:true, status:200, text:()=>Promise.resolve('<html>err</html>') });
            return Promise.resolve({ ok:true, status:200, text:()=>Promise.resolve('{"ok":true}') });
          }
          if (b.action === 'checkIn') return Promise.resolve({ ok:true, status:200, text:()=>Promise.resolve(JSON.stringify(
            { ok:true, status:'checked_in', guest_id:b.guest_id, name:'客'+b.guest_id, invited_by:'[復旧]', pay_type:'free', amount:0 })) });
          return Promise.resolve({ ok:true, status:200, text:()=>Promise.resolve('{"ok":true}') });
        }
        return Promise.resolve({ ok:true, status:200, text:()=>Promise.resolve('{"ok":true}'), json:()=>Promise.resolve({ok:true}) });
      };
    }
  });
  return { dom, errs };
}

async function prep(file, state) {
  const { dom, errs } = boot(file, state);
  await sleep(350);
  const w = dom.window, d = w.document;
  const sel = d.getElementById('scan-event-sel');
  sel.innerHTML = '<option value="EV-A">t</option>'; sel.value = 'EV-A';
  w.eval('allGuests=[]');
  return { dom, w, d, errs };
}

(async () => {
  for (const file of ['admin.html', 'entrance.html']) {
    console.log('\n══ ' + file + ' ══════════════════════════════');

    // ── 正常時：保存 → 次のスキャンまで通る ──
    {
      const state = { mode:'ok', posts:[] };
      const { dom, w, d, errs } = await prep(file, state);
      const fatal = errs.filter(e => !/getUserMedia|mediaDevices|fetch|NetworkError|not implemented|Failed to|camera|ZXing/i.test(e));
      A('致命的なJSエラー ゼロ', fatal.length === 0);

      await w.processCheckIn('G-1'); await sleep(120);
      A('1人目の完了画面が出る', d.getElementById('cam-overlay-ok').style.display === 'flex');
      d.getElementById('cam-ci-note-ok').value = '紹介者は田中さん';
      w.ciMarkDirty();
      const btn = d.getElementById('cam-ci-save-ok');
      await w.saveCheckinInfoFromOverlay('ok', btn); await sleep(120);
      A('保存APIが呼ばれる', state.posts.includes('saveGuestCheckinInfo'));
      A('ボタンが復帰する', btn.disabled === false);
      A('保存済みと表示される', btn.textContent.includes('保存しました'));
      A('未保存フラグが下りる', w.eval('ciDirty') === false);

      w.resumeCamera(); await sleep(220);
      A('完了画面が閉じる', d.getElementById('cam-overlay-ok').style.display === 'none');
      A('カメラ映像に戻る', d.getElementById('video-container').style.display === 'block');
      A('スキャン可能な状態', w.eval('checkinBusy') === false && w.eval('lastScanned') === '');

      state.posts = [];
      await w.processCheckIn('G-2'); await sleep(150);
      A('2人目がスキャンできる', state.posts.includes('checkIn'));
      A('2人目の名前が出る', d.getElementById('cam-ok-name').textContent === '客G-2');
      A('備考欄が空に戻っている', d.getElementById('cam-ci-note-ok').value === '');
      dom.window.close();
    }

    // ── 【本題】保存の通信が落ちた場合 ──
    for (const [mode, label] of [['down','通信が落ちた'], ['html','サーバが不正応答']]) {
      console.log('  ── ' + label + '場合 ──');
      const state = { mode, posts:[] };
      const { dom, w, d } = await prep(file, state);
      await w.processCheckIn('G-3'); await sleep(120);
      d.getElementById('cam-ci-note-ok').value = '紹介者は佐藤さん';
      w.ciMarkDirty();
      const btn = d.getElementById('cam-ci-save-ok');
      let threw = false;
      try { await w.saveCheckinInfoFromOverlay('ok', btn); } catch (e) { threw = true; }
      await sleep(120);
      A('保存処理が例外を投げない', !threw);
      A('ボタンが固まらない（押せる状態に戻る）', btn.disabled === false);
      A('「保存中…」のままにならない', !btn.textContent.includes('保存中'));
      A('未保存であることを保持する', w.eval('ciDirty') === true);

      w.__asked = false;
      w.resumeCamera(); await sleep(220);
      A('未保存の確認が出る', w.__asked === true);
      A('次の読み取りへ進める', d.getElementById('cam-overlay-ok').style.display === 'none'
                              && d.getElementById('video-container').style.display === 'block');
      A('スキャン可能な状態に戻る', w.eval('checkinBusy') === false);

      state.posts = [];
      await w.processCheckIn('G-4'); await sleep(150);
      A('次の人をスキャンできる', state.posts.includes('checkIn'));
      dom.window.close();
    }

    // ── 保存ボタンが「保存中…」で残っていても次へ進めば復帰する ──
    {
      const state = { mode:'ok', posts:[] };
      const { dom, w, d } = await prep(file, state);
      await w.processCheckIn('G-5'); await sleep(120);
      const btn = d.getElementById('cam-ci-save-ok');
      btn.disabled = true; btn.textContent = '保存中…';   // 固まった状態を人為的に作る
      w.resumeCamera(); await sleep(200);
      A('次へ進むと保存ボタンが復帰する', btn.disabled === false && btn.textContent === '備考・訂正を保存');
      dom.window.close();
    }
  }

  console.log('\n' + (fail === 0 ? `—— 全合格 ✅（${pass}件）——` : `—— 不合格 ${fail}件 / 合格 ${pass}件 ❌ ——`));
  process.exit(fail === 0 ? 0 : 1);
})();
