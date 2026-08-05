// 検証ハーネス 層1（純粋ロジック）: チェックイン備考＋種別訂正機能の核ロジックを
// backend(コード.js saveGuestCheckinInfo) / frontend(admin.html effPT) から忠実に抽出して検証。
let pass = 0, fail = 0;
const A = (n, c) => { if (c) { pass++; console.log('✅ ' + n); } else { fail++; console.log('❌ ' + n); } };

// ───────────────────────────────────────────────
// backend: actual_pay_type の正規化（コード.js saveGuestCheckinInfo を再現）
// '' / 'free' / 'paid' のみ許容。空系は ''(訂正解除)。不正は null(=400)。
function normActual(actRaw) {
  if (actRaw === undefined || actRaw === null || String(actRaw).trim() === '') return '';
  const s = String(actRaw).trim().toLowerCase();
  if (s === 'free') return 'free';
  if (s === 'paid') return 'paid';
  return null; // 不正
}
A('(B1) undefined→訂正解除(空文字)', normActual(undefined) === '');
A('(B2) 空文字→訂正解除', normActual('') === '');
A('(B3) "free"→free', normActual('free') === 'free');
A('(B4) "PAID"（大文字混在）→paid', normActual('PAID') === 'paid');
A('(B5) 不正値→null(=拒否)', normActual('vip') === null);
A('(B6) 数値等の不正→null', normActual('1') === null);

// backend: VIP拒否ガード（guest_id が VIP- 始まりは対象外）
const isVipRejected = (gid) => String(gid).indexOf('VIP-') === 0;
A('(B7) VIP-始まりは拒否', isVipRejected('VIP-3') === true);
A('(B8) 通常ゲストは許可', isVipRejected('G-abc12345') === false);

// backend: staff_note の扱い（undefined は書き込みスキップ、それ以外は文字列化して保存）
function noteToWrite(raw) { return (raw === undefined || raw === null) ? undefined : String(raw); }
A('(B9) note未指定→スキップ(undefined)', noteToWrite(undefined) === undefined);
A('(B10) note空文字→空文字で保存（=クリア可能）', noteToWrite('') === '');
A('(B11) note文字列→そのまま', noteToWrite('有料タグだが無料') === '有料タグだが無料');

// backend: ensureCol_ が原本pay_typeを壊さないこと（別列に書く）を模擬
function applyCheckinInfo(headers, row, actVal, noteVal) {
  const r = row.slice();
  function ensureCol(name) { let i = headers.indexOf(name); if (i < 0) { i = headers.length; headers.push(name); } return i; }
  const nc = ensureCol('staff_note');
  const ac = ensureCol('actual_pay_type');
  while (r.length <= Math.max(nc, ac)) r.push('');
  if (noteVal !== undefined) r[nc] = noteVal;
  r[ac] = actVal;
  return r;
}
const hdr0 = ['guest_id','event_id','name','pay_type','amount'];
const row0 = ['G-1','EV','太郎','paid',5000];
const hdrW = hdr0.slice();
const rowW = applyCheckinInfo(hdrW, row0, 'free', 'あとで無料と判明');
A('(B12) 原本 pay_type は保持される（paidのまま）', rowW[hdrW.indexOf('pay_type')] === 'paid');
A('(B13) actual_pay_type=free が別列に入る', rowW[hdrW.indexOf('actual_pay_type')] === 'free');
A('(B14) staff_note が別列に入る', rowW[hdrW.indexOf('staff_note')] === 'あとで無料と判明');
A('(B15) 原本 amount も保持', rowW[hdrW.indexOf('amount')] === 5000);

// ───────────────────────────────────────────────
// frontend: effPT / hasPTCorrection（admin.html を再現）
function effPT(g) {
  const a = g && g.actual_pay_type ? String(g.actual_pay_type).toLowerCase() : '';
  if (a === 'free' || a === 'paid') return a;
  return g ? g.pay_type : '';
}
function hasPTCorrection(g) {
  const a = g && g.actual_pay_type ? String(g.actual_pay_type).toLowerCase() : '';
  return (a === 'free' || a === 'paid') && a !== g.pay_type;
}
A('(F1) 訂正なし→申込pay_typeを返す', effPT({ pay_type: 'paid', actual_pay_type: '' }) === 'paid');
A('(F2) actual=free→freeを返す（集計はactual優先）', effPT({ pay_type: 'paid', actual_pay_type: 'free' }) === 'free');
A('(F3) actual=paid→paidを返す', effPT({ pay_type: 'free', actual_pay_type: 'paid' }) === 'paid');
A('(F4) actual不正値は無視して申込へフォールバック', effPT({ pay_type: 'paid', actual_pay_type: 'xxx' }) === 'paid');
A('(F5) 訂正が申込と食い違う時のみ corrected', hasPTCorrection({ pay_type: 'paid', actual_pay_type: 'free' }) === true);
A('(F6) 訂正が申込と同じなら corrected でない', hasPTCorrection({ pay_type: 'free', actual_pay_type: 'free' }) === false);
A('(F7) 訂正なしは corrected でない', hasPTCorrection({ pay_type: 'paid', actual_pay_type: '' }) === false);

// frontend: 売上集計が actual を優先する（paid→free訂正で売上から外れる）を確認
const guests = [
  { pay_type: 'paid', amount: 5000, actual_pay_type: '',     arrived: 'TRUE' }, // 実売上
  { pay_type: 'paid', amount: 5000, actual_pay_type: 'free', arrived: 'TRUE' }, // 実態無料→除外
  { pay_type: 'free', amount: 0,    actual_pay_type: 'paid', arrived: 'TRUE' }, // 実態有料→計上(金額は原本0)
];
const paidCount = guests.filter(g => effPT(g) === 'paid').length;
const freeCount = guests.filter(g => effPT(g) === 'free').length;
A('(F8) 有効有料件数=2（1件目＋3件目）', paidCount === 2);
A('(F9) 有効無料件数=1（2件目）', freeCount === 1);

console.log('\n=== checkin-info 層1 結果: ' + pass + ' 合格 / ' + fail + ' 不合格 ===');
process.exit(fail === 0 ? 0 : 1);
