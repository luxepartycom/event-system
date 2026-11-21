// 壊して落ちることを確かめる（E0・E0b 画面側）
// admin.html / entrance.html の写しを1か所ずつ壊し、jsdom-e0-auth.cjs が「落ちる」ことを確かめる。
// 落ちない改変が1つでもあれば、その検査は飾り＝終了コード1。実ファイルは触らない。
// 実行: NODE_PATH=~/.cache/claude-node/node_modules node test/mutation-e0-auth.cjs
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TEST = path.join(__dirname, 'jsdom-e0-auth.cjs');
const tmp  = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'e0-ui-mut-'));

// [ラベル, 対象, 元, 置換]
const MUTANTS = [
  ['admin: apiGet/withPw_ が _pw を付けない', 'admin', "  return pw ? Object.assign({}, o, { _pw: pw }) : o;", '  return o;'],
  ['admin: apiPost が素の本文を送る', 'admin', 'body:    JSON.stringify(withPw_(b)),', 'body:    JSON.stringify(b),'],
  ['admin: auth にも _pw を付ける', 'admin', "if (!o || o.action === 'auth' || o._pw !== undefined) return o;", 'if (!o || o._pw !== undefined) return o;'],
  ['admin: ログインへ戻すガードを外す', 'admin', '  if (_authBounced) return;\n', ''],
  ['admin: apiPost の forbidden を見ない', 'admin', '  return checkForbidden_(d);\n}', '  return d;\n}'],
  ['admin: ログインで role を見ない', 'admin', "if (d.ok && d.role === 'admin') {", 'if (d.ok) {'],
  ['admin: 裏の確認で role を見ない', 'admin', "if (!d.ok || d.role !== 'admin') bounceToLogin_();", 'if (!d.ok) bounceToLogin_();'],
  ['admin: 決済前に localStorage へ退避', 'admin', "if (pw) sessionStorage.setItem('lpt_charge_auth', pw);", "if (pw) localStorage.setItem('lpt_charge_auth', pw);"],
  ['admin: 旧版の残りを消さない', 'admin', "  try { localStorage.removeItem('lpt_charge_auth'); } catch (e) {}\n  // E0: 断られて", '  // E0: 断られて'],
  ['admin: 版の印を消す', 'admin', '>E0b-2026-11-21</div>', '></div>'],
  ['entrance: 管理の操作を見分けない', 'entrance', "function needsAdmin_(o) { return !!o && typeof o.action === 'string' && !E0_ENTRANCE_OK.has(o.action); }", 'function needsAdmin_(o) { return false; }'],
  ['entrance: 受付で通す一覧に archiveEvent を足す', 'entrance', "'createVipCash','createVipStripeLink','createVipTransfer','getPromoUrls','getPromoGroups'", "'createVipCash','createVipStripeLink','createVipTransfer','getPromoUrls','getPromoGroups','archiveEvent'"],
  ['entrance: 受付で通す一覧から checkIn を外す', 'entrance', "  'checkIn','getGuests',", "  'getGuests',"],
  ['entrance: 受付の操作に _pw を付けない', 'entrance', "  const pw = authPw_();\n  return pw ? Object.assign({}, o, { _pw: pw }) : o;", '  return o;'],
  ['entrance: 聞く画面を同時に複数出す', 'entrance', '  if (_adminPwAsking) return _adminPwAsking;\n', ''],
  ['entrance: 管理者確認で role を見ない', 'entrance', "if (d && d.ok && d.role === 'admin') { _adminPwE = pw; done(true); }", 'if (d && d.ok) { _adminPwE = pw; done(true); }'],
  ['entrance: 管理者の合言葉を sessionStorage に置く', 'entrance', '{ _adminPwE = pw; done(true); }', "{ _adminPwE = pw; sessionStorage.setItem('lpt_admin_pw', pw); done(true); }"],
  ['entrance: 管理で断られても受付をログアウト', 'entrance', "if (needsAdmin_(sent)) { _adminPwE = '';", 'if (false) {'],
  ['entrance: 管理で断られても覚えた値を捨てない', 'entrance', "if (needsAdmin_(sent)) { _adminPwE = '';", 'if (needsAdmin_(sent)) {'],
  ['entrance: ログインへ戻すガードを外す', 'entrance', '  if (_authBounced) return;\n', ''],
  ['entrance: やめても送る', 'entrance', '    if (!_adminPwE && !(await askAdminPw_())) return null;', '    if (!_adminPwE) await askAdminPw_();'],
  ['entrance: 決済前に localStorage へ退避', 'entrance', "if (pw) sessionStorage.setItem('lpt_charge_auth', pw);", "if (pw) localStorage.setItem('lpt_charge_auth', pw);"],
  ['admin: apiGet を GET（URL）に戻す', 'admin', 'async function apiGet(p)  { return apiPost(getAsPostBody_(p)); }', "async function apiGet(p)  { const r = await fetch(API + '?' + new URLSearchParams(withPw_(p))); return checkForbidden_(await r.json()); }"],
  ['admin: 値を文字列にしない', 'admin', 'function getAsPostBody_(p) { return Object.fromEntries(new URLSearchParams(p)); }', 'function getAsPostBody_(p) { return Object.assign({}, p); }'],
  ['entrance: apiGet を GET（URL）に戻す', 'entrance', 'async function apiGet(p) { return apiPost(getAsPostBody_(p)); }', "async function apiGet(p) { const q = await withPwE_(p); if (!q) return e0Cancelled_(); const r = await fetch(API + '?' + new URLSearchParams(q)); return checkForbiddenE_(await r.json(), p); }"],
  ['entrance: 値を文字列にしない', 'entrance', 'function getAsPostBody_(p) { return Object.fromEntries(new URLSearchParams(p)); }', 'function getAsPostBody_(p) { return Object.assign({}, p); }'],
  ['entrance: 版の印を消す', 'entrance', '>E0b-2026-11-21</div>', '></div>']
];

let caught = 0, missed = 0, broken = 0;
MUTANTS.forEach(([label, which, from, to], i) => {
  const src = fs.readFileSync(path.join(ROOT, which + '.html'), 'utf8');
  if (src.split(from).length !== 2) { broken++; console.log('⚠️  改変の対象が見つからない（1か所でない）: ' + label); return; }
  const f = path.join(tmp, which + '-' + i + '.html');
  fs.writeFileSync(f, src.replace(from, to));
  const env = Object.assign({}, process.env);
  env[which === 'admin' ? 'E0_ADMIN_HTML' : 'E0_ENTRANCE_HTML'] = f;
  const r = spawnSync(process.execPath, [TEST], { env, encoding: 'utf8', timeout: 120000 });
  if (r.status !== 0) { caught++; console.log('✅ 落ちた: ' + label + '（' + ((r.stdout.match(/❌/g) || []).length) + '件）'); }
  else { missed++; console.log('❌ 落ちない: ' + label); }
});
const base = spawnSync(process.execPath, [TEST], { encoding: 'utf8', timeout: 120000 });
console.log((base.status === 0 ? '✅' : '❌') + ' 改変なしでは通る');
fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n—— 改変 ' + MUTANTS.length + ' 件：落ちた ' + caught + ' ／ 落ちない ' + missed + ' ／ 対象なし ' + broken + ' ——');
process.exit(missed === 0 && broken === 0 && base.status === 0 ? 0 : 1);
