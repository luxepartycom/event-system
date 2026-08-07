// 検証ハーネス 層3（jsdom）: プロモーター固定URLの動作を実HTMLで確認する。
//  ① promoter.html が一般/VIP 両方の申込リンクに promoter を必ず埋め込むか
//  ② vip-plan.html が ?promoter= で紹介者を固定し、入力欄を隠すか（リセット後も維持されるか）
//  ③ vip.html が ?promoter= を予約ペイロードに載せるか（従来は空固定だった）
//
// 実行: NODE_PATH=~/.cache/claude-node/node_modules node test/jsdom-promoter.cjs
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

let pass = 0, fail = 0;
const A = (n, c) => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const EVENTS = { ok: true, events: [
  { event_id: 'EV-A', name: 'LUXE POOL PARTY', date: '2026-08-08T15:00:00.000Z', status: 'active' },
  { event_id: 'EV-B', name: '過去イベント',     date: '2026-03-14T15:00:00.000Z', status: 'closed' },
  { event_id: 'EV-C', name: 'AUTUMN LUXE',     date: '2026-10-10T15:00:00.000Z', status: 'active' }
]};

function boot(file, query, fetchImpl) {
  const html = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const errs = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errs.push(e.message));
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    url: 'https://entry.luxepartytokyo.com/' + file + query,
    beforeParse(w) {
      w.fetch = fetchImpl || (() => Promise.resolve({
        ok: true, status: 200,
        text: () => Promise.resolve(JSON.stringify(EVENTS)),
        json: () => Promise.resolve(EVENTS)
      }));
    }
  });
  return { dom, errs };
}

(async () => {
  const PRM = '山田 太郎';
  const ENC = encodeURIComponent(PRM);

  console.log('\n══ promoter.html ══════════════════════════════');
  {
    const { dom, errs } = boot('promoter.html', '?p=' + ENC);
    await sleep(400);
    const w = dom.window, doc = w.document;
    const fatal = errs.filter(e => !/fetch|NetworkError|not implemented/i.test(e));
    A('致命的なJSエラー ゼロ', fatal.length === 0);
    fatal.forEach(e => console.log('     ⚠ ' + e));

    A('プロモーター名が表示される', doc.getElementById('by-name').textContent === PRM);
    const links = [...doc.querySelectorAll('a.btn')].map(a => a.getAttribute('href'));
    A('リンクが生成される', links.length > 0);
    A('全リンクに promoter が入る', links.length > 0 && links.every(h => h.includes('promoter=' + ENC)));
    A('入場チケットのリンクがある', links.some(h => h.startsWith('index.html?e=EV-A')));
    A('VIPのリンクがある',          links.some(h => h.startsWith('vip-plan.html?e=EV-A')));
    A('終了イベント(closed)は出さない', !links.some(h => h.includes('EV-B')));
    A('開催中は全て出す(EV-A/EV-C)', links.some(h => h.includes('EV-A')) && links.some(h => h.includes('EV-C')));
    const first = doc.querySelector('.ev-name').textContent;
    A('開催日の近い順に並ぶ', first === 'LUXE POOL PARTY');
    console.log('     例: ' + links[0]);
    console.log('     例: ' + links[1]);
    dom.window.close();
  }

  console.log('\n══ promoter.html（イベント指定・異常系）══════════');
  {
    const { dom } = boot('promoter.html', '?p=' + ENC + '&e=EV-C');
    await sleep(400);
    const links = [...dom.window.document.querySelectorAll('a.btn')].map(a => a.getAttribute('href'));
    A('e= 指定でそのイベントだけに絞る', links.length === 2 && links.every(h => h.includes('EV-C')));
    dom.window.close();
  }
  {
    const { dom } = boot('promoter.html', '?p=' + ENC, () => Promise.reject(new TypeError('Load failed')));
    await sleep(400);
    const t = dom.window.document.getElementById('content').textContent;
    A('通信失敗時は案内文を出す（白画面にしない）', /取得できませんでした/.test(t));
    dom.window.close();
  }
  {
    // プロモーター指定なしでも壊れないこと（直リンクを踏まれたケース）
    const { dom } = boot('promoter.html', '');
    await sleep(400);
    const doc = dom.window.document;
    const links = [...doc.querySelectorAll('a.btn')].map(a => a.getAttribute('href'));
    A('p= 無しでもページは成立する', links.length > 0);
    A('p= 無しなら promoter を付けない', links.every(h => !h.includes('promoter=')));
    A('p= 無しなら紹介者欄を出さない', doc.getElementById('by').style.display === 'none');
    dom.window.close();
  }

  console.log('\n══ vip-plan.html ══════════════════════════════');
  {
    const { dom, errs } = boot('vip-plan.html', '?e=EV-A&promoter=' + ENC);
    await sleep(400);
    const w = dom.window, doc = w.document;
    const fatal = errs.filter(e => !/fetch|NetworkError|not implemented|Failed to/i.test(e));
    A('致命的なJSエラー ゼロ', fatal.length === 0);
    fatal.forEach(e => console.log('     ⚠ ' + e));
    A('PROMOTER を読み取れている', w.eval('PROMOTER') === PRM);
    A('applyFixedPromoter が定義済み', typeof w.applyFixedPromoter === 'function');

    w.applyFixedPromoter();
    const inp = doc.getElementById('inp-promoter');
    A('紹介者が固定値で埋まる', inp.value === PRM);
    A('紹介者の入力欄は非表示', inp.closest('.form-group').style.display === 'none');

    // フォームを開き直す＝リセットが走った後も維持されるか（今回の実装の肝）
    inp.value = '';
    w.applyFixedPromoter();
    A('リセット後も入れ直される', inp.value === PRM);
    dom.window.close();
  }
  {
    const { dom } = boot('vip-plan.html', '?e=EV-A');
    await sleep(400);
    const w = dom.window;
    w.applyFixedPromoter();
    const inp = w.document.getElementById('inp-promoter');
    A('promoter 無しなら従来どおり手入力欄を残す',
      inp.value === '' && inp.closest('.form-group').style.display !== 'none');
    dom.window.close();
  }

  console.log('\n══ vip.html ═══════════════════════════════════');
  {
    const { dom, errs } = boot('vip.html', '?e=EV-A&promoter=' + ENC);
    await sleep(400);
    const w = dom.window;
    const fatal = errs.filter(e => !/fetch|NetworkError|not implemented|Failed to/i.test(e));
    A('致命的なJSエラー ゼロ', fatal.length === 0);
    fatal.forEach(e => console.log('     ⚠ ' + e));
    A('VIP_PROMOTER に取り込まれる', w.eval('VIP_PROMOTER') === PRM);
    dom.window.close();
  }
  {
    const { dom } = boot('vip.html', '?e=EV-A');
    await sleep(400);
    A('promoter 無しなら空のまま（従来動作）', dom.window.eval('VIP_PROMOTER') === '');
    dom.window.close();
  }

  console.log('\n' + (fail === 0 ? `—— 全合格 ✅（${pass}件）——` : `—— 不合格 ${fail}件 / 合格 ${pass}件 ❌ ——`));
  process.exit(fail === 0 ? 0 : 1);
})();
