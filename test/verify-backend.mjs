// 検証ハーネス 層1（純粋ロジック）: backend Fix C/D の核ロジックを忠実に再現し検証。
// Fix D=submission_idの原子的な行組み立て / Fix C=submission_idでpay_type/amountを返す dedup。
let pass = 0, fail = 0;
const A = (n, c) => { if (c) { pass++; console.log('✅ ' + n); } else { fail++; console.log('❌ ' + n); } };

// ---- Fix D: 原子的行組み立て（コード.js registerGuest の rowArr 構築を再現） ----
function buildRow(vals16, subColIdx, subId) {
  const row = vals16.slice();
  while (row.length <= subColIdx) row.push('');
  if (subId) row[subColIdx] = subId;
  return row;
}
const v16 = ['G-1','EV','name','a@x','male','PROMO','paid',5000,'FALSE','FALSE','','ts','','FALSE','','PLAN'];
let r = buildRow(v16, 16, 'S-abc'); // submission_id列がQ(index16)
A('(D1) 元の16値が壊れない', JSON.stringify(r.slice(0,16)) === JSON.stringify(v16));
A('(D2) submission_idが列16に原子的に入る', r[16] === 'S-abc');
A('(D3) 行長=17', r.length === 17);
let r2 = buildRow(v16, 17, 'S-xyz'); // first_time=16, submission_id=17 のケース
A('(D4) 間の列(16)は空で埋まる（first_timeは後で別書き）', r2[16] === '');
A('(D5) submission_idが列17・行長18', r2[17] === 'S-xyz' && r2.length === 18);
A('(D6) subIdが空なら列に何も入れない', buildRow(v16,16,'')[16] === '');

// ---- Fix C: findGuestRowBySubmission_ の再現（submission_idでguest_id/pay_type/amount返却） ----
function findRow(rows, hdr, sub) {
  const si = hdr.indexOf('submission_id'), gi = hdr.indexOf('guest_id'), pi = hdr.indexOf('pay_type'), ai = hdr.indexOf('amount');
  if (si < 0 || !sub) return null;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (String(rows[i][si]) !== '' && String(rows[i][si]) === String(sub))
      return { guest_id: gi>=0?String(rows[i][gi]):'', pay_type: pi>=0?String(rows[i][pi]):'', amount: ai>=0?Number(rows[i][ai]||0):0 };
  }
  return null;
}
const hdr = ['guest_id','event_id','name','email','gender','invited_by','pay_type','amount','pay_confirmed','arrived','arrived_at','registered_at','payment_method','reminder_sent','stripe_session_id','plan_id','submission_id'];
const rows = [
  ['G-1','EV','n','a','m','p','free',0,'F','F','','t','','F','','','S-1'],
  ['G-2','EV','n2','b','f','p','paid',8000,'F','F','','t','','F','','','S-2'],
];
const c1 = findRow(rows, hdr, 'S-2');
A('(C1) 一致行を検出', !!c1 && c1.guest_id === 'G-2');
A('(C2) pay_type返却(paid)＝再送時に完了画面/メールが正表示', c1.pay_type === 'paid');
A('(C3) amount返却(8000)', c1.amount === 8000);
const c2 = findRow(rows, hdr, 'S-1');
A('(C4) 無料行はpay_type=free/amount=0で返る', c2.pay_type === 'free' && c2.amount === 0);
A('(C5) 非存在subIdはnull', findRow(rows, hdr, 'S-NOPE') === null);
A('(C6) 空subIdは誤ヒットしない', findRow(rows, hdr, '') === null);

console.log('\n=== backend層1 結果: ' + pass + ' 合格 / ' + fail + ' 不合格 ===');
process.exit(fail === 0 ? 0 : 1);
