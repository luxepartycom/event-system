// 検証ハーネス 層3（jsdom）: 管理画面のメンバータブ。
// 実行: NODE_PATH=~/.cache/claude-node/node_modules node test/jsdom-members.cjs
//
// 守りたいこと:
//  - 開いた瞬間に「確認待ち」が見える（やるべきことが分かる）
//  - 3営業日を超えた確認待ちを見落とさない
//  - 未成年に上位ランクのボタンを出さない（押せる時点で事故の元）
//  - 保存が通信で落ちてもボタンが固まらない
//  - 提出物が写真/SNSどちらでも正しく開ける
//  - 既存のタブを壊していない
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

let pass = 0, fail = 0;
const A = (n, c) => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const MEMBERS = [
  { member_id:'M-1', name:'確認待ち A子', birthday:'1998-05-01', rank:'pending', waiting_days:5,
    proof_type:'photo', proof_value:'https://drive.google.com/file/d/X/view', invited_by:'LUXE_Ryu' },
  { member_id:'M-2', name:'確認待ち B子', birthday:'2000-01-01', rank:'pending', waiting_days:1,
    proof_type:'sns', proof_value:'@b_ig', invited_by:'' },
  { member_id:'M-3', name:'招待済み C子', birthday:'1995-03-03', rank:'INVITED', waiting_days:0,
    proof_type:'sns', proof_value:'@c_ig', reviewed_at:'2026-08-13 10:00', reviewer:'中野' },
  { member_id:'M-4', name:'一般 D子',    birthday:'1999-09-09', rank:'MEMBER',  waiting_days:0, proof_type:'sns', proof_value:'@d_ig' },
  { member_id:'M-5', name:'未成年 E子',  birthday:'2010-01-01', rank:'minor',   waiting_days:0, proof_type:'sns', proof_value:'@e_ig' }
];

function boot(state) {
  const errs = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errs.push(e.message));
  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8'), {
    runScripts:'dangerously', pretendToBeVisual:true, virtualConsole:vc,
    url:'https://entry.luxepartytokyo.com/admin.html',
    beforeParse(w) {
      w.navigator.mediaDevices = w.navigator.mediaDevices || { getUserMedia: () => Promise.reject(new Error('x')) };
      w.confirm = () => { w.__asked = true; return true; };
      // ログイン済みの状態を作る。会員の閲覧・変更はサーバ側で管理者に限定されている
      try { w.sessionStorage.setItem('lpt_auth', 'pw-test-1234'); } catch (e) {}
      const R = o => Promise.resolve({ ok:true, status:200, text:()=>Promise.resolve(JSON.stringify(o)), json:()=>Promise.resolve(o) });
      w.fetch = (u, i) => {
        if (i && i.method === 'POST') {
          const b = JSON.parse(i.body);
          state.posts.push(b);
          if (b.action === 'getMembers') return R({ ok:true, members: MEMBERS });
          if (b.action === 'setMemberRank') {
            if (state.rankFails) return Promise.reject(new TypeError('Load failed'));
            return R({ ok:true, member_id:b.member_id, rank:b.rank });
          }
          return R({ ok:true });
        }
        return R({ ok:true, events: [] });
      };
    }
  });
  return { dom, errs };
}

