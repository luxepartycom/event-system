// 検証ハーネス 層1（純粋ロジック）: ②二重送信防止の核 = 冪等キー安定化＋連打ガード
// index.html に実装したロジックを忠実に再現し、期待挙動を ✅/❌ で検証する。
let pass = 0, fail = 0;
function assert(name, cond) { if (cond) { pass++; console.log('✅ ' + name); } else { fail++; console.log('❌ ' + name); } }

// ---- index.html の実装を再現 ----
let _pendingSubId = '', _pendingKey = '', _submitting = false;
let _idSeq = 0;
function genSubId() { return 'S-' + (++_idSeq); } // テスト用に決定的
function subIdFor(key) { if (_pendingSubId && _pendingKey === key) return _pendingSubId; _pendingSubId = genSubId(); _pendingKey = key; return _pendingSubId; }
function clearPendingSubId() { _pendingSubId = ''; _pendingKey = ''; }

// ---- (A) subIdFor: 冪等キーの安定性 ----
_pendingSubId = ''; _pendingKey = ''; _idSeq = 0;
const a1 = subIdFor('田中|a@x|EV1|free|');
const a2 = subIdFor('田中|a@x|EV1|free|');
assert('(A1) 同一内容の再送 → 同じ冪等キー（重複しない）', a1 === a2);
const b1 = subIdFor('佐藤|b@x|EV1|free|');
assert('(A2) 内容が違えば → 別の冪等キー（誤dedupしない）', b1 !== a1);
clearPendingSubId();
const a3 = subIdFor('田中|a@x|EV1|free|');
assert('(A3) 成功後clear → 同じ内容でも新しいキー（次の申込は別行）', a3 !== a1);

// ---- (B) submitForm の連打ガード＋エラー再送を模擬 ----
// register 呼び出し回数と、送られた submission_id を記録する模擬API
let apiCalls = [];
async function fakeRegister(subId, { fail: shouldFail } = {}) {
  await new Promise(r => setTimeout(r, 5));
  apiCalls.push(subId);
  if (shouldFail) throw new Error('timeout');
  return { ok: true, guest_id: 'G-' + subId };
}
// submitForm を実装通りに模擬（_submitting ガード＋subIdFor＋成功clear／失敗は再入可）
async function submitFormSim(content, { fail: shouldFail } = {}) {
  if (_submitting) return 'BLOCKED';
  const subId = subIdFor(content);
  _submitting = true;
  try {
    const data = await fakeRegister(subId, { fail: shouldFail });
    if (data.ok) { clearPendingSubId(); return 'OK:' + subId; }
    return 'NG';
  } catch (e) { return 'ERR:' + subId; }
  finally { _submitting = false; }
}

// (B1) 連打: 応答前に2回呼ぶ → 2回目はガードで弾かれ、register は1回だけ
_pendingSubId = ''; _pendingKey = ''; _submitting = false; apiCalls = []; _idSeq = 0;
const p1 = submitFormSim('田中|a@x|EV1|free|');
const p2 = submitFormSim('田中|a@x|EV1|free|'); // 応答前の2連打
const [r1, r2] = await Promise.all([p1, p2]);
assert('(B1) 連打 → registerは1回だけ発火（重複行を作らない）', apiCalls.length === 1);
assert('(B1b) 2回目はガードでBLOCKED', r2 === 'BLOCKED' || r1 === 'BLOCKED');

// (B2) 通信エラーで失敗 → 再送すると同じ submission_id（サーバ側dedupで1行にまとまる）
_pendingSubId = ''; _pendingKey = ''; _submitting = false; apiCalls = []; _idSeq = 0;
await submitFormSim('鈴木|c@x|EV1|paid|P1', { fail: true }); // 1回目失敗（_submitting は finally で解除）
await submitFormSim('鈴木|c@x|EV1|paid|P1');                 // 再送（成功）
assert('(B2) 失敗→再送で register は2回呼ばれる', apiCalls.length === 2);
assert('(B2b) 2回とも同じ submission_id（＝サーバで1行に集約される）', apiCalls[0] === apiCalls[1]);

// (B3) 成功後に別内容を申し込む → 新しい submission_id
_pendingSubId = ''; _pendingKey = ''; _submitting = false; apiCalls = []; _idSeq = 0;
await submitFormSim('山田|d@x|EV1|free|');
await submitFormSim('高橋|e@x|EV1|free|');
assert('(B3) 成功後の別人申込 → 別の submission_id（別行として正しく記録）', apiCalls[0] !== apiCalls[1]);

console.log('\n=== 層1 結果: ' + pass + ' 合格 / ' + fail + ' 不合格 ===');
process.exit(fail === 0 ? 0 : 1);