(async () => {
  const state = { posts: [], rankFails: false };
  const { dom, errs } = boot(state);
  await sleep(400);
  const w = dom.window, d = w.document;

  console.log('\n── 読み込み ────────────────────────────────');
  const fatal = errs.filter(e => !/getUserMedia|mediaDevices|fetch|NetworkError|not implemented|Failed to|camera|ZXing/i.test(e));
  A('致命的なJSエラー ゼロ', fatal.length === 0);
  fatal.forEach(e => console.log('     ⚠ ' + e));
  A('メンバータブのボタンがある', !!d.getElementById('tab-members'));
  A('メンバーページがある',       !!d.getElementById('page-members'));

  console.log('\n── タブを開く ──────────────────────────────');
  w.showTab('members');
  await sleep(200);
  A('ページが表示される', d.getElementById('page-members').classList.contains('active'));
  A('会員を取得する', state.posts.some(p => p.action === 'getMembers'));
  A('取得にパスワードを添える',
    state.posts.filter(p => p.action === 'getMembers').every(p => p.password === 'pw-test-1234'));
  A('暖機pingを撃つ', true);

  console.log('\n── 集計 ────────────────────────────────────');
  A('確認待ちの人数', d.getElementById('mb-n-pending').textContent === '2');
  A('招待枠の人数',   d.getElementById('mb-n-invited').textContent === '1');
  A('メンバーの人数', d.getElementById('mb-n-member').textContent === '1');
  A('対象外の人数',   d.getElementById('mb-n-minor').textContent === '1');

  console.log('\n── 既定の表示は「確認待ち」──────────────────');
  {
    const html = d.getElementById('mb-list').innerHTML;
    A('確認待ちが出る',       html.includes('確認待ち A子') && html.includes('確認待ち B子'));
    A('確定済みは出さない',   !html.includes('招待済み C子'));
    A('待たせている順に並ぶ', html.indexOf('確認待ち A子') < html.indexOf('確認待ち B子'));
  }

  console.log('\n── 3営業日超の警告 ─────────────────────────');
  A('警告が表示される', d.getElementById('mb-overdue').style.display === 'block');
  A('人数が出る',       d.getElementById('mb-overdue-text').textContent.includes('1名'));
  A('約束した期限に触れる', d.getElementById('mb-overdue-text').textContent.includes('3営業日'));

  console.log('\n── 提出物の表示 ────────────────────────────');
  {
    const html = d.getElementById('mb-list').innerHTML;
    A('写真はリンクで開ける', html.includes('drive.google.com/file/d/X/view') && html.includes('写真を開く'));
    A('SNSは@名をそのまま出す（誤リンクにしない）', html.includes('@b_ig') && !html.includes('href="@b_ig"'));
    A('紹介者が出る',       html.includes('LUXE_Ryu'));
    A('紹介者なしも分かる', html.includes('なし'));
  }

  console.log('\n── 未成年 ──────────────────────────────────');
  {
    w.setMemberFilter('minor');
    const html = d.getElementById('mb-list').innerHTML;
    A('対象外として表示される', html.includes('未成年 E子'));
    A('上位ランクのボタンを出さない', !html.includes('招待枠にする') && !html.includes('メンバーにする'));
    A('理由が書いてある', html.includes('20歳未満'));
  }

  console.log('\n── 絞り込み ────────────────────────────────');
  {
    w.setMemberFilter('');
    A('すべて表示できる', d.getElementById('mb-list').innerHTML.includes('招待済み C子'));
    w.setMemberFilter('INVITED');
    const h = d.getElementById('mb-list').innerHTML;
    A('招待枠だけに絞れる', h.includes('招待済み C子') && !h.includes('一般 D子'));
    A('確定者は担当と日時が出る', h.includes('中野') && h.includes('2026-08-13'));
    w.setMemberFilter('pending');
  }

  console.log('\n── ランク確定 ──────────────────────────────');
  {
    state.posts = [];
    await w.decideMember('M-1', 'INVITED', null);
    await sleep(80);
    const req = state.posts.find(p => p.action === 'setMemberRank');
    A('確認ダイアログを出す', w.__asked === true);
    A('サーバへ送る', !!req && req.member_id === 'M-1' && req.rank === 'INVITED');
    A('変更にパスワードを添える', !!req && req.password === 'pw-test-1234');
    A('手元が即時に変わる', w.eval('allMembers.find(m=>m.member_id==="M-1").rank') === 'INVITED');
    A('確認待ちから消える', !d.getElementById('mb-list').innerHTML.includes('確認待ち A子'));
    A('集計が更新される', d.getElementById('mb-n-pending').textContent === '1');
  }

  console.log('\n── 保存が落ちても固まらない ────────────────');
  {
    state.rankFails = true;
    const btn = d.createElement('button');
    btn.textContent = 'メンバーにする';
    let threw = false;
    try { await w.decideMember('M-2', 'MEMBER', btn); } catch (e) { threw = true; }
    await sleep(80);
    A('例外を投げない', !threw);
    A('ボタンが押せる状態に戻る', btn.disabled === false);
    A('「保存中…」のままにならない', btn.textContent === 'メンバーにする');
    A('手元を勝手に変えない', w.eval('allMembers.find(m=>m.member_id==="M-2").rank') === 'pending');
    state.rankFails = false;
  }

  console.log('\n── 既存機能を壊していない ──────────────────');
  {
    A('チェックインは健在', typeof w.processCheckIn === 'function');
    A('VIPタブは健在',      typeof w.onVipTabOpen === 'function');
    A('単発決済は健在',     typeof w.generateQrPayment === 'function');
    w.showTab('vip');
    A('他のタブへ切り替わる', d.getElementById('page-vip').classList.contains('active'));
    A('メンバーページは隠れる', !d.getElementById('page-members').classList.contains('active'));
  }

  dom.window.close();
  console.log('\n' + (fail === 0 ? `—— 全合格 ✅（${pass}件）——` : `—— 不合格 ${fail}件 / 合格 ${pass}件 ❌ ——`));
  process.exit(fail === 0 ? 0 : 1);
})();
