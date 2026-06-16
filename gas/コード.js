// 権限承認用（一度だけ手動実行してください）
function requestExternalAccess() {
  UrlFetchApp.fetch('https://api.anthropic.com');
}

// ═══════════════════════════════════════════════════════════
//  LUXE PARTY TOKYO — Google Apps Script v10
//  重複コード削除・速度最適化版
// ═══════════════════════════════════════════════════════════

// ── 環境ルーティング（staging / production 自動切り替え） ──
var _STAGING_DEPLOY_ID = 'AKfycbwYH2RFU4G2RYF6XyYn9-kv5CPSoNREKj52N5-WnKLn7kIAE3KFaEK0Ubn0OQQdvlDJ';
var _imgUrlCache = {}; // セッション内 Drive→GitHub URL キャッシュ
function _getSpreadsheet() {
  try {
    var url = ScriptApp.getService().getUrl();
    if (url.indexOf(_STAGING_DEPLOY_ID) >= 0) {
      var stagingId = PropertiesService.getScriptProperties().getProperty('STAGING_SPREADSHEET_ID');
      if (stagingId) return SpreadsheetApp.openById(stagingId);
    }
  } catch(e) {}
  return SpreadsheetApp.getActiveSpreadsheet();
}
var SS = _getSpreadsheet();
function sheet(name) { return SS.getSheetByName(name); }

// ── staging スプレッドシート初回セットアップ（GASエディタから一度だけ手動実行） ──
function setupStagingSpreadsheet() {
  var prodSS = SpreadsheetApp.getActiveSpreadsheet();
  var newSS = SpreadsheetApp.create('LUXE PARTY TOKYO — staging');
  var defaultSheet = newSS.getSheets()[0];
  var firstDone = false;
  prodSS.getSheets().forEach(function(s) {
    var lastCol = s.getLastColumn();
    if (lastCol < 1) return;
    var headers = s.getRange(1, 1, 1, lastCol).getValues()[0];
    if (!firstDone) {
      defaultSheet.setName(s.getName());
      defaultSheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      firstDone = true;
    } else {
      var ns = newSS.insertSheet(s.getName());
      ns.getRange(1, 1, 1, headers.length).setValues([headers]);
    }
  });
  var ssId = newSS.getId();
  PropertiesService.getScriptProperties().setProperty('STAGING_SPREADSHEET_ID', ssId);
  Logger.log('✅ Staging SS 作成完了: ' + newSS.getUrl());
  Logger.log('ID: ' + ssId);
}
function res(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}

function sheetToObjects(s) {
  var lr = s.getLastRow(), lc = s.getLastColumn();
  if (lr < 2) return [];
  const rows = s.getRange(1, 1, lr, lc).getValues();
  const headers = rows[0].map(h => String(h).trim());
  return rows.slice(1)
    .filter(row => row[0] !== '')
    .map(row => {
      const obj = {};
      headers.forEach((h, i) => {
        obj[h] = (row[i] === undefined || row[i] === null) ? '' : row[i];
      });
      return obj;
    });
}

function extractDriveFileId_(url) {
  if (!url) return null;
  var m = url.match(/\/file\/d\/([^\/\?#]+)/);
  if (m) return m[1];
  m = url.match(/[?&]id=([^&]+)/);
  if (m) return m[1];
  return null;
}

function getDriveViewUrl_(url) {
  var fileId = extractDriveFileId_(url);
  return fileId ? 'https://drive.google.com/uc?export=view&id=' + fileId : url;
}

// Drive画像をGitHub assetsブランチに公開し raw.githubusercontent.com URL を返す。
// セッション内キャッシュにより同一画像の重複アップロードを防止。
// GITHUB_TOKEN が未設定の場合はフォールバック URL を返す。
function convertDriveUrl(url) {
  if (!url) return '';
  if (_imgUrlCache[url]) return _imgUrlCache[url];
  var fileId = extractDriveFileId_(url);
  if (!fileId) return url;
  var result = publishFlierToGitHub_(fileId);
  _imgUrlCache[url] = result;
  return result;
}

function publishFlierToGitHub_(fileId) {
  var token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!token) {
    console.warn('GITHUB_TOKEN 未設定: 画像が一部のメールクライアントで表示されない場合があります');
    return 'https://drive.google.com/uc?export=view&id=' + fileId;
  }
  try {
    var driveResp = UrlFetchApp.fetch(
      'https://drive.google.com/uc?export=view&id=' + fileId,
      {followRedirects: true, muteHttpExceptions: true}
    );
    if (driveResp.getResponseCode() !== 200) {
      console.error('Drive画像取得失敗 ' + driveResp.getResponseCode() + ' id=' + fileId);
      return 'https://drive.google.com/uc?export=view&id=' + fileId;
    }
    var blob = driveResp.getBlob();
    var ct = blob.getContentType() || '';
    if (ct.indexOf('image') === -1) {
      console.error('Drive応答が画像ではない (contentType=' + ct + ') id=' + fileId);
      return 'https://drive.google.com/uc?export=view&id=' + fileId;
    }
    var ext = ct.split('/')[1] || 'jpg';
    if (ext === 'jpeg') ext = 'jpg';
    var filename = fileId + '.' + ext;

    var apiUrl = 'https://api.github.com/repos/luxepartycom/event-system/contents/flyers/' + filename;
    var headers = {
      'Authorization': 'Bearer ' + token,
      'Accept': 'application/vnd.github.v3+json'
    };

    var sha = null;
    var check = UrlFetchApp.fetch(apiUrl + '?ref=assets', {headers: headers, muteHttpExceptions: true});
    if (check.getResponseCode() === 200) {
      sha = JSON.parse(check.getContentText()).sha;
    }

    var body = {message: 'flyer: ' + filename, content: Utilities.base64Encode(blob.getBytes()), branch: 'assets'};
    if (sha) body.sha = sha;

    var put = UrlFetchApp.fetch(apiUrl, {
      method: 'PUT', headers: headers, payload: JSON.stringify(body), muteHttpExceptions: true
    });
    if (put.getResponseCode() === 200 || put.getResponseCode() === 201) {
      return 'https://raw.githubusercontent.com/luxepartycom/event-system/assets/flyers/' + filename;
    }
    console.error('GitHub upload失敗: ' + put.getContentText());
    return 'https://drive.google.com/uc?export=view&id=' + fileId;
  } catch (e) {
    console.error('publishFlierToGitHub_ error: ' + e.message);
    return 'https://drive.google.com/uc?export=view&id=' + fileId;
  }
}

// ウォームアップ用ping関数（5分おきのトリガーで実行）
function ping() {
  // GASをウォーム状態に保つためのダミー処理
  SpreadsheetApp.getActiveSpreadsheet().getName();
  console.log('ping: ' + new Date().toISOString());
}

function nowStr() {
  return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm');
}

function todayStr() {
  return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
}

function removeEmoji(str) {
  if (!str) return '';
  var s = String(str);
  var result = '';
  for (var i = 0; i < s.length; i++) {
    var code = s.charCodeAt(i);
    if (code >= 0xD800 && code <= 0xDFFF) continue;
    if (code >= 0x2600 && code <= 0x27BF) continue;
    if (code >= 0x2B00 && code <= 0x2BFF) continue;
    if (code >= 0xFE00 && code <= 0xFEFF) continue;
    result += s[i];
  }
  return result.replace(/  +/g, ' ').trim();
}

// 絵文字・Mathematical Bold等のサロゲートペア文字をHTMLエンティティに変換
// → すべてのメールクライアントで正しく表示できる
function encodeEmojiForHtml(str) {
  if (!str) return '';
  var s = String(str);
  var result = '';
  for (var i = 0; i < s.length; i++) {
    var code = s.charCodeAt(i);
    if (code >= 0xD800 && code <= 0xDBFF && i + 1 < s.length) {
      var next = s.charCodeAt(i + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) {
        var cp = (code - 0xD800) * 0x400 + (next - 0xDC00) + 0x10000;
        result += '&#x' + cp.toString(16).toUpperCase() + ';';
        i++;
        continue;
      }
    }
    result += s[i];
  }
  return result;
}

// 件名用：Mathematical Bold等の特殊フォント文字を対応するASCIIに変換し、絵文字は除去
function sanitizeSubject(str) {
  if (!str) return '';
  var s = String(str);
  var result = '';
  for (var i = 0; i < s.length; i++) {
    var code = s.charCodeAt(i);
    if (code >= 0xD800 && code <= 0xDBFF && i + 1 < s.length) {
      var next = s.charCodeAt(i + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) {
        var cp = (code - 0xD800) * 0x400 + (next - 0xDC00) + 0x10000;
        // Mathematical Bold Capital A-Z (U+1D400-U+1D419)
        if (cp >= 0x1D400 && cp <= 0x1D419) { result += String.fromCharCode(cp - 0x1D400 + 65); }
        // Mathematical Bold Small a-z (U+1D41A-U+1D433)
        else if (cp >= 0x1D41A && cp <= 0x1D433) { result += String.fromCharCode(cp - 0x1D41A + 97); }
        // Mathematical Bold Italic Capital A-Z (U+1D468-U+1D481)
        else if (cp >= 0x1D468 && cp <= 0x1D481) { result += String.fromCharCode(cp - 0x1D468 + 65); }
        // Mathematical Bold Italic Small a-z (U+1D482-U+1D49B)
        else if (cp >= 0x1D482 && cp <= 0x1D49B) { result += String.fromCharCode(cp - 0x1D482 + 97); }
        // その他サロゲートペア（絵文字等）は除去
        i++;
        continue;
      }
    }
    result += s[i];
  }
  return result.replace(/  +/g, ' ').trim();
}

function linkifyText(str) {
  if (!str) return '';
  return String(str).replace(
    /(https?:\/\/[^\s<>"\u3000-\u9fff\uff00-\uffef]+)/g,
    '<a href="$1" style="color:#C9A84C;word-break:break-all;">$1</a>'
  );
}

// ══════════════════════════════════════════════════════════
//  当日メール送信
// ══════════════════════════════════════════════════════════
function sendDayOfEmails() {
  const today = todayStr();
  const events = sheetToObjects(sheet('events')).filter(ev => {
    var d = ev.date;
    var dStr = (d instanceof Date)
      ? Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy-MM-dd')
      : String(d).substring(0, 10);
    return dStr === today && String(ev.status) !== 'closed';
  });
  if (events.length === 0) return;

  const gs      = sheet('guests');
  const gsRows  = gs.getDataRange().getValues();
  const headers = gsRows[0].map(h => String(h).trim());
  let reminderCol = headers.indexOf('reminder_sent');
  if (reminderCol < 0) {
    gs.getRange(1, headers.length + 1).setValue('reminder_sent');
    headers.push('reminder_sent');
    reminderCol = headers.length - 1;
    if (gsRows.length > 1) gs.getRange(2, reminderCol+1, gsRows.length-1, 1).setValue('FALSE');
    SpreadsheetApp.flush();
  }

  let sentCount = 0;
  events.forEach(ev => {
    const guests    = sheetToObjects(gs).filter(g => String(g.event_id) === String(ev.event_id));
    const evDateStr = (ev.date instanceof Date)
      ? Utilities.formatDate(ev.date, 'Asia/Tokyo', 'yyyy\u5e74M\u6708d\u65e5')
      : String(ev.date).substring(0, 10);
    const descForEmail = removeEmoji(ev.description);
    const descRow = descForEmail
      ? '<div style="margin-top:10px;padding-top:10px;border-top:1px solid rgba(255,255,255,0.1);font-size:0.72rem;color:#aaa;line-height:1.9;white-space:pre-wrap;">' + linkifyText(descForEmail) + '</div>'
      : '';
    guests.forEach(g => {
      if (String(g.reminder_sent).toUpperCase() === 'TRUE') return;
      if (!g.email) return;
      if (String(g.arrived).toUpperCase() === 'TRUE') return;
      try {
        const payLabel  = g.pay_type === 'free' ? '\u7121\u6599\u62db\u5f85' : '\u6709\u6599\u62db\u5f85 \u00a5' + Number(g.amount||0).toLocaleString();
        const qrPageUrl = 'https://luxepartycom.github.io/event-system/qr.html?id=' + encodeURIComponent(g.guest_id);
        const subject   = '\u300cLUXE PARTY TOKYO\u300d\u672c\u65e5\u958b\u50ac\u306e\u3054\u6848\u5185 \u2014 ' + ev.name;
        const html = buildDayOfHtml(g, ev, evDateStr, payLabel, qrPageUrl, descRow, false);
        GmailApp.sendEmail(g.email, subject,
          g.name + '\u69d8\u3001\u672c\u65e5\u306f\u300c' + ev.name + '\u300d\u3067\u3059\u3002QR: ' + qrPageUrl,
          { htmlBody: html, name: 'LUXE PARTY TOKYO' });
        const refreshed = gs.getDataRange().getValues();
        const gcol = refreshed[0].map(h => String(h).trim()).indexOf('guest_id');
        for (let i=1; i<refreshed.length; i++) {
          if (String(refreshed[i][gcol]) === String(g.guest_id)) {
            gs.getRange(i+1, reminderCol+1).setValue('TRUE'); break;
          }
        }
        sentCount++;
        Utilities.sleep(300);
      } catch(mailErr) {
        console.error('\u5f53\u65e5\u30e1\u30fc\u30eb\u5931\u6557: ' + g.guest_id + ' - ' + mailErr.message);
      }
    });
  });
  SpreadsheetApp.flush();
  console.log('\u5f53\u65e5\u30e1\u30fc\u30eb\u5b8c\u4e86: ' + sentCount + '\u4ef6');
}

function buildDayOfHtml(g, ev, evDateStr, payLabel, qrPageUrl, descRow, isTest) {
  var testBanner = isTest
    ? '<div style="background:#CF4444;padding:8px;font-size:0.7rem;color:#fff;text-align:center;margin-bottom:20px;">\u26a0\ufe0f \u30c6\u30b9\u30c8\u9001\u4fe1 / TEST MAIL</div>'
    : '';
  return '<div style="background:#080808;padding:40px 20px;font-family:sans-serif;color:#F5F0E8;max-width:480px;margin:0 auto;">'
    + testBanner
    + '<div style="font-size:1.4rem;color:#C9A84C;letter-spacing:0.3em;margin-bottom:4px;">LUXE PARTY TOKYO</div>'
    + '<div style="font-size:0.7rem;color:#888;letter-spacing:0.2em;margin-bottom:32px;">TODAY\'S EVENT</div>'
    + '<p style="margin-bottom:8px;font-size:0.9rem;">' + g.name + ' \u69d8</p>'
    + '<p style="color:#aaa;font-size:0.8rem;line-height:1.8;margin-bottom:24px;">'
    +   '\u3053\u306e\u5ea6\u306f\u304a\u7533\u3057\u8fbc\u307f\u3044\u305f\u3060\u304d\u3042\u308a\u304c\u3068\u3046\u3054\u3056\u3044\u307e\u3059\u3002<br>'
    +   '\u672c\u65e5\u306e\u30a4\u30d9\u30f3\u30c8\u3078\u306e\u3054\u53c2\u52a0\u3092\u304a\u5f85\u3061\u3057\u3066\u304a\u308a\u307e\u3059\u3002<br>'
    +   '\u4e0b\u8a18\u30dc\u30bf\u30f3\u304b\u3089\u5165\u5834\u7528QR\u30b3\u30fc\u30c9\u3092\u3054\u78ba\u8a8d\u304f\u3060\u3055\u3044\u3002'
    + '</p>'
    + '<div style="background:#111;border:1px solid rgba(201,168,76,0.2);padding:20px 24px;text-align:center;margin-bottom:20px;">'
    +   '<div style="font-size:0.5rem;letter-spacing:0.3em;color:#888;text-transform:uppercase;margin-bottom:10px;">GUEST ID</div>'
    +   '<div style="font-size:1.3rem;color:#C9A84C;letter-spacing:0.15em;font-family:monospace;margin-bottom:20px;">' + g.guest_id + '</div>'
    +   '<a href="' + qrPageUrl + '" style="display:inline-block;background:#C9A84C;color:#000;text-decoration:none;padding:14px 32px;font-size:0.7rem;font-weight:700;letter-spacing:0.2em;text-transform:uppercase;">&#9654; QR\u30b3\u30fc\u30c9\u3092\u8868\u793a\u3059\u308b</a>'
    +   '<div style="font-size:0.55rem;color:#666;margin-top:10px;">\u30bf\u30c3\u30d7\u3059\u308b\u3068QR\u30b3\u30fc\u30c9\u304c\u8868\u793a\u3055\u308c\u307e\u3059</div>'
    + '</div>'
    + '<div style="background:#111;border:1px solid rgba(255,255,255,0.06);padding:14px 20px;margin-bottom:24px;font-size:0.75rem;color:#aaa;">'
    +   '<div style="margin-bottom:6px;">\u30a4\u30d9\u30f3\u30c8: <strong style="color:#F5F0E8;">' + ev.name + '</strong></div>'
    +   '<div style="margin-bottom:6px;">\u65e5\u7a0b: <strong style="color:#F5F0E8;">' + evDateStr + '</strong></div>'
    +   '<div>\u7a2e\u5225: <strong style="color:#F5F0E8;">' + payLabel + '</strong></div>'
    +   descRow
    + '</div>'
    + '<p style="font-size:0.6rem;color:#444;line-height:1.8;">'
    +   (isTest ? '\u203b \u30c6\u30b9\u30c8\u9001\u4fe1\u3067\u3059\u3002' : '\u203b \u3053\u306e\u30e1\u30fc\u30eb\u306f\u30b7\u30b9\u30c6\u30e0\u304b\u3089\u81ea\u52d5\u9001\u4fe1\u3055\u308c\u3066\u3044\u307e\u3059\u3002<br>\u203b \u3054\u4e0d\u660e\u306a\u70b9\u306f\u304a\u7533\u3057\u8fbc\u307f\u306e\u30d7\u30ed\u30e2\u30fc\u30bf\u30fc\u307e\u3067\u304a\u554f\u3044\u5408\u308f\u305b\u304f\u3060\u3055\u3044\u3002')
    + '</p>'
    + '</div>';
}

function sendDayOfEmailsTest() {
  const gs        = sheet('guests');
  const allGuests = sheetToObjects(gs);
  const allEvents = sheetToObjects(sheet('events'));
  const targets   = allGuests.filter(g => String(g.name).includes('\u30c6\u30b9\u30c8') && g.email);
  if (!targets.length) { console.log('\u5bfe\u8c61\u306a\u3057'); return; }
  let sent = 0;
  targets.forEach(g => {
    const ev = allEvents.find(e => String(e.event_id) === String(g.event_id));
    if (!ev) return;
    try {
      const payLabel  = g.pay_type === 'free' ? '\u7121\u6599\u62db\u5f85' : '\u6709\u6599\u62db\u5f85 \u00a5' + Number(g.amount||0).toLocaleString();
      const qrPageUrl = 'https://luxepartycom.github.io/event-system/qr.html?id=' + encodeURIComponent(g.guest_id);
      const evDateStr = (ev.date instanceof Date)
        ? Utilities.formatDate(ev.date, 'Asia/Tokyo', 'yyyy\u5e74M\u6708d\u65e5')
        : String(ev.date).substring(0, 10);
      const descForEmail = removeEmoji(ev.description);
      const descRow = descForEmail
        ? '<div style="margin-top:10px;padding-top:10px;border-top:1px solid rgba(255,255,255,0.1);font-size:0.72rem;color:#aaa;line-height:1.9;white-space:pre-wrap;">' + linkifyText(descForEmail) + '</div>'
        : '';
      const subject = '[\u30c6\u30b9\u30c8][LUXE PARTY TOKYO]\u5f53\u65e5\u30e1\u30fc\u30eb \u2014 ' + ev.name;
      GmailApp.sendEmail(g.email, subject, '[\u30c6\u30b9\u30c8]' + g.name + '\u69d8 QR: ' + qrPageUrl,
        { htmlBody: buildDayOfHtml(g, ev, evDateStr, payLabel, qrPageUrl, descRow, true), name: 'LUXE PARTY TOKYO' });
      sent++;
      Utilities.sleep(300);
    } catch(e) { console.log('\u9001\u4fe1\u30a8\u30e9\u30fc: ' + e.message); }
  });
  console.log('=== \u5b8c\u4e86: ' + sent + '\u4ef6 ===');
}

// ── GET ─────────────────────────────────────────────────
function doGet(e) {
  var action = e.parameter.action || '';
  try {
    switch(action) {

      case 'ping': return res({ ok: true });

      case 'auth': {
        var settings      = sheetToObjects(sheet('settings'));
        var adminPw       = (settings.find(function(s){ return s.key === 'admin_password'; }) || {}).value || 'admin1234';
        var entrancePw    = PropertiesService.getScriptProperties().getProperty('ENTRANCE_PASSWORD') || '';
        var mode          = e.parameter.mode || '';
        // entrance専用モード: entranceパスワードのみ許可
        if (mode === 'entrance') {
          if (entrancePw && String(e.parameter.password) === String(entrancePw)) return res({ ok: true, role: 'entrance' });
          return res({ ok: false, message: '\u30d1\u30b9\u30ef\u30fc\u30c9\u304c\u9055\u3044\u307e\u3059' });
        }
        // 通常モード: adminパスワードで認証
        if (String(e.parameter.password) === String(adminPw)) return res({ ok: true, role: 'admin' });
        if (entrancePw && String(e.parameter.password) === String(entrancePw)) return res({ ok: true, role: 'entrance' });
        return res({ ok: false, message: '\u30d1\u30b9\u30ef\u30fc\u30c9\u304c\u9055\u3044\u307e\u3059' });
      }

      case 'getEvents': {
        var events = sheetToObjects(sheet('events'));
        // 各イベントのプラン情報を付加
        var plansSheet = sheet('event_plans');
        var allPlans = plansSheet ? sheetToObjects(plansSheet) : [];
        events.forEach(function(ev) {
          ev.plans = allPlans.filter(function(p) {
            return String(p.event_id) === String(ev.event_id);
          });
        });
        return res({ ok: true, events: events });
      }

      // ── 速度改善: ループ内でevent_idフィルタリングし全件取得を回避 ──
      // ── アーカイブ対応: guests + guests_archive 両方を検索 ──
      case 'getGuests': {
        var eventId = e.parameter.event_id || '';

        // 返却する列を必要最小限に絞る（速度改善）
        var NEEDED = ['guest_id','event_id','name','email','gender',
                      'invited_by','pay_type','amount','pay_confirmed',
                      'arrived','payment_method'];

        function fetchFromSheetLite(sheetName) {
          var s = sheet(sheetName);
          if (!s) return [];
          var lastRow = s.getLastRow();
          var lastCol = s.getLastColumn();
          if (lastRow < 2) return [];

          var rows    = s.getRange(1, 1, lastRow, lastCol).getValues();
          var headers = rows[0].map(function(h){ return String(h).trim(); });

          // 必要列のインデックスを事前計算
          var evIdx  = headers.indexOf('event_id');
          var colMap = {};
          NEEDED.forEach(function(f) {
            colMap[f] = headers.indexOf(f);
          });

          var result = [];
          for (var i = 1; i < rows.length; i++) {
            if (!rows[i][0]) continue;
            if (eventId && String(rows[i][evIdx]) !== String(eventId)) continue;
            var obj = {};
            NEEDED.forEach(function(f) {
              var idx = colMap[f];
              obj[f] = (idx < 0 || rows[i][idx] === undefined || rows[i][idx] === null)
                       ? '' : rows[i][idx];
            });
            result.push(obj);
          }
          return result;
        }

        // guestsシートのみ取得（archive不要の場合は除外）
        // archive含む: guests + guests_archive両方
        var includeArchive = e.parameter.include_archive === 'true';
        var guests = fetchFromSheetLite('guests');
        if (includeArchive) {
          guests = guests.concat(fetchFromSheetLite('guests_archive'));
        }
        return res({ ok: true, guests: guests });
      }

      case 'getPromoUrls': {
        var eventId = e.parameter.event_id || '';
        var s = sheet('promoter_urls');
        if (!s) return res({ ok: true, urls: [] });
        var all  = sheetToObjects(s);
        var urls = eventId ? all.filter(function(u){ return String(u.event_id) === String(eventId); }) : all;
        return res({ ok: true, urls: urls });
      }

      case 'getPromoGroups': {
        var eventId = e.parameter.event_id || '';
        var pgS = sheet('promo_groups');
        if (!pgS) return res({ ok: true, groups: [] });
        var pgRows = pgS.getDataRange().getValues();
        var result = [];
        for (var i = 1; i < pgRows.length; i++) {
          if (String(pgRows[i][0]) !== String(eventId)) continue;
          try { result.push(JSON.parse(String(pgRows[i][1]))); } catch(e2) {}
        }
        return res({ ok: true, groups: result });
      }

      case 'unsubscribe': {
        var unsubEmail = e.parameter.email || '';
        var unsubName  = e.parameter.name  || '';
        if (!unsubEmail) return ContentService.createTextOutput('メールアドレスが指定されていません').setMimeType(ContentService.MimeType.TEXT);
        var us = sheet('unsubscribe');
        if (!us) { us = SS.insertSheet('unsubscribe'); us.appendRow(['email', 'name', 'unsubscribed_at']); }
        // ヘッダーにname列がない場合は追加
        var usLastCol = us.getLastColumn();
        var usHeaders = us.getRange(1, 1, 1, usLastCol).getValues()[0].map(function(h){ return String(h).trim(); });
        if (usHeaders.indexOf('name') < 0) { us.getRange(1, usLastCol + 1).setValue('name'); }
        var usRows = us.getDataRange().getValues();
        for (var i = 1; i < usRows.length; i++) {
          if (String(usRows[i][0]).toLowerCase() === unsubEmail.toLowerCase()) {
            return ContentService.createTextOutput('配信停止の手続きは既に完了しています。').setMimeType(ContentService.MimeType.TEXT);
          }
        }
        us.appendRow([unsubEmail, unsubName, nowStr()]);
        SpreadsheetApp.flush();
        return ContentService.createTextOutput('配信停止の手続きが完了しました。今後メールは送信されません。').setMimeType(ContentService.MimeType.TEXT);
      }


      
        
        case 'migrateEvents': {
        // eventsシートにpayment_methods列を追加
        var evS = sheet('events');
        if (!evS) return res({ ok: false });
        var evH = evS.getRange(1,1,1,evS.getLastColumn()).getValues()[0].map(function(h){ return String(h).trim(); });
        var evAdded = [];
        if (evH.indexOf('payment_methods') < 0) {
          evS.getRange(1, evS.getLastColumn()+1).setValue('payment_methods');
          evAdded.push('payment_methods追加');
          SpreadsheetApp.flush();
        }
        return res({ ok: true, added: evAdded });
      }
      case 'getVipTicket': {
        var gidT = e.parameter.guest_id || '';
        if (!gidT) return res({ ok: false, message: 'guest_idが必要です' });
        var vtsT2 = sheet('vip_tables');
        if (!vtsT2) return res({ ok: false, message: 'テーブルデータがありません' });
        var vtT2Rows = vtsT2.getRange(1,1,vtsT2.getLastRow(),vtsT2.getLastColumn()).getValues();
        var vtT2H = vtT2Rows[0].map(function(c){ return String(c).trim(); });
        var gidT2Idx = vtT2H.indexOf('guest_id');
        for (var i=1; i<vtT2Rows.length; i++) {
          if (String(vtT2Rows[i][gidT2Idx]) === gidT) {
            var tNameT2 = String(vtT2Rows[i][vtT2H.indexOf('table_name')]||'');
            var tTypeT2 = String(vtT2Rows[i][vtT2H.indexOf('table_type')]||'');
            var stT2    = String(vtT2Rows[i][vtT2H.indexOf('status')]||'');
            var gNameT2 = String(vtT2Rows[i][vtT2H.indexOf('reserved_by')]||'');
            var evIdT2  = String(vtT2Rows[i][vtT2H.indexOf('event_id')]||'');
            var evNameT2 = '';
            var evST2 = sheet('events');
            if (evST2) {
              var evRT2 = evST2.getDataRange().getValues();
              var evHT2 = evRT2[0].map(function(c){ return String(c).trim(); });
              for (var ei=1; ei<evRT2.length; ei++) {
                if (String(evRT2[ei][evHT2.indexOf('event_id')]) === evIdT2) {
                  evNameT2 = String(evRT2[ei][evHT2.indexOf('name')]||'');
                  break;
                }
              }
            }
            return res({ ok: true, table_name: tNameT2, table_type: tTypeT2,
              status: stT2, guest_name: gNameT2, event_name: evNameT2 });
          }
        }
        return res({ ok: false, message: '招待状が見つかりません' });
      }

      case 'getVipTables': {
        var eventIdV = e.parameter.event_id || '';
        return res({ ok: true, tables: getVipTables(eventIdV) });
      }

      case 'getVipReservations': {
        var eventIdVR = e.parameter.event_id || '';
        return res({ ok: true, reservations: getVipReservations(eventIdVR) });
      }

      case 'migrateEventPlans': {
        var mps = sheet('event_plans');
        if (!mps) return res({ ok: false });
        var mpH = mps.getRange(1,1,1,mps.getLastColumn()).getValues()[0].map(function(h){ return String(h).trim(); });
        var added = [];
        ['redirect_url','display_text','payment_methods'].forEach(function(col){
          if (mpH.indexOf(col) < 0) {
            mps.getRange(1, mps.getLastColumn()+1).setValue(col);
            added.push(col);
            SpreadsheetApp.flush();
          }
        });
        return res({ ok: true, added: added });
      }

    }
  } catch(err) { return res({ ok: false, message: err.message }); }
}




// ─────────
function doPost(e) {
  var body;
  try { body = JSON.parse(e.postData.contents); }
  catch(err) { return res({ ok: false, message: 'JSON\u30d1\u30fc\u30b9\u30a8\u30e9\u30fc' }); }
  var action = body.action || '';
  try {
    switch(action) {

      case 'addEvent': {
        var id = 'EV-' + Date.now().toString(36).toUpperCase();
        // payment_methods: 'card,walkin'=両方 / 'card'=カードのみ / 'walkin'=当日のみ
        var payMethods = body.payment_methods || 'card,walkin';
        sheet('events').appendRow([id, body.name, body.date, 'active',
          Number(body.price_male||0), Number(body.price_female||0),
          body.description||'', payMethods]);
        return res({ ok: true, event_id: id });
      }

      case 'updateEventDescription': {
        var s = sheet('events'), rows = s.getDataRange().getValues();
        var headers = rows[0].map(function(h){ return String(h).trim(); });
        var descIdx = headers.indexOf('description');
        if (descIdx < 0) return res({ ok: false, message: 'description\u5217\u304c\u3042\u308a\u307e\u305b\u3093' });
        for (var i=1; i<rows.length; i++) {
          if (String(rows[i][headers.indexOf('event_id')]) === String(body.event_id)) {
            s.getRange(i+1, descIdx+1).setValue(body.description||'');
            SpreadsheetApp.flush();
            return res({ ok: true });
          }
        }
        return res({ ok: false, message: '\u30a4\u30d9\u30f3\u30c8\u304c\u898b\u3064\u304b\u308a\u307e\u305b\u3093' });
      }

      case 'updateEventStatus': {
        var s = sheet('events'), rows = s.getDataRange().getValues();
        var headers = rows[0].map(function(h){ return String(h).trim(); });
        for (var i=1; i<rows.length; i++) {
          if (String(rows[i][headers.indexOf('event_id')]) === String(body.event_id)) {
            s.getRange(i+1, headers.indexOf('status')+1).setValue(body.status);
            return res({ ok: true });
          }
        }
        return res({ ok: false, message: '\u30a4\u30d9\u30f3\u30c8\u304c\u898b\u3064\u304b\u308a\u307e\u305b\u3093' });
      }

      case 'registerGuest': {
        var id      = 'G-' + Date.now().toString(36).toUpperCase();
        var payType = body.pay_type === 'free' ? 'free' : 'paid';
        var planId  = body.plan_id || '';
        var amount  = 0;
        if (payType === 'paid') {
          // プランから料金を取得（プランがある場合はプランを優先）
          if (planId) {
            var ps7 = sheet('event_plans');
            if (ps7) {
              var ps7Rows = ps7.getRange(1,1,ps7.getLastRow(),ps7.getLastColumn()).getValues();
              var ps7H    = ps7Rows[0].map(function(h){ return String(h).trim(); });
              var pidIdx7 = ps7H.indexOf('plan_id');
              var pmIdx7  = ps7H.indexOf('price_male');
              var pfIdx7  = ps7H.indexOf('price_female');
              for (var i=1; i<ps7Rows.length; i++) {
                if (String(ps7Rows[i][pidIdx7]) === planId) {
                  amount = body.gender === 'female'
                    ? Number(ps7Rows[i][pfIdx7] || 0)
                    : Number(ps7Rows[i][pmIdx7] || 0);
                  break;
                }
              }
            }
          } else {
            var ev = sheetToObjects(sheet('events')).find(function(ev){
              return String(ev.event_id) === String(body.event_id);
            });
            if (ev) amount = body.gender === 'female' ? Number(ev.price_female||0) : Number(ev.price_male||0);
          }
        }
        sheet('guests').appendRow([
          id, body.event_id||'', body.name||'', body.email||'', body.gender||'', body.invited_by||'',
          payType, amount, 'FALSE', 'FALSE', '', nowStr(), '', 'FALSE', '', planId
        ]);
        SpreadsheetApp.flush();
        // プラン申込数を+1（男女別）
        if (planId) {
          var ps8 = sheet('event_plans');
          if (ps8) {
            var ps8Rows  = ps8.getRange(1,1,ps8.getLastRow(),ps8.getLastColumn()).getValues();
            var ps8H     = ps8Rows[0].map(function(h){ return String(h).trim(); });
            var pidIdx8  = ps8H.indexOf('plan_id');
            var cntIdx8  = ps8H.indexOf('current_count');
            var capIdx8  = ps8H.indexOf('capacity');
            var stIdx8   = ps8H.indexOf('status');
            var cmIdx8   = ps8H.indexOf('capacity_male');
            var cfIdx8   = ps8H.indexOf('capacity_female');
            var cntMIdx8 = ps8H.indexOf('count_male');
            var cntFIdx8 = ps8H.indexOf('count_female');
            var gender8  = body.gender || '';
            for (var i=1; i<ps8Rows.length; i++) {
              if (String(ps8Rows[i][pidIdx8]) !== planId) continue;
              // 合計+1
              var newCnt = Number(ps8Rows[i][cntIdx8]||0) + 1;
              ps8.getRange(i+1, cntIdx8+1).setValue(newCnt);
              // 性別別+1
              if (gender8 === 'male' && cntMIdx8 >= 0) {
                var newM = Number(ps8Rows[i][cntMIdx8]||0) + 1;
                ps8.getRange(i+1, cntMIdx8+1).setValue(newM);
                var capM8 = cmIdx8 >= 0 ? Number(ps8Rows[i][cmIdx8]||0) : 0;
                if (capM8 > 0 && newM >= capM8) ps8.getRange(i+1, stIdx8+1).setValue('full');
              } else if (gender8 === 'female' && cntFIdx8 >= 0) {
                var newF = Number(ps8Rows[i][cntFIdx8]||0) + 1;
                ps8.getRange(i+1, cntFIdx8+1).setValue(newF);
                var capF8 = cfIdx8 >= 0 ? Number(ps8Rows[i][cfIdx8]||0) : 0;
                if (capF8 > 0 && newF >= capF8) ps8.getRange(i+1, stIdx8+1).setValue('full');
              }
              // 合計上限チェック
              var cap8 = Number(ps8Rows[i][capIdx8]||0);
              if (cap8 > 0 && newCnt >= cap8) ps8.getRange(i+1, stIdx8+1).setValue('full');
              SpreadsheetApp.flush();
              break;
            }
          }
        }
        return res({ ok: true, guest_id: id, pay_type: payType, amount: amount, plan_id: planId });
      }

      case 'checkIn': {
        var payMethod = body.payment_method || '';

        // VIP専用フロー（guest_idが「VIP-」始まりの場合はvip_tablesを参照）
        if (String(body.guest_id).indexOf('VIP-') === 0) {
          var vtsChk = sheet('vip_tables');
          if (!vtsChk) return res({ ok: false, status: 'not_found', message: '登録が見つかりません' });
          var vtChkRows = vtsChk.getRange(1,1,vtsChk.getLastRow(),vtsChk.getLastColumn()).getValues();
          var vtChkH = vtChkRows[0].map(function(c){ return String(c).trim(); });
          // checked_count列がなければ追加
          var cntChkIdx = vtChkH.indexOf('checked_count');
          if (cntChkIdx < 0) {
            vtsChk.getRange(1, vtChkH.length + 1).setValue('checked_count');
            vtChkH.push('checked_count');
            cntChkIdx = vtChkH.length - 1;
            vtChkRows = vtsChk.getRange(1,1,vtsChk.getLastRow(),vtsChk.getLastColumn()).getValues();
          }
          var vipChkRow = -1;
          for (var vi=1; vi<vtChkRows.length; vi++) {
            if (String(vtChkRows[vi][vtChkH.indexOf('guest_id')]) === String(body.guest_id)) { vipChkRow = vi; break; }
          }
          if (vipChkRow < 0) return res({ ok: false, status: 'not_found', message: '登録が見つかりません' });
          var vipChkR = vtChkRows[vipChkRow];
          var vipSt = String(vipChkR[vtChkH.indexOf('status')] || '');
          if (vipSt !== 'confirmed') return res({ ok: false, status: 'not_confirmed', message: 'ご予約がまだ確定していません' });
          var capChk = Number(vipChkR[vtChkH.indexOf('capacity')] || 0);
          var cntChk = Number(vipChkR[cntChkIdx] || 0) + 1;
          vtsChk.getRange(vipChkRow+1, cntChkIdx+1).setValue(cntChk);
          SpreadsheetApp.flush();
          return res({
            ok: true, status: 'checked_in',
            name:           String(vipChkR[vtChkH.indexOf('reserved_by')]     || ''),
            gender:         '',
            invited_by:     '',
            pay_type:       'paid',
            amount:         Number(vipChkR[vtChkH.indexOf('price')]           || 0),
            payment_method: String(vipChkR[vtChkH.indexOf('payment_method')] || ''),
            vip_info: {
              table_name:    String(vipChkR[vtChkH.indexOf('table_name')] || ''),
              table_type:    String(vipChkR[vtChkH.indexOf('table_type')] || ''),
              capacity:      capChk,
              checked_count: cntChk,
              is_over:       capChk > 0 && cntChk > capChk
            }
          });
        }

        // 通常ゲスト: guests + guests_archive 両方を検索
        function findGuestRow(sheetName) {
          var s = sheet(sheetName);
          if (!s) return null;
          var lastRow = s.getLastRow();
          var lastCol = s.getLastColumn();
          if (lastRow < 2) return null;
          var rows = s.getRange(1, 1, lastRow, lastCol).getValues();
          var headers = rows[0].map(function(h){ return String(h).trim(); });
          function ci(h){ return headers.indexOf(h); }
          var gCol = ci('guest_id');
          for (var i = 1; i < rows.length; i++) {
            if (String(rows[i][gCol]) === String(body.guest_id)) {
              return { sheet: s, rows: rows, headers: headers, rowNum: i+1, row: rows[i], ci: ci };
            }
          }
          return null;
        }

        var found = findGuestRow('guests') || findGuestRow('guests_archive');
        if (!found) return res({ ok: false, status: 'not_found', message: '登録が見つかりません' });

        var r = found.row, ci = found.ci, s = found.sheet, rowNum = found.rowNum;
        var gName    = r[ci('name')]           || '';
        var gGender  = r[ci('gender')]         || '';
        var gInvBy   = r[ci('invited_by')]     || '';
        var gPayType = r[ci('pay_type')]       || '';
        var gAmount  = r[ci('amount')]         || 0;
        var gPayConf = String(r[ci('pay_confirmed')]).toUpperCase() === 'TRUE';
        var gArrived = String(r[ci('arrived')]).toUpperCase() === 'TRUE';
        var gPayMeth = r[ci('payment_method')] || '';

        // 入場済み
        if (gArrived) return res({
          ok: false, status: 'duplicate', message: '入場済みです',
          name: gName, gender: gGender, invited_by: gInvBy,
          pay_type: gPayType, amount: gAmount, payment_method: gPayMeth
        });

        // 当日払い未決済（payment_methodが指定されていない場合）
        if (gPayType === 'paid' && !gPayConf && !payMethod) return res({
          ok: false, status: 'payment_required',
          name: gName, gender: gGender, invited_by: gInvBy,
          pay_type: gPayType, amount: gAmount
        });

        // チェックイン処理（一括セット）
        var now = nowStr();
        if (payMethod) {
          if (ci('payment_method') >= 0) s.getRange(rowNum, ci('payment_method')+1).setValue(payMethod);
          s.getRange(rowNum, ci('pay_confirmed')+1).setValue('TRUE');
        }
        s.getRange(rowNum, ci('arrived')+1).setValue('TRUE');
        s.getRange(rowNum, ci('arrived_at')+1).setValue(now);
        SpreadsheetApp.flush();

        // VIPテーブル判定
        var vipInfo = null;
        if (String(body.guest_id).indexOf('VIP-') === 0) {
          var vtsCI = sheet('vip_tables');
          if (vtsCI) {
            var vtCIRows = vtsCI.getRange(1,1,vtsCI.getLastRow(),vtsCI.getLastColumn()).getValues();
            var vtCIH = vtCIRows[0].map(function(c){ return String(c).trim(); });
            var gidCIIdx = vtCIH.indexOf('guest_id');
            var capCIIdx = vtCIH.indexOf('capacity');
            var cntCIIdx = vtCIH.indexOf('checked_count');
            var tnCIIdx  = vtCIH.indexOf('table_name');
            var ttCIIdx  = vtCIH.indexOf('table_type');
            for (var vi=1; vi<vtCIRows.length; vi++) {
              if (String(vtCIRows[vi][gidCIIdx]) === guestId) {
                var capCI  = Number(vtCIRows[vi][capCIIdx] || 0);
                var cntCI  = Number(vtCIRows[vi][cntCIIdx] || 0) + 1;
                // checked_count列がなければ追加
                if (cntCIIdx < 0) {
                  vtsCI.getRange(1, vtsCI.getLastColumn()+1).setValue('checked_count');
                  cntCIIdx = vtsCI.getLastColumn() - 1;
                  SpreadsheetApp.flush();
                }
                vtsCI.getRange(vi+1, cntCIIdx+1).setValue(cntCI);
                SpreadsheetApp.flush();
                vipInfo = {
                  table_name:    String(vtCIRows[vi][tnCIIdx] || ''),
                  table_type:    String(vtCIRows[vi][ttCIIdx] || ''),
                  capacity:      capCI,
                  checked_count: cntCI,
                  is_over:       capCI > 0 && cntCI > capCI
                };
                break;
              }
            }
          }
        }

        return res({
          ok: true, status: 'checked_in',
          name: gName, gender: gGender, invited_by: gInvBy,
          pay_type: gPayType, amount: gAmount,
          payment_method: payMethod || gPayMeth,
          vip_info: vipInfo
        });
      }

      case 'sendQREmail': {
        var guest_id    = body.guest_id    || '';
        var email       = body.email       || '';
        var name        = body.name        || '';
        var pay_type    = body.pay_type    || '';
        var amount      = body.amount      || 0;
        var event_name  = body.event_name  || '';
        var description = body.description || '';
        if (!email || !guest_id) return res({ ok: false, message: '\u30d1\u30e9\u30e1\u30fc\u30bf\u4e0d\u8db3' });
        var descForEmail = removeEmoji(description);
        var payLabel     = pay_type === 'free' ? '\u7121\u6599\u62db\u5f85' : '\u6709\u6599 \u00a5' + Number(amount).toLocaleString();
        var subject      = '\u300cLUXE PARTY TOKYO\u300d\u3054\u767b\u9332\u5b8c\u4e86 \u2014 \u5165\u5834QR\u30b3\u30fc\u30c9';
        var qrPageUrl    = 'https://luxepartycom.github.io/event-system/qr.html?id=' + encodeURIComponent(guest_id);
        var eventRow = event_name
          ? '<div style="margin-bottom:6px;">\u30a4\u30d9\u30f3\u30c8: <strong style="color:#F5F0E8;">' + event_name + '</strong></div>'
          : '';
        var descRow = descForEmail
          ? '<div style="margin-top:10px;padding-top:10px;border-top:1px solid rgba(255,255,255,0.08);font-size:0.72rem;color:#aaa;line-height:1.9;white-space:pre-wrap;">' + linkifyText(descForEmail) + '</div>'
          : '';
        var html = '<div style="background:#080808;padding:40px 20px;font-family:sans-serif;color:#F5F0E8;max-width:480px;margin:0 auto;">'
          + '<div style="font-size:1.4rem;color:#C9A84C;letter-spacing:0.3em;margin-bottom:4px;">LUXE PARTY TOKYO</div>'
          + '<div style="font-size:0.7rem;color:#888;letter-spacing:0.2em;margin-bottom:32px;">INVITATION</div>'
          + '<p style="margin-bottom:8px;font-size:0.9rem;">' + name + ' \u69d8</p>'
          + '<p style="color:#888;font-size:0.8rem;line-height:1.8;margin-bottom:24px;">\u3054\u767b\u9332\u3042\u308a\u304c\u3068\u3046\u3054\u3056\u3044\u307e\u3059\u3002<br>\u5f53\u65e5\u306f\u4e0b\u8a18\u30dc\u30bf\u30f3\u304b\u3089QR\u30b3\u30fc\u30c9\u3092\u8868\u793a\u3057\u3066\u30b9\u30bf\u30c3\u30d5\u306b\u3054\u63d0\u793a\u304f\u3060\u3055\u3044\u3002</p>'
          + '<div style="background:#111;border:1px solid rgba(201,168,76,0.2);padding:24px;text-align:center;margin-bottom:20px;">'
          +   '<div style="font-size:0.5rem;letter-spacing:0.3em;color:#888;text-transform:uppercase;margin-bottom:10px;">GUEST ID</div>'
          +   '<div style="font-size:1.4rem;color:#C9A84C;letter-spacing:0.15em;font-family:monospace;margin-bottom:20px;">' + guest_id + '</div>'
          +   '<a href="' + qrPageUrl + '" style="display:inline-block;background:#C9A84C;color:#000;text-decoration:none;padding:16px 36px;font-size:0.7rem;font-weight:700;letter-spacing:0.2em;text-transform:uppercase;">&#9654; QR\u30b3\u30fc\u30c9\u3092\u8868\u793a\u3059\u308b</a>'
          +   '<div style="font-size:0.55rem;color:#666;margin-top:12px;">\u30bf\u30c3\u30d7\u3059\u308b\u3068QR\u30b3\u30fc\u30c9\u304c\u8868\u793a\u3055\u308c\u307e\u3059</div>'
          + '</div>'
          + '<div style="background:#111;border:1px solid rgba(255,255,255,0.06);padding:14px 20px;margin-bottom:24px;font-size:0.75rem;color:#aaa;">'
          +   eventRow + '<div>\u7a2e\u5225: <strong style="color:#F5F0E8;">' + payLabel + '</strong></div>' + descRow
          + '</div>'
          + '<p style="font-size:0.6rem;color:#444;line-height:1.8;">\u203b \u3053\u306e\u30e1\u30fc\u30eb\u306f\u30b7\u30b9\u30c6\u30e0\u304b\u3089\u81ea\u52d5\u9001\u4fe1\u3055\u308c\u3066\u3044\u307e\u3059\u3002<br>\u203b URL\u304c\u958b\u3051\u306a\u3044\u5834\u5408\u306f\u7533\u3057\u8fbc\u307f\u5b8c\u4e86\u753b\u9762\u306e\u30b9\u30af\u30ea\u30fc\u30f3\u30b7\u30e7\u30c3\u30c8\u3092\u30b9\u30bf\u30c3\u30d5\u306b\u3054\u63d0\u793a\u304f\u3060\u3055\u3044\u3002</p>'
          + '</div>';
        try {
          GmailApp.sendEmail(email, subject, name + '\u69d8\u3001QR: ' + qrPageUrl, { htmlBody: html, name: 'LUXE PARTY TOKYO' });
          return res({ ok: true });
        } catch(mailErr) { return res({ ok: false, message: mailErr.message }); }
      }

      case 'savePromoUrl': {
        var pu = sheet('promoter_urls');
        if (!pu) {
          pu = SS.insertSheet('promoter_urls');
          pu.appendRow(['event_id','promoter','type','plan_id','created_at']);
        } else {
          // plan_id列がなければ追加
          var puH0 = pu.getRange(1,1,1,pu.getLastColumn()).getValues()[0].map(function(h){ return String(h).trim(); });
          if (puH0.indexOf('plan_id') < 0) {
            pu.getRange(1, pu.getLastColumn()+1).setValue('plan_id');
            SpreadsheetApp.flush();
          }
        }
        var puRows = pu.getRange(1,1,pu.getLastRow(),pu.getLastColumn()).getValues();
        var puH    = puRows[0].map(function(h){ return String(h).trim(); });
        var puEvIdx = puH.indexOf('event_id');
        var puPrIdx = puH.indexOf('promoter');
        var puTyIdx = puH.indexOf('type');
        var puPlIdx = puH.indexOf('plan_id');
        var bodyPlanId = body.plan_id || '';

        // 同じevent_id+promoter+type+plan_idの組み合わせで重複チェック
        for (var i=1; i<puRows.length; i++) {
          if (String(puRows[i][puEvIdx]) === String(body.event_id) &&
              String(puRows[i][puPrIdx]) === String(body.promoter) &&
              String(puRows[i][puTyIdx]) === String(body.type) &&
              String(puRows[i][puPlIdx] || '') === String(bodyPlanId))
            return res({ ok: true, message: 'already_exists' });
        }

        // 新規追加
        var newRow = [];
        for (var ci=0; ci<puH.length; ci++) newRow.push('');
        if (puEvIdx >= 0) newRow[puEvIdx] = body.event_id;
        if (puPrIdx >= 0) newRow[puPrIdx] = body.promoter;
        if (puTyIdx >= 0) newRow[puTyIdx] = body.type;
        if (puPlIdx >= 0) newRow[puPlIdx] = bodyPlanId;
        newRow[puH.indexOf('created_at') >= 0 ? puH.indexOf('created_at') : puH.length-1] = nowStr();
        pu.appendRow(newRow);
        SpreadsheetApp.flush();
        return res({ ok: true });
      }

      case 'deletePromoUrl': {
        var pu2 = sheet('promoter_urls');
        if (!pu2) return res({ ok: true });
        var pu2Rows = pu2.getDataRange().getValues();
        var pu2H    = pu2Rows[0].map(function(h){ return String(h).trim(); });
        for (var i=pu2Rows.length-1; i>=1; i--) {
          if (String(pu2Rows[i][pu2H.indexOf('event_id')]) === String(body.event_id) &&
              String(pu2Rows[i][pu2H.indexOf('promoter')]) === String(body.promoter) &&
              String(pu2Rows[i][pu2H.indexOf('type')])     === String(body.type)) {
            pu2.deleteRow(i+1); SpreadsheetApp.flush(); return res({ ok: true });
          }
        }
        return res({ ok: false, message: '\u8a72\u5f53\u30c7\u30fc\u30bf\u304c\u898b\u3064\u304b\u308a\u307e\u305b\u3093' });
      }

      case 'savePromoGroups': {
        var pgSheet = sheet('promo_groups');
        if (!pgSheet) {
          pgSheet = SS.insertSheet('promo_groups');
          pgSheet.appendRow(['event_id', 'group_json', 'updated_at']);
        }
        var pgAllRows = pgSheet.getDataRange().getValues();
        for (var i = pgAllRows.length - 1; i >= 1; i--) {
          if (String(pgAllRows[i][0]) === String(body.event_id)) pgSheet.deleteRow(i + 1);
        }
        var grps = body.groups || [];
        grps.forEach(function(g) {
          pgSheet.appendRow([body.event_id, JSON.stringify(g), nowStr()]);
        });
        SpreadsheetApp.flush();
        return res({ ok: true });
      }

      case 'exportPromoReport': {
        var reportName = 'report_' + (body.event_name || body.event_id).substring(0, 18);
        var existing = SS.getSheetByName(reportName);
        if (existing) SS.deleteSheet(existing);
        var rSheet = SS.insertSheet(reportName);
        rSheet.appendRow([
          'プロモーター',
          '招待計',
          '有料男招待', '有料女招待', '無料男招待', '無料女招待',
          '来場計', '来場率(%)',
          '有料男来場', '有料女来場', '無料男来場', '無料女来場',
          '現金', 'カード', 'PayPay'
        ]);
        var exportRows = body.rows || [];
        var tot = [0,0,0,0,0,0,0,0,0,0,0,0];
        var tot = [0,0,0,0,0,0,0,0,0,0,0,0,0,0];
        exportRows.forEach(function(r) {
          var rate = r.total ? Math.round(r.arrived / r.total * 100) : 0;
          // 有料男招待/女招待/無料男招待/女招待
          var paidM  = Number(r.paidMTotal  || 0);
          var paidF  = Number(r.paidFTotal  || 0);
          var freeM  = Number(r.freeMTotal  || 0);
          var freeF  = Number(r.freeFTotal  || 0);
          // 有料男来場/女来場/無料男来場/女来場
          var paidMA = Number(r.paidMArrived || 0);
          var paidFA = Number(r.paidFArrived || 0);
          var freeMA = Number(r.freeMArrived || 0);
          var freeFA = Number(r.freeFArrived || 0);
          rSheet.appendRow([
            r.name,
            r.total,
            paidM, paidF, freeM, freeF,
            r.arrived, rate,
            paidMA, paidFA, freeMA, freeFA,
            r.cash, r.card, r.paypay
          ]);
          var vals = [r.total, paidM, paidF, freeM, freeF, r.arrived, 0, paidMA, paidFA, freeMA, freeFA, r.cash, r.card, r.paypay];
          vals.forEach(function(v,i){ tot[i]+=(Number(v)||0); });
        });
        var tRate = tot[0] ? Math.round(tot[5]/tot[0]*100) : 0;
        rSheet.appendRow([
          '合計',
          tot[0],
          tot[1], tot[2], tot[3], tot[4],
          tot[5], tRate,
          tot[7], tot[8], tot[9], tot[10],
          tot[11], tot[12], tot[13]
        ]);
        var lastRow = exportRows.length + 2;
        var colCount = 15;
        rSheet.getRange(1,1,1,colCount).setFontWeight('bold').setBackground('#C9A84C').setFontColor('#000000');
        rSheet.getRange(lastRow,1,1,colCount).setFontWeight('bold').setBackground('#222222').setFontColor('#C9A84C');
        rSheet.setFrozenRows(1);
        rSheet.autoResizeColumns(1,colCount);

        // ── 詳細シート ──
        var detailName = 'detail_' + (body.event_name || body.event_id).substring(0, 18);
        var existingD = SS.getSheetByName(detailName);
        if (existingD) SS.deleteSheet(existingD);
        var dSheet = SS.insertSheet(detailName);
        dSheet.appendRow(['\u30d7\u30ed\u30e2\u30fc\u30bf\u30fc','\u30b2\u30b9\u30c8\u540d','\u6027\u5225','\u7a2e\u5225','\u6765\u5834','\u652f\u6255\u65b9\u6cd5','\u91d1\u984d','\u767b\u9332\u65e5\u6642']);
        var detailRows = body.detailRows || [];
        detailRows.forEach(function(r) {
          dSheet.appendRow([r.promoter, r.name,
            r.gender === 'female' ? '\u5973' : '\u7537',
            r.pay_type === 'free' ? '\u7121\u6599' : '\u6709\u6599',
            r.arrived ? '\u2713' : '\u2014',
            r.payment_method || '\u2014',
            r.amount > 0 ? r.amount : '\u2014',
            r.registered_at || '']);
        });
        dSheet.getRange(1,1,1,8).setFontWeight('bold').setBackground('#C9A84C').setFontColor('#000000');
        if (detailRows.length > 0) {
          var curPromo = '', colorIdx = 0;
          for (var di = 0; di < detailRows.length; di++) {
            if (detailRows[di].promoter !== curPromo) { curPromo = detailRows[di].promoter; colorIdx++; }
            dSheet.getRange(di+2,1,1,8).setBackground(colorIdx%2===0?'#1a1a1a':'#222222');
          }
        }
        dSheet.setFrozenRows(1);
        dSheet.autoResizeColumns(1,8);
        SpreadsheetApp.flush();
        return res({ ok: true, sheet_name: reportName, detail_sheet_name: detailName });
      }

      case 'aiGroupNames': {
        var names = body.names || [];
        if (!names.length) return res({ ok: false, message: '\u540d\u524d\u30ea\u30b9\u30c8\u304c\u7a7a\u3067\u3059' });
        var prompt = '\u4ee5\u4e0b\u306f\u62db\u5f85\u5236\u30d1\u30fc\u30c6\u30a3\u30fc\u306e\u300c\u62db\u5f85\u8005\u540d\uff08\u30d7\u30ed\u30e2\u30fc\u30bf\u30fc\u540d\uff09\u300d\u306e\u4e00\u89a7\u3067\u3059\u3002'
          + '\u540c\u4e00\u4eba\u7269\u3068\u601d\u308f\u308c\u308b\u540d\u524d\u3092\u65e5\u672c\u8a9e\u306e\u8868\u8a18\u3086\u308c\uff08\u6f22\u5b57\u30fb\u3072\u3089\u304c\u306a\u30fb\u30ab\u30bf\u30ab\u30ca\u30fb\u7565\u79f0\u30fb\u6557\u79f0\u306a\u3069\uff09\u3092\u8003\u616e\u3057\u3066\u30b0\u30eb\u30fc\u30d4\u30f3\u30b0\u3057\u3066\u304f\u3060\u3055\u3044\u3002\n\n'
          + '\u540d\u524d\u30ea\u30b9\u30c8:\n'
          + names.map(function(n,i){ return (i+1)+'. '+n; }).join('\n')
          + '\n\n\u4ee5\u4e0b\u306eJSON\u5f62\u5f0f\u306e\u307f\u3067\u56de\u7b54\u3057\u3066\u304f\u3060\u3055\u3044\uff08\u8aac\u660e\u4e0d\u8981\uff09:\n'
          + '[{"canonical":"\u6b63\u898f\u306e\u8868\u8a18","aliases":["\u540d\u524d1","\u540d\u524d2"]},...]\n\n'
          + '\u30eb\u30fc\u30eb:\n- \u660e\u3089\u304b\u306b\u540c\u4e00\u4eba\u7269\u3067\u306a\u3044\u5834\u5408\u306f1\u540d1\u30b0\u30eb\u30fc\u30d7\n'
          + '- canonical\u306f\u6700\u3082\u6b63\u5f0f\u30fb\u8aad\u307f\u3084\u3059\u3044\u8868\u8a18\n'
          + '- aliases\u306b\u306fcanonical\u3068\u540c\u3058\u540d\u524d\u3082\u542b\u3081\u308b\n'
          + '- \u5168\u3066\u306e\u540d\u524d\u3092\u3044\u305a\u308c\u304b\u306e\u30b0\u30eb\u30fc\u30d7\u306b\u542b\u3081\u308b';
        try {
          var apiRes = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
            method: 'post', contentType: 'application/json',
            headers: {
              'x-api-key': PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY') || '',
              'anthropic-version': '2023-06-01'
            },
            payload: JSON.stringify({
              model: 'claude-haiku-4-5-20251001', max_tokens: 4000,
              messages: [{ role: 'user', content: prompt }]
            }),
            muteHttpExceptions: true
          });
          var apiData = JSON.parse(apiRes.getContentText());
          if (apiData.error) return res({ ok: false, message: 'API\u30a8\u30e9\u30fc: ' + apiData.error.message });
          var raw = (apiData.content && apiData.content[0] && apiData.content[0].text) ? apiData.content[0].text : '[]';
          var cleaned = raw.replace(/```json|```/g, '').trim();
          if (cleaned.charAt(cleaned.length-1) !== ']') {
            var lb = cleaned.lastIndexOf('}');
            if (lb > 0) cleaned = cleaned.substring(0, lb+1) + ']';
          }
          return res({ ok: true, groups: JSON.parse(cleaned) });
        } catch(aiErr) {
          return res({ ok: false, message: 'AI\u30a8\u30e9\u30fc: ' + aiErr.message });
        }
      }


      case 'createCheckoutSession': {
        var stripe_sk = PropertiesService.getScriptProperties().getProperty('STRIPE_SECRET_KEY') || '';
        if (!stripe_sk) return res({ ok: false, message: 'Stripe\u8a2d\u5b9a\u304c\u3042\u308a\u307e\u305b\u3093' });
        var s_event_id   = body.event_id   || '';
        var s_name       = body.name       || '';
        var s_email      = body.email      || '';
        var s_gender     = body.gender     || '';
        var s_invited_by = body.invited_by || '';
        var s_amount     = Number(body.amount || 0);
        var s_event_name = body.event_name || '';
        if (!s_event_id || !s_name || !s_email || s_amount <= 0) return res({ ok: false, message: '\u30d1\u30e9\u30e1\u30fc\u30bf\u4e0d\u8db3' });
        var successUrl = 'https://luxepartycom.github.io/event-system/checkout.html?session_id={CHECKOUT_SESSION_ID}';
        var cancelUrl  = 'https://luxepartycom.github.io/event-system/index.html?e=' + s_event_id + '&type=paid';
        var payload = 'mode=payment'
          + '&payment_method_types[]=card'
          + '&line_items[0][price_data][currency]=jpy'
          + '&line_items[0][price_data][unit_amount]=' + s_amount
          + '&line_items[0][price_data][product_data][name]=' + encodeURIComponent(s_event_name + ' \u5165\u5834\u6599')
          + '&line_items[0][quantity]=1'
          + '&customer_email=' + encodeURIComponent(s_email)
          + '&success_url=' + encodeURIComponent(successUrl)
          + '&cancel_url=' + encodeURIComponent(cancelUrl)
          + '&metadata[event_id]=' + encodeURIComponent(s_event_id)
          + '&metadata[name]=' + encodeURIComponent(s_name)
          + '&metadata[email]=' + encodeURIComponent(s_email)
          + '&metadata[gender]=' + encodeURIComponent(s_gender)
          + '&metadata[invited_by]=' + encodeURIComponent(s_invited_by)
          + '&metadata[amount]=' + s_amount;
        try {
          var stripeRes = UrlFetchApp.fetch('https://api.stripe.com/v1/checkout/sessions', {
            method: 'post',
            headers: { 'Authorization': 'Basic ' + Utilities.base64Encode(stripe_sk + ':') },
            payload: payload,
            muteHttpExceptions: true
          });
          var stripeData = JSON.parse(stripeRes.getContentText());
          if (stripeData.error) return res({ ok: false, message: 'Stripe: ' + stripeData.error.message });
          return res({ ok: true, checkout_url: stripeData.url, session_id: stripeData.id });
        } catch(e) { return res({ ok: false, message: 'Stripe\u63a5\u7d9a\u30a8\u30e9\u30fc: ' + e.message }); }
      }

      case 'completeStripePayment': {
        var stripe_sk2  = PropertiesService.getScriptProperties().getProperty('STRIPE_SECRET_KEY') || '';
        var session_id  = body.session_id || '';
        if (!stripe_sk2 || !session_id) return res({ ok: false, message: '\u30d1\u30e9\u30e1\u30fc\u30bf\u4e0d\u8db3' });
        // 重複登録チェック
        var gSheet2 = sheet('guests');
        if (!gSheet2) return res({ ok: false, message: 'guests\u30b7\u30fc\u30c8\u304c\u3042\u308a\u307e\u305b\u3093' });
        var gRows2  = gSheet2.getDataRange().getValues();
        var gH2     = gRows2[0].map(function(h){ return String(h).trim(); });
        var sidIdx2 = gH2.indexOf('stripe_session_id');
        if (sidIdx2 >= 0) {
          for (var i2 = 1; i2 < gRows2.length; i2++) {
            if (String(gRows2[i2][sidIdx2]) === String(session_id)) {
              var gidIdx2 = gH2.indexOf('guest_id');
              return res({ ok: true, already_registered: true, guest_id: String(gRows2[i2][gidIdx2]) });
            }
          }
        }
        try {
          var sessRes  = UrlFetchApp.fetch('https://api.stripe.com/v1/checkout/sessions/' + session_id, {
            headers: { 'Authorization': 'Basic ' + Utilities.base64Encode(stripe_sk2 + ':') },
            muteHttpExceptions: true
          });
          var sessData = JSON.parse(sessRes.getContentText());
          if (sessData.error) return res({ ok: false, message: 'Stripe: ' + sessData.error.message });
          if (sessData.payment_status !== 'paid') return res({ ok: false, message: '\u6c7a\u6e08\u304c\u5b8c\u4e86\u3057\u3066\u3044\u307e\u305b\u3093' });
          var meta2     = sessData.metadata || {};
          var new_gid   = 'G-' + Date.now().toString(36).toUpperCase();
          var ev2_id    = meta2.event_id   || '';
          var g2_name   = meta2.name       || '';
          // metadataにemailがない場合はcustomer_emailを使用
          var g2_email  = meta2.email || sessData.customer_email || '';
          var g2_gender = meta2.gender     || '';
          var g2_inv    = meta2.invited_by || '';
          var g2_amount = Number(meta2.amount || 0);
          // stripe_session_id列を確認・追加
          var headers2 = gSheet2.getRange(1, 1, 1, gSheet2.getLastColumn()).getValues()[0].map(function(h){ return String(h).trim(); });
          var sColIdx = headers2.indexOf('stripe_session_id');
          if (sColIdx < 0) {
            sColIdx = headers2.length;
            gSheet2.getRange(1, sColIdx + 1).setValue('stripe_session_id');
            SpreadsheetApp.flush();
          }
          // ゲスト登録（pay_confirmed=TRUE, payment_method=stripe）
          var newRow2 = [];
          var hMap2   = {};
          headers2.forEach(function(h, i){ hMap2[h] = i; });
          var colCount2 = Math.max(sColIdx + 1, 15);
          for (var ci = 0; ci < colCount2; ci++) newRow2.push('');
          if (hMap2['guest_id']       !== undefined) newRow2[hMap2['guest_id']]       = new_gid;
          if (hMap2['event_id']       !== undefined) newRow2[hMap2['event_id']]       = ev2_id;
          if (hMap2['name']           !== undefined) newRow2[hMap2['name']]           = g2_name;
          if (hMap2['email']          !== undefined) newRow2[hMap2['email']]          = g2_email;
          if (hMap2['gender']         !== undefined) newRow2[hMap2['gender']]         = g2_gender;
          if (hMap2['invited_by']     !== undefined) newRow2[hMap2['invited_by']]     = g2_inv;
          if (hMap2['pay_type']       !== undefined) newRow2[hMap2['pay_type']]       = 'paid';
          if (hMap2['amount']         !== undefined) newRow2[hMap2['amount']]         = g2_amount;
          if (hMap2['pay_confirmed']  !== undefined) newRow2[hMap2['pay_confirmed']]  = 'TRUE';
          if (hMap2['arrived']        !== undefined) newRow2[hMap2['arrived']]        = 'FALSE';
          if (hMap2['registered_at']  !== undefined) newRow2[hMap2['registered_at']]  = nowStr();
          if (hMap2['payment_method'] !== undefined) newRow2[hMap2['payment_method']] = 'stripe';
          if (hMap2['reminder_sent']  !== undefined) newRow2[hMap2['reminder_sent']]  = 'FALSE';
          newRow2[sColIdx] = session_id;
          gSheet2.appendRow(newRow2);
          SpreadsheetApp.flush();
          // イベント情報取得してQRメール送信
          var evList2  = sheetToObjects(sheet('events'));
          var ev2      = evList2.find(function(e){ return String(e.event_id) === String(ev2_id); });
          var ev2_name = ev2 ? ev2.name : '';
          var ev2_desc = ev2 ? (ev2.description || '') : '';
          // プラン申込数を+1（Stripe決済完了時）
          var planId2 = meta2.plan_id || '';
          var gender2 = meta2.gender  || '';
          if (planId2) {
            var ps9 = sheet('event_plans');
            if (ps9) {
              var ps9Rows  = ps9.getRange(1,1,ps9.getLastRow(),ps9.getLastColumn()).getValues();
              var ps9H     = ps9Rows[0].map(function(h){ return String(h).trim(); });
              var pidIdx9  = ps9H.indexOf('plan_id');
              var cntIdx9  = ps9H.indexOf('current_count');
              var capIdx9  = ps9H.indexOf('capacity');
              var stIdx9   = ps9H.indexOf('status');
              var cmIdx9   = ps9H.indexOf('capacity_male');
              var cfIdx9   = ps9H.indexOf('capacity_female');
              var cntMIdx9 = ps9H.indexOf('count_male');
              var cntFIdx9 = ps9H.indexOf('count_female');
              for (var pi=1; pi<ps9Rows.length; pi++) {
                if (String(ps9Rows[pi][pidIdx9]) !== planId2) continue;
                var newCnt9 = Number(ps9Rows[pi][cntIdx9]||0) + 1;
                ps9.getRange(pi+1, cntIdx9+1).setValue(newCnt9);
                if (gender2 === 'male' && cntMIdx9 >= 0) {
                  var newM9 = Number(ps9Rows[pi][cntMIdx9]||0) + 1;
                  ps9.getRange(pi+1, cntMIdx9+1).setValue(newM9);
                  var capM9 = cmIdx9 >= 0 ? Number(ps9Rows[pi][cmIdx9]||0) : 0;
                  if (capM9 > 0 && newM9 >= capM9) ps9.getRange(pi+1, stIdx9+1).setValue('full');
                } else if (gender2 === 'female' && cntFIdx9 >= 0) {
                  var newF9 = Number(ps9Rows[pi][cntFIdx9]||0) + 1;
                  ps9.getRange(pi+1, cntFIdx9+1).setValue(newF9);
                  var capF9 = cfIdx9 >= 0 ? Number(ps9Rows[pi][cfIdx9]||0) : 0;
                  if (capF9 > 0 && newF9 >= capF9) ps9.getRange(pi+1, stIdx9+1).setValue('full');
                }
                var cap9 = Number(ps9Rows[pi][capIdx9]||0);
                if (cap9 > 0 && newCnt9 >= cap9) ps9.getRange(pi+1, stIdx9+1).setValue('full');
                SpreadsheetApp.flush();
                break;
              }
            }
          }

          try {
            // メール送信前の検証ログ
            console.log('QRメール送信開始: to=' + g2_email + ' guest=' + new_gid);
            if (!g2_email) throw new Error('メールアドレスが空です');
            var d2Email   = removeEmoji(ev2_desc);
            var qrUrl2    = 'https://luxepartycom.github.io/event-system/qr.html?id=' + encodeURIComponent(new_gid);
            var subj2     = '\u300cLUXE PARTY TOKYO\u300d\u3054\u767b\u9332\u5b8c\u4e86 \u2014 \u5165\u5834QR\u30b3\u30fc\u30c9';
            var evRow2    = ev2_name ? '<div style="margin-bottom:6px;">\u30a4\u30d9\u30f3\u30c8: <strong style="color:#F5F0E8;">' + ev2_name + '</strong></div>' : '';
            var descRow2  = d2Email  ? '<div style="margin-top:10px;padding-top:10px;border-top:1px solid rgba(255,255,255,0.08);font-size:0.72rem;color:#aaa;line-height:1.9;white-space:pre-wrap;">' + linkifyText(d2Email) + '</div>' : '';
            var badge2    = '<div style="background:rgba(106,171,255,0.08);border:1px solid rgba(106,171,255,0.3);padding:10px 14px;margin-bottom:14px;font-size:0.62rem;color:#6AABFF;">\u2705 \u30ab\u30fc\u30c9\u6c7a\u6e08\u5b8c\u4e86\u3002\u5f53\u65e5\u306f\u3053\u306eQR\u3092\u30b9\u30bf\u30c3\u30d5\u306b\u304a\u898b\u305b\u3059\u308b\u3060\u3051\u3067\u5165\u5834\u3067\u304d\u307e\u3059\u3002</div>';
            var html2 = '<div style="background:#080808;padding:40px 20px;font-family:sans-serif;color:#F5F0E8;max-width:480px;margin:0 auto;">'
              + '<div style="font-size:1.4rem;color:#C9A84C;letter-spacing:0.3em;margin-bottom:4px;">LUXE PARTY TOKYO</div>'
              + '<div style="font-size:0.7rem;color:#888;letter-spacing:0.2em;margin-bottom:32px;">INVITATION</div>'
              + '<p style="margin-bottom:8px;font-size:0.9rem;">' + g2_name + ' \u69d8</p>'
              + '<p style="color:#888;font-size:0.8rem;line-height:1.8;margin-bottom:20px;">\u3054\u767b\u9332\u304a\u3088\u3073\u304a\u652f\u6255\u3044\u3042\u308a\u304c\u3068\u3046\u3054\u3056\u3044\u307e\u3059\u3002<br>\u5f53\u65e5\u306f\u4e0b\u8a18QR\u3092\u30b9\u30bf\u30c3\u30d5\u306b\u304a\u898b\u305b\u304f\u3060\u3055\u3044\u3002</p>'
              + badge2
              + '<div style="background:#111;border:1px solid rgba(201,168,76,0.2);padding:24px;text-align:center;margin-bottom:20px;">'
              + '<div style="font-size:0.5rem;letter-spacing:0.3em;color:#888;text-transform:uppercase;margin-bottom:10px;">GUEST ID</div>'
              + '<div style="font-size:1.4rem;color:#C9A84C;letter-spacing:0.15em;font-family:monospace;margin-bottom:20px;">' + new_gid + '</div>'
              + '<a href="' + qrUrl2 + '" style="display:inline-block;background:#C9A84C;color:#000;text-decoration:none;padding:16px 36px;font-size:0.7rem;font-weight:700;letter-spacing:0.2em;text-transform:uppercase;">&#9654; QR\u30b3\u30fc\u30c9\u3092\u8868\u793a\u3059\u308b</a>'
              + '</div>'
              + '<div style="background:#111;border:1px solid rgba(255,255,255,0.06);padding:14px 20px;margin-bottom:24px;font-size:0.75rem;color:#aaa;">'
              + evRow2 + '<div>\u7a2e\u5225: <strong style="color:#F5F0E8;">\u4e8b\u524d\u6c7a\u6e08\u6e08\u307f \u00a5' + g2_amount.toLocaleString() + '</strong></div>' + descRow2
              + '</div>'
              + '<p style="font-size:0.6rem;color:#444;line-height:1.8;">\u203b \u3053\u306e\u30e1\u30fc\u30eb\u306f\u30b7\u30b9\u30c6\u30e0\u304b\u3089\u81ea\u52d5\u9001\u4fe1\u3055\u308c\u3066\u3044\u307e\u3059\u3002</p>'
              + '</div>';
            GmailApp.sendEmail(g2_email, subj2, g2_name + '\u69d8\u3001QR: ' + qrUrl2, { htmlBody: html2, name: 'LUXE PARTY TOKYO' });
          } catch(mailErr2) { console.error('QRメール送信失敗: ' + mailErr2.message + ' / to=' + g2_email + ' / guest=' + new_gid); }
          return res({ ok: true, guest_id: new_gid, name: g2_name, amount: g2_amount, event_name: ev2_name });
        } catch(e2) { return res({ ok: false, message: 'Stripe\u53d6\u5f97\u30a8\u30e9\u30fc: ' + e2.message }); }
      }

      case 'archiveEvent': {
        var archEventId = body.event_id || '';
        if (!archEventId) return res({ ok: false, message: 'event_idが必要です' });

        var srcSheet = sheet('guests');
        if (!srcSheet) return res({ ok: false, message: 'guestsシートがありません' });

        var srcRows    = srcSheet.getDataRange().getValues();
        var srcHeaders = srcRows[0].map(function(h){ return String(h).trim(); });
        var evColIdx   = srcHeaders.indexOf('event_id');

        // 対象行と非対象行に分類
        var toArchive = [];
        var toKeep    = [];
        for (var i = 1; i < srcRows.length; i++) {
          if (!srcRows[i][0]) continue;
          if (String(srcRows[i][evColIdx]) === String(archEventId)) {
            toArchive.push(srcRows[i]);
          } else {
            toKeep.push(srcRows[i]);
          }
        }
        if (toArchive.length === 0) {
          return res({ ok: false, message: '該当するゲストがいません' });
        }

        // guests_archive シートを確認・作成
        var archSheet = sheet('guests_archive');
        if (!archSheet) {
          archSheet = SS.insertSheet('guests_archive');
          archSheet.appendRow(srcRows[0]);
        }

        // 「一括書き込み」アーカイブ先に全行まとめて追記
        archSheet.getRange(
          archSheet.getLastRow() + 1, 1,
          toArchive.length, srcRows[0].length
        ).setValues(toArchive);

        // 「一括書き込み」guestsシートをヘッダー+残行で丸ごと書き直し
        srcSheet.clearContents();
        srcSheet.getRange(1, 1, 1, srcHeaders.length).setValues([srcRows[0]]);
        if (toKeep.length > 0) {
          srcSheet.getRange(2, 1, toKeep.length, srcRows[0].length).setValues(toKeep);
        }

        SpreadsheetApp.flush();
        return res({ ok: true, archived_count: toArchive.length });
      }


      case 'getMailList': {
        var scope         = body.scope          || 'latest';
        var excludeLatest = body.exclude_latest || false;

        // guests_archiveから全ゲスト取得
        function getArchiveGuests() {
          var s = sheet('guests_archive');
          if (!s) return [];
          var lastRow = s.getLastRow();
          var lastCol = s.getLastColumn();
          if (lastRow < 2) return [];
          var rows = s.getRange(1, 1, lastRow, lastCol).getValues();
          var headers = rows[0].map(function(h){ return String(h).trim(); });
          // メール配信に必要な列のみ取得
          var MAIL_COLS = ['guest_id','event_id','name','email','pay_type','registered_at'];
          var colMap = {};
          MAIL_COLS.forEach(function(f){ colMap[f] = headers.indexOf(f); });
          var result = [];
          for (var i = 1; i < rows.length; i++) {
            if (!rows[i][0]) continue;
            var obj = {};
            headers.forEach(function(h, j){ obj[h] = rows[i][j] || ''; });
            result.push(obj);
          }
          return result;
        }

        var allGuests = getArchiveGuests();

        // guestsシートも含める
        var gsObjs = sheetToObjects(sheet('guests'));
        allGuests = allGuests.concat(gsObjs);

        // 最新イベントIDを取得
        // eventsシートとguests全体から最新のevent_idを判定
        var evRows = sheetToObjects(sheet('events'));
        evRows.sort(function(a, b){
          return String(b.date).substring(0,10).localeCompare(String(a.date).substring(0,10));
        });
        var latestEventId = evRows.length > 0 ? String(evRows[0].event_id) : '';

        // eventsシートに最新がない場合はguests内のevent_idから判定
        if (!latestEventId && allGuests.length > 0) {
          var eventDates = {};
          allGuests.forEach(function(g) {
            if (g.event_id && g.registered_at) {
              eventDates[String(g.event_id)] = String(g.registered_at);
            }
          });
          var sortedIds = Object.keys(eventDates).sort(function(a, b){
            return eventDates[b].localeCompare(eventDates[a]);
          });
          latestEventId = sortedIds.length > 0 ? sortedIds[0] : '';
        }

        // 配信停止リストを取得
        var unsubSheet = sheet('unsubscribe');
        var unsubEmails = {};
        if (unsubSheet) {
          var unsubRows = unsubSheet.getDataRange().getValues();
          for (var i = 1; i < unsubRows.length; i++) {
            if (unsubRows[i][0]) unsubEmails[String(unsubRows[i][0]).toLowerCase()] = true;
          }
        }

        // スコープでフィルタ
        var filtered = allGuests.filter(function(g) {
          if (!g.email) return false;
          if (unsubEmails[String(g.email).toLowerCase()]) return false;
          if (scope === 'latest') return String(g.event_id) === String(latestEventId);
          if (excludeLatest && String(g.event_id) === String(latestEventId)) return false;
          return true;
        });

        // メールアドレスで重複除去（最新登録を優先）
        var seen = {};
        var unique = [];
        filtered.reverse().forEach(function(g) {
          var email = String(g.email).toLowerCase();
          if (!seen[email]) { seen[email] = true; unique.push(g); }
        });

        return res({ ok: true, guests: unique });
      }

      case 'sendMailMag': {
        var guestsFree  = body.guests_free  || [];
        var guestsPaid  = body.guests_paid  || [];
        var dataFree    = body.data_free    || {};
        var dataPaid    = body.data_paid    || {};
        var dailyLimit  = body.daily_limit  || 100;
        var campaignId  = body.campaign_id  || '';
        var replyTo     = PropertiesService.getScriptProperties().getProperty('MAIL_REPLY_TO') || '';

        // 送信済みメールアドレスをmail_logsから取得
        // typeごとに送信済みを管理
        var sentEmailsFree = {};
        var sentEmailsPaid = {};
        if (campaignId) {
          var logSheet2 = sheet('mail_logs');
          if (logSheet2) {
            var logRows2 = logSheet2.getDataRange().getValues();
            var logH2    = logRows2[0].map(function(h){ return String(h).trim(); });
            var cidIdx   = logH2.indexOf('campaign_id');
            var emailIdx2 = logH2.indexOf('email');
            var statusIdx = logH2.indexOf('status');
            var typeIdx2  = logH2.indexOf('type');
            if (cidIdx >= 0) {
              for (var i = 1; i < logRows2.length; i++) {
                if (String(logRows2[i][cidIdx]) === campaignId &&
                    String(logRows2[i][statusIdx]) === 'sent') {
                  var logEmail = String(logRows2[i][emailIdx2]).toLowerCase();
                  var logType  = String(logRows2[i][typeIdx2]);
                  if (logType === 'free') sentEmailsFree[logEmail] = true;
                  if (logType === 'paid') sentEmailsPaid[logEmail] = true;
                }
              }
            }
          }
        }

        // unsubscribeシートを確認・作成
        var unsubSheet2 = sheet('unsubscribe');
        if (!unsubSheet2) {
          unsubSheet2 = SS.insertSheet('unsubscribe');
          unsubSheet2.appendRow(['email', 'unsubscribed_at']);
        }
        var unsubRows2 = unsubSheet2.getDataRange().getValues();
        var unsubEmails2 = {};
        for (var i = 1; i < unsubRows2.length; i++) {
          if (unsubRows2[i][0]) unsubEmails2[String(unsubRows2[i][0]).toLowerCase()] = true;
        }

        // mail_logsシートを確認・作成
        var logSheet = sheet('mail_logs');
        if (!logSheet) {
          logSheet = SS.insertSheet('mail_logs');
          logSheet.appendRow(['sent_at','campaign_id','type','email','subject','status']);
        }

        var sentFree = 0, sentPaid = 0, unsubCount = 0, totalSent = 0;

        function buildHtml(data, guestName, unsubUrl) {
          var allImgs = [];
          var origUrls = [];
          if (data.image) { var _u0 = String(data.image); allImgs.push(convertDriveUrl(_u0)); origUrls.push(getDriveViewUrl_(_u0)); }
          (data.gallery || []).forEach(function(u) { if (!u) return; var c = convertDriveUrl(String(u)); if (c) { allImgs.push(c); origUrls.push(getDriveViewUrl_(String(u))); } });
          var imagesHtml = '';
          if (allImgs.length > 0) {
            imagesHtml = '<table width="100%" cellpadding="2" cellspacing="0" style="margin:0 0 16px 0;"><tbody>';
            for (var gi = 0; gi < allImgs.length; gi += 2) {
              imagesHtml += '<tr><td width="50%" style="padding:2px;background:#111;"><a href="' + (origUrls[gi]||allImgs[gi]) + '" target="_blank" style="display:block;"><img src="' + allImgs[gi] + '" style="width:100%;display:block;border:0;" alt=""></a></td>';
              imagesHtml += allImgs[gi+1]
                ? '<td width="50%" style="padding:2px;background:#111;"><a href="' + (origUrls[gi+1]||allImgs[gi+1]) + '" target="_blank" style="display:block;"><img src="' + allImgs[gi+1] + '" style="width:100%;display:block;border:0;" alt=""></a></td></tr>'
                : '<td width="50%" style="background:#111;"></td></tr>';
            }
            imagesHtml += '</tbody></table>';
          }
          var bodyHtml = encodeEmojiForHtml(String(data.body || '')).replace(/\n/g, '<br>');
          var ctaRow = data.ctaUrl
            ? '<div style="text-align:center;margin-bottom:28px;"><a href="' + data.ctaUrl + '" style="display:inline-block;background:#C9A84C;color:#000;text-decoration:none;padding:16px 36px;font-size:0.7rem;font-weight:700;letter-spacing:0.2em;">' + (data.ctaText || '詳細はこちら') + '</a></div>'
            : '';
          return '<html><head><meta charset="UTF-8"></head><body>'
            + '<div style="background:#080808;padding:32px 20px;font-family:sans-serif;color:#F5F0E8;max-width:480px;margin:0 auto;">'
            + '<div style="font-size:1.3rem;color:#C9A84C;letter-spacing:0.3em;margin-bottom:4px;">LUXE PARTY TOKYO</div>'
            + '<div style="font-size:0.6rem;color:#888;letter-spacing:0.2em;margin-bottom:28px;">INVITATION</div>'
            + imagesHtml
            + ctaRow
            + '<p style="font-size:0.9rem;margin-bottom:8px;">' + guestName + ' 様</p>'
            + '<p style="font-size:0.78rem;color:#aaa;line-height:1.9;margin-bottom:24px;white-space:pre-wrap;">' + encodeEmojiForHtml(data.greeting || '') + '</p>'
            + '<p style="font-size:0.75rem;color:#ccc;line-height:1.9;margin-bottom:28px;">' + bodyHtml + '</p>'
            + ctaRow
            + '<div style="text-align:center;margin-bottom:24px;font-size:0.6rem;color:#666;">'
            + '<a href="https://www.instagram.com/luxe_party_tokyo/" style="color:#C9A84C;text-decoration:none;margin:0 8px;">Instagram</a>'
            + '<a href="https://www.tiktok.com/@luxe.party.tokyo" style="color:#C9A84C;text-decoration:none;margin:0 8px;">TikTok</a>'
            + '<a href="https://x.com/luxepartytokyo" style="color:#C9A84C;text-decoration:none;margin:0 8px;">X</a>'
            + '</div>'
            + '<div style="border-top:1px solid rgba(255,255,255,0.06);padding-top:16px;font-size:0.55rem;color:#444;line-height:1.9;text-align:center;">'
            + 'このメールは LUXE PARTY TOKYO からお送りしています。<br>'
            + '配信停止をご希望の方は<a href="' + unsubUrl + '" style="color:#666;">こちら</a>からお手続きください。'
            + '</div></div>';
        }

        function sendToGuests(guests, data, type) {
          var sent = 0;
          var sentEmailsForType = type === 'free' ? sentEmailsFree : sentEmailsPaid;
          for (var i = 0; i < guests.length; i++) {
            if (totalSent >= dailyLimit) break;
            var g = guests[i];
            var email = String(g.email || '');
            if (!email) continue;
            if (unsubEmails2[email.toLowerCase()]) { unsubCount++; continue; }
            // typeごとに送信済みをスキップ（free送信済みはfreeのみスキップ）
            if (sentEmailsForType[email.toLowerCase()]) { continue; }
            try {
              var unsubUrl = 'https://script.google.com/macros/s/AKfycbwlEtY2RZahMNrr6d5cYIcG8p3sXtNDh7_uC-79hC2G4H87Vy9k_cp_yFywmNc1Ogfe/exec?action=unsubscribe&email=' + encodeURIComponent(email) + '&name=' + encodeURIComponent(g.name || '');
              var html = buildHtml(data, g.name || '', unsubUrl);
              var opts = { htmlBody: html, name: 'LUXE PARTY TOKYO', charset: 'UTF-8' };
              if (replyTo) opts.replyTo = replyTo;
              GmailApp.sendEmail(email, sanitizeSubject(data.subject || ''), g.name + ' 様', opts);
              logSheet.appendRow([nowStr(), campaignId, type, email, data.subject || '', 'sent']);
              sent++;
              totalSent++;
              Utilities.sleep(300);
            } catch(mailErr) {
              console.error('mailmag送信失敗: ' + email + ' - ' + mailErr.message);
              logSheet.appendRow([nowStr(), campaignId, type, email, data.subject || '', 'error: ' + mailErr.message]);
            }
          }
          return sent;
        }

        sentFree = sendToGuests(guestsFree, dataFree, 'free');
        sentPaid = sendToGuests(guestsPaid, dataPaid, 'paid');
        SpreadsheetApp.flush();

        var remaining = (guestsFree.length - sentFree) + (guestsPaid.length - sentPaid);
        var msg = remaining > 0
          ? '本日の上限（' + dailyLimit + '通）に達しました。残り' + remaining + '名は明日以降に送信してください。'
          : '全員への送信が完了しました。';

        return res({ ok: true, sent_free: sentFree, sent_paid: sentPaid, unsubscribed: unsubCount, message: msg });
      }

            
      case 'sendMailMagTest': {
        var testEmail  = body.email    || '';
        var testType   = body.type     || 'free';
        var testData   = testType === 'free' ? (body.data_free || {}) : (body.data_paid || {});
        var replyTo2   = PropertiesService.getScriptProperties().getProperty('MAIL_REPLY_TO') || '';

        if (!testEmail) return res({ ok: false, message: 'メールアドレスが必要です' });
        if (!testData.subject) return res({ ok: false, message: '件名を入力してください' });

        function buildTestHtml(data, unsubUrl) {
          var allImgs = [];
          var origUrls = [];
          if (data.image) { var _u0 = String(data.image); allImgs.push(convertDriveUrl(_u0)); origUrls.push(getDriveViewUrl_(_u0)); }
          (data.gallery || []).forEach(function(u) { if (!u) return; var c = convertDriveUrl(String(u)); if (c) { allImgs.push(c); origUrls.push(getDriveViewUrl_(String(u))); } });
          var imagesHtml = '';
          if (allImgs.length > 0) {
            imagesHtml = '<table width="100%" cellpadding="2" cellspacing="0" style="margin:0 0 16px 0;"><tbody>';
            for (var gi = 0; gi < allImgs.length; gi += 2) {
              imagesHtml += '<tr><td width="50%" style="padding:2px;background:#111;"><a href="' + (origUrls[gi]||allImgs[gi]) + '" target="_blank" style="display:block;"><img src="' + allImgs[gi] + '" style="width:100%;display:block;border:0;" alt=""></a></td>';
              imagesHtml += allImgs[gi+1]
                ? '<td width="50%" style="padding:2px;background:#111;"><a href="' + (origUrls[gi+1]||allImgs[gi+1]) + '" target="_blank" style="display:block;"><img src="' + allImgs[gi+1] + '" style="width:100%;display:block;border:0;" alt=""></a></td></tr>'
                : '<td width="50%" style="background:#111;"></td></tr>';
            }
            imagesHtml += '</tbody></table>';
          }
          var bodyHtml = encodeEmojiForHtml(String(data.body || '')).replace(/\n/g, '<br>');
          var ctaRow = data.ctaUrl
            ? '<div style="text-align:center;margin-bottom:28px;"><a href="' + data.ctaUrl + '" style="display:inline-block;background:#C9A84C;color:#000;text-decoration:none;padding:16px 36px;font-size:0.7rem;font-weight:700;letter-spacing:0.2em;">' + (data.ctaText || '詳細はこちら') + '</a></div>'
            : '';
          return '<html><head><meta charset="UTF-8"></head><body>'
            + '<div style="background:#CF4444;padding:8px;font-size:0.65rem;color:#fff;text-align:center;margin-bottom:0;">⚠️ これはテスト送信です / TEST MAIL</div>'
            + '<div style="background:#080808;padding:32px 20px;font-family:sans-serif;color:#F5F0E8;max-width:480px;margin:0 auto;">'
            + '<div style="font-size:1.3rem;color:#C9A84C;letter-spacing:0.3em;margin-bottom:4px;">LUXE PARTY TOKYO</div>'
            + '<div style="font-size:0.6rem;color:#888;letter-spacing:0.2em;margin-bottom:28px;">INVITATION</div>'
            + imagesHtml
            + ctaRow
            + '<p style="font-size:0.9rem;margin-bottom:8px;">テスト 様</p>'
            + '<p style="font-size:0.78rem;color:#aaa;line-height:1.9;margin-bottom:24px;white-space:pre-wrap;">' + encodeEmojiForHtml(data.greeting || '') + '</p>'
            + '<p style="font-size:0.75rem;color:#ccc;line-height:1.9;margin-bottom:28px;">' + bodyHtml + '</p>'
            + ctaRow
            + '<div style="text-align:center;margin-bottom:24px;font-size:0.6rem;color:#666;">'
            + '<a href="https://www.instagram.com/luxe_party_tokyo/" style="color:#C9A84C;text-decoration:none;margin:0 8px;">Instagram</a>'
            + '<a href="https://www.tiktok.com/@luxe.party.tokyo" style="color:#C9A84C;text-decoration:none;margin:0 8px;">TikTok</a>'
            + '<a href="https://x.com/luxepartytokyo" style="color:#C9A84C;text-decoration:none;margin:0 8px;">X</a>'
            + '</div>'
            + '<div style="border-top:1px solid rgba(255,255,255,0.06);padding-top:16px;font-size:0.55rem;color:#444;line-height:1.9;text-align:center;">'
            + 'このメールは LUXE PARTY TOKYO からお送りしています。<br>'
            + '配信停止をご希望の方は<a href="' + unsubUrl + '" style="color:#666;">こちら</a>からお手続きください。'
            + '</div></div>';
        }

        try {
          var testUnsubUrl = 'https://script.google.com/macros/s/AKfycbwlEtY2RZahMNrr6d5cYIcG8p3sXtNDh7_uC-79hC2G4H87Vy9k_cp_yFywmNc1Ogfe/exec?action=unsubscribe&email=' + encodeURIComponent(testEmail) + '&name=テスト';
          var testHtml = buildTestHtml(testData, testUnsubUrl);
          var testOpts = { htmlBody: testHtml, name: 'LUXE PARTY TOKYO【テスト】', charset: 'UTF-8' };
          if (replyTo2) testOpts.replyTo = replyTo2;
          GmailApp.sendEmail(
            testEmail,
            '【テスト】' + sanitizeSubject(testData.subject || ''),
            'テスト送信メールです。',
            testOpts
          );
          return res({ ok: true });
        } catch(testErr) {
          return res({ ok: false, message: testErr.message });
        }
      }

            
      case 'getCampaignStatus': {
        var cid = body.campaign_id || '';
        if (!cid) return res({ ok: false });
        var ls = sheet('mail_logs');
        if (!ls) return res({ ok: true, sent_free: 0, sent_paid: 0, sent_count: 0, sent_emails: [] });
        var lrows = ls.getDataRange().getValues();
        var lh    = lrows[0].map(function(h){ return String(h).trim(); });
        var cidI  = lh.indexOf('campaign_id');
        var emlI  = lh.indexOf('email');
        var stI   = lh.indexOf('status');
        var typI  = lh.indexOf('type');
        if (cidI < 0) return res({ ok: true, sent_free: 0, sent_paid: 0, sent_count: 0, sent_emails: [] });
        var sentFreeList = [], sentPaidList = [];
        for (var i = 1; i < lrows.length; i++) {
          if (String(lrows[i][cidI]) === cid && String(lrows[i][stI]) === 'sent') {
            var t = typI >= 0 ? String(lrows[i][typI]) : '';
            var e = String(lrows[i][emlI]);
            if (t === 'free') sentFreeList.push(e);
            else if (t === 'paid') sentPaidList.push(e);
            else sentFreeList.push(e); // type不明は無料扱い
          }
        }
        return res({
          ok: true,
          sent_free:   sentFreeList.length,
          sent_paid:   sentPaidList.length,
          sent_count:  sentFreeList.length + sentPaidList.length,
          sent_emails: sentFreeList.concat(sentPaidList)
        });
      }

            
      case 'getMailQuota': {
        try {
          // MailApp.getRemainingDailyQuotaで残数取得
          var quota = 100;
          try { quota = MailApp.getRemainingDailyQuota(); } catch(mqe) {}

          // mail_logsから今日の送信数をカウント（バックアップ）
          var now2    = new Date();
          var jst2    = new Date(now2.getTime() + 9 * 60 * 60 * 1000);
          var today2  = jst2.toISOString().slice(0, 10); // YYYY-MM-DD
          var todaySent = 0;
          var ls2 = sheet('mail_logs');
          if (ls2) {
            var lr2 = ls2.getDataRange().getValues();
            var lh2 = lr2[0].map(function(h){ return String(h).trim(); });
            var saI = lh2.indexOf('sent_at');
            var stI2 = lh2.indexOf('status');
            for (var i = 1; i < lr2.length; i++) {
              var sentAt = String(lr2[i][saI] || '');
              if (sentAt.slice(0, 10) === today2 && String(lr2[i][stI2]) === 'sent') {
                todaySent++;
              }
            }
          }

          // quotaが正常に取れた場合はそちらを優先、取れなければmail_logsから計算
          var usedCount  = (quota < 100) ? (100 - quota) : todaySent;
          var remaining  = Math.max(0, 100 - usedCount);

          // リセット時間計算（PDT夏時間: JST 16:00、冬時間: JST 17:00）
          var resetHourJST = 16;
          var jstHour2 = jst2.getUTCHours();
          var jstMin2  = jst2.getUTCMinutes();
          var minutesUntilReset;
          if (jstHour2 < resetHourJST) {
            minutesUntilReset = (resetHourJST - jstHour2) * 60 - jstMin2;
          } else {
            minutesUntilReset = (24 - jstHour2 + resetHourJST) * 60 - jstMin2;
          }
          var hoursUntilReset  = Math.floor(minutesUntilReset / 60);
          var minutesRemainder = minutesUntilReset % 60;

          return res({
            ok:                true,
            remaining:         remaining,
            daily_limit:       100,
            used:              usedCount,
            today_sent_logs:   todaySent,
            hours_until_reset: hoursUntilReset,
            minutes_remainder: minutesRemainder,
            reset_time_jst:    resetHourJST + ':00',
            can_send:          remaining > 0
          });
        } catch(e) {
          return res({ ok: false, message: e.message });
        }
      }

      case 'getMailTemplates': {
        var tplS = sheet('mail_templates');
        if (!tplS) return res({ ok: true, templates: {} });
        var tplR = tplS.getDataRange().getValues();
        var tplH = tplR[0].map(function(c){ return String(c).trim(); });
        var tplResult = {};
        for (var i = 1; i < tplR.length; i++) {
          var tName2 = String(tplR[i][tplH.indexOf('name')] || '');
          var tJson  = String(tplR[i][tplH.indexOf('data_json')] || '');
          if (tName2 && tJson) {
            try { tplResult[tName2] = JSON.parse(tJson); } catch(e) {}
          }
        }
        return res({ ok: true, templates: tplResult });
      }

      case 'saveMailTemplate': {
        var saveName = body.name || '';
        if (!saveName) return res({ ok: false, message: 'テンプレート名が必要です' });
        var saveData = body.data || {};
        var tplSS = sheet('mail_templates');
        if (!tplSS) {
          tplSS = SS.insertSheet('mail_templates');
          tplSS.appendRow(['name', 'data_json', 'updated_at']);
        }
        var sRows = tplSS.getDataRange().getValues();
        var sH = sRows[0].map(function(c){ return String(c).trim(); });
        var found = -1;
        for (var i = 1; i < sRows.length; i++) {
          if (String(sRows[i][sH.indexOf('name')]) === saveName) { found = i; break; }
        }
        var saveJson = JSON.stringify(saveData);
        if (found >= 0) {
          tplSS.getRange(found+1, sH.indexOf('data_json')+1).setValue(saveJson);
          tplSS.getRange(found+1, sH.indexOf('updated_at')+1).setValue(nowStr());
        } else {
          tplSS.appendRow([saveName, saveJson, nowStr()]);
        }
        SpreadsheetApp.flush();
        return res({ ok: true });
      }

      case 'deleteMailTemplate': {
        var delName2 = body.name || '';
        var tplSD = sheet('mail_templates');
        if (!tplSD) return res({ ok: true });
        var dRows = tplSD.getDataRange().getValues();
        var dH = dRows[0].map(function(c){ return String(c).trim(); });
        for (var i = 1; i < dRows.length; i++) {
          if (String(dRows[i][dH.indexOf('name')]) === delName2) {
            tplSD.deleteRow(i+1);
            SpreadsheetApp.flush();
            break;
          }
        }
        return res({ ok: true });
      }

      case 'addPlan': {
        var ps = sheet('event_plans');
        if (!ps) {
          ps = SS.insertSheet('event_plans');
          ps.appendRow(['plan_id','event_id','plan_name','price_male','price_female',
                        'capacity','current_count','status','redirect_url',
                        'capacity_male','capacity_female','count_male','count_female',
                        'payment_methods','display_text']);
        } else {
          // 既存シートにredirect_url列・男女別列がなければ自動追加
          var psH = ps.getRange(1,1,1,ps.getLastColumn()).getValues()[0].map(function(h){ return String(h).trim(); });
          var colsToAdd = ['redirect_url','capacity_male','capacity_female','count_male','count_female','payment_methods','display_text'];
          colsToAdd.forEach(function(col) {
            if (psH.indexOf(col) < 0) {
              var nextCol = ps.getLastColumn() + 1;
              ps.getRange(1, nextCol).setValue(col);
              psH.push(col);
            }
          });
          SpreadsheetApp.flush();
        }
        var planId = 'PLAN-' + Date.now().toString(36).toUpperCase();
        var capacity    = Number(body.capacity    || 0);
        var capMale     = Number(body.capacity_male   || 0);
        var capFemale   = Number(body.capacity_female || 0);
        ps.appendRow([
          planId,
          body.event_id || '',
          body.plan_name || '',
          Number(body.price_male   || 0),
          Number(body.price_female || 0),
          capacity,
          0,
          'active',
          body.redirect_url || '',
          capMale,
          capFemale,
          0,
          0,
          body.payment_methods || '',  // 空=イベントの設定を継承
          body.display_text || ''        // 空=実際の残り人数を表示
        ]);
        SpreadsheetApp.flush();
        return res({ ok: true, plan_id: planId });
      }

      case 'updatePlanStatus': {
        var ps2 = sheet('event_plans');
        if (!ps2) return res({ ok: false, message: 'event_plansシートがありません' });
        var ps2Rows = ps2.getRange(1, 1, ps2.getLastRow(), ps2.getLastColumn()).getValues();
        var ps2H    = ps2Rows[0].map(function(h){ return String(h).trim(); });
        var pidIdx  = ps2H.indexOf('plan_id');
        var stIdx   = ps2H.indexOf('status');
        for (var i = 1; i < ps2Rows.length; i++) {
          if (String(ps2Rows[i][pidIdx]) === String(body.plan_id)) {
            ps2.getRange(i+1, stIdx+1).setValue(body.status);
            SpreadsheetApp.flush();
            return res({ ok: true });
          }
        }
        return res({ ok: false, message: 'プランが見つかりません' });
      }

      case 'updatePlanCapacity': {
        var ps3 = sheet('event_plans');
        if (!ps3) return res({ ok: false, message: 'event_plansシートがありません' });
        var ps3Rows = ps3.getRange(1, 1, ps3.getLastRow(), ps3.getLastColumn()).getValues();
        var ps3H    = ps3Rows[0].map(function(h){ return String(h).trim(); });
        var pidIdx3 = ps3H.indexOf('plan_id');
        var capIdx  = ps3H.indexOf('capacity');
        var ridIdx  = ps3H.indexOf('redirect_url');
        for (var i = 1; i < ps3Rows.length; i++) {
          if (String(ps3Rows[i][pidIdx3]) === String(body.plan_id)) {
            ps3.getRange(i+1, capIdx+1).setValue(Number(body.capacity || 0));
            if (body.redirect_url !== undefined && ridIdx >= 0) {
              ps3.getRange(i+1, ridIdx+1).setValue(body.redirect_url || '');
            }
            // payment_methodsも更新
            var pmColIdx = ps3H.indexOf('payment_methods');
            if (body.payment_methods !== undefined && pmColIdx >= 0) {
              ps3.getRange(i+1, pmColIdx+1).setValue(body.payment_methods || '');
            }
            // display_textも更新
            var dtColIdx = ps3H.indexOf('display_text');
            if (body.display_text !== undefined && dtColIdx >= 0) {
              ps3.getRange(i+1, dtColIdx+1).setValue(body.display_text || '');
            }
            SpreadsheetApp.flush();
            return res({ ok: true });
          }
        }
        return res({ ok: false, message: 'プランが見つかりません' });
      }

      case 'deletePlan': {
        var ps4 = sheet('event_plans');
        if (!ps4) return res({ ok: false });
        var ps4Rows = ps4.getRange(1, 1, ps4.getLastRow(), ps4.getLastColumn()).getValues();
        var ps4H    = ps4Rows[0].map(function(h){ return String(h).trim(); });
        var pidIdx4 = ps4H.indexOf('plan_id');
        for (var i = ps4Rows.length - 1; i >= 1; i--) {
          if (String(ps4Rows[i][pidIdx4]) === String(body.plan_id)) {
            ps4.deleteRow(i+1);
            SpreadsheetApp.flush();
            return res({ ok: true });
          }
        }
        return res({ ok: false, message: 'プランが見つかりません' });
      }

      case 'checkPlan': {
        var planId5  = body.plan_id  || '';
        var gender5  = body.gender   || ''; // 性別を受け取って男女別判定
        var ps5      = sheet('event_plans');
        if (!ps5) return res({ ok: false, message: 'プランが設定されていません' });
        var ps5Rows  = ps5.getRange(1, 1, ps5.getLastRow(), ps5.getLastColumn()).getValues();
        var ps5H     = ps5Rows[0].map(function(h){ return String(h).trim(); });
        var pidIdx5  = ps5H.indexOf('plan_id');
        var capIdx5  = ps5H.indexOf('capacity');
        var cntIdx5  = ps5H.indexOf('current_count');
        var stIdx5   = ps5H.indexOf('status');
        var nmIdx5   = ps5H.indexOf('plan_name');
        var pmIdx5   = ps5H.indexOf('price_male');
        var pfIdx5   = ps5H.indexOf('price_female');
        var ridIdx5  = ps5H.indexOf('redirect_url');
        var cmIdx5   = ps5H.indexOf('capacity_male');
        var cfIdx5   = ps5H.indexOf('capacity_female');
        var cntMIdx5 = ps5H.indexOf('count_male');
        var cntFIdx5 = ps5H.indexOf('count_female');

        for (var i = 1; i < ps5Rows.length; i++) {
          if (String(ps5Rows[i][pidIdx5]) !== planId5) continue;

          var status5    = String(ps5Rows[i][stIdx5]);
          var capacity5  = Number(ps5Rows[i][capIdx5]  || 0); // 合計上限
          var count5     = Number(ps5Rows[i][cntIdx5]  || 0); // 合計申込数
          var capMale5   = cmIdx5  >= 0 ? Number(ps5Rows[i][cmIdx5]   || 0) : 0;
          var capFem5    = cfIdx5  >= 0 ? Number(ps5Rows[i][cfIdx5]   || 0) : 0;
          var cntMale5   = cntMIdx5 >= 0 ? Number(ps5Rows[i][cntMIdx5] || 0) : 0;
          var cntFem5    = cntFIdx5 >= 0 ? Number(ps5Rows[i][cntFIdx5] || 0) : 0;

          // 上限判定（案B方式）
          // 男性/女性の上限に達したらURL全体を停止
          var isFullMale   = capMale5  > 0 && cntMale5  >= capMale5;
          var isFullFem    = capFem5   > 0 && cntFem5   >= capFem5;
          var isFullTotal  = capacity5 > 0 && count5    >= capacity5;

          // いずれかの上限に達したらURL全体を停止
          var isFull5 = isFullMale || isFullFem || isFullTotal;

          var isActive5  = status5 === 'active' && !isFull5;
          var redirectUrl5 = String(ps5Rows[i][ridIdx5] || '');

          // 残り人数計算
          var remainMale  = capMale5  > 0 ? Math.max(0, capMale5  - cntMale5)  : -1;
          var remainFem   = capFem5   > 0 ? Math.max(0, capFem5   - cntFem5)   : -1;
          var remainTotal = capacity5 > 0 ? Math.max(0, capacity5 - count5)    : -1;

          // redirect_urlに対応するプラン名を取得
          var redirectPlanName5 = '';
          if (redirectUrl5) {
            // URLにplan=PLAN-XXXが含まれている場合はそのプラン名を取得
            var planMatch = redirectUrl5.match(/[?&]plan=([^&]+)/);
            if (planMatch) {
              var redirectPlanId = planMatch[1];
              for (var rj = 1; rj < ps5Rows.length; rj++) {
                if (String(ps5Rows[rj][pidIdx5]) === redirectPlanId) {
                  redirectPlanName5 = String(ps5Rows[rj][nmIdx5] || '');
                  break;
                }
              }
            }
          }

          // payment_methods取得
          var pmIdx5b = ps5H.indexOf('payment_methods');
          var planPayMethods5 = pmIdx5b >= 0 ? String(ps5Rows[i][pmIdx5b] || '') : '';

          return res({
            ok:                 true,
            plan_id:            planId5,
            plan_name:          String(ps5Rows[i][nmIdx5] || ''),
            price_male:         Number(ps5Rows[i][pmIdx5] || 0),
            price_female:       Number(ps5Rows[i][pfIdx5] || 0),
            capacity:           capacity5,
            capacity_male:      capMale5,
            capacity_female:    capFem5,
            current_count:      count5,
            count_male:         cntMale5,
            count_female:       cntFem5,
            remain_male:        remainMale,
            remain_female:      remainFem,
            remain_total:       remainTotal,
            status:             status5,
            is_active:          isActive5,
            is_full:            isFull5,
            is_full_male:       isFullMale,
            is_full_female:     isFullFem,
            redirect_url:       redirectUrl5,
            redirect_plan_name: redirectPlanName5,
            payment_methods:    planPayMethods5,
            display_text:      (function(){
              var dtIdx = ps5H.indexOf('display_text');
              return dtIdx >= 0 ? String(ps5Rows[i][dtIdx] || '') : '';
            })()
          });
        }
        return res({ ok: false, message: 'プランが見つかりません' });
      }

      case 'incrementPlanCount': {
        var planId6  = body.plan_id || '';
        var gender6  = body.gender  || '';
        if (!planId6) return res({ ok: true });
        var ps6      = sheet('event_plans');
        if (!ps6) return res({ ok: true });
        var ps6Rows  = ps6.getRange(1, 1, ps6.getLastRow(), ps6.getLastColumn()).getValues();
        var ps6H     = ps6Rows[0].map(function(h){ return String(h).trim(); });
        var pidIdx6  = ps6H.indexOf('plan_id');
        var cntIdx6  = ps6H.indexOf('current_count');
        var capIdx6  = ps6H.indexOf('capacity');
        var stIdx6   = ps6H.indexOf('status');
        var cmIdx6   = ps6H.indexOf('capacity_male');
        var cfIdx6   = ps6H.indexOf('capacity_female');
        var cntMIdx6 = ps6H.indexOf('count_male');
        var cntFIdx6 = ps6H.indexOf('count_female');

        for (var i = 1; i < ps6Rows.length; i++) {
          if (String(ps6Rows[i][pidIdx6]) !== planId6) continue;

          // 合計カウント+1
          var newCount = Number(ps6Rows[i][cntIdx6] || 0) + 1;
          ps6.getRange(i+1, cntIdx6+1).setValue(newCount);

          // 性別別カウント+1（案B: 上限到達でURL全体停止）
          if (gender6 === 'male' && cntMIdx6 >= 0) {
            var newMale = Number(ps6Rows[i][cntMIdx6] || 0) + 1;
            ps6.getRange(i+1, cntMIdx6+1).setValue(newMale);
            var capM6 = cmIdx6 >= 0 ? Number(ps6Rows[i][cmIdx6] || 0) : 0;
            if (capM6 > 0 && newMale >= capM6) {
              ps6.getRange(i+1, stIdx6+1).setValue('full'); // URL全体停止
            }
          } else if (gender6 === 'female' && cntFIdx6 >= 0) {
            var newFem = Number(ps6Rows[i][cntFIdx6] || 0) + 1;
            ps6.getRange(i+1, cntFIdx6+1).setValue(newFem);
            var capF6 = cfIdx6 >= 0 ? Number(ps6Rows[i][cfIdx6] || 0) : 0;
            if (capF6 > 0 && newFem >= capF6) {
              ps6.getRange(i+1, stIdx6+1).setValue('full'); // URL全体停止
            }
          }

          // 合計上限チェック
          var cap6 = Number(ps6Rows[i][capIdx6] || 0);
          if (cap6 > 0 && newCount >= cap6) {
            ps6.getRange(i+1, stIdx6+1).setValue('full');
          }

          SpreadsheetApp.flush();
          return res({ ok: true, current_count: newCount });
        }
        return res({ ok: true });
      }

                  
      case 'migrateEvents': {
        // eventsシートにpayment_methods列を追加
        var evS = sheet('events');
        if (!evS) return res({ ok: false });
        var evH = evS.getRange(1,1,1,evS.getLastColumn()).getValues()[0].map(function(h){ return String(h).trim(); });
        var evAdded = [];
        if (evH.indexOf('payment_methods') < 0) {
          evS.getRange(1, evS.getLastColumn()+1).setValue('payment_methods');
          evAdded.push('payment_methods追加');
          SpreadsheetApp.flush();
        }
        return res({ ok: true, added: evAdded });
      }

        case 'addVipTable': {
          var vts = addVipTableIfNeeded();
          var vtH = vts.getRange(1,1,1,vts.getLastColumn()).getValues()[0].map(function(c){ return String(c).trim(); });
          var tid = 'VT-' + Date.now().toString(36).toUpperCase();
          var newRow = vtH.map(function(k) {
            switch(k) {
              case 'table_id':   return tid;
              case 'event_id':   return body.event_id || '';
              case 'table_name': return body.table_name || '';
              case 'table_type': return body.table_type || '';
              case 'capacity':   return Number(body.capacity || 0);
              case 'price':      return Number(body.price || 0);
              case 'status':     return 'available';
              default:           return '';
            }
          });
          vts.appendRow(newRow);
          SpreadsheetApp.flush();
          return res({ ok: true, table_id: tid });
        }

        case 'reserveVipTable': {
          var vts2 = addVipTableIfNeeded();
          var vt2Rows = vts2.getRange(1,1,vts2.getLastRow(),vts2.getLastColumn()).getValues();
          var vt2H = vt2Rows[0].map(function(c){ return String(c).trim(); });
          var tableId2 = body.table_id || '';
          var tRow2 = -1;
          for (var i=1; i<vt2Rows.length; i++) {
            if (String(vt2Rows[i][vt2H.indexOf('table_id')]) === tableId2) { tRow2 = i; break; }
          }
          if (tRow2 < 0) return res({ ok: false, message: 'テーブルが見つかりません' });
          var curSt2 = String(vt2Rows[tRow2][vt2H.indexOf('status')] || '');
          if (curSt2 !== 'available') return res({ ok: false, message: 'このテーブルはすでに予約済みです' });

          var vGid = 'VIP-' + Date.now().toString(36).toUpperCase();
          var payMethod = body.payment_method || 'stripe';
          var now2 = new Date();
          var deadline = new Date(now2.getTime() + 3 * 24 * 60 * 60 * 1000);
          var newSt2 = payMethod === 'transfer' ? 'pending_payment' : 'reserved';
          vts2.getRange(tRow2+1, vt2H.indexOf('status')+1).setValue(newSt2);
          var cm2 = { reserved_by: body.name||'', reserved_email: body.email||'', reserved_phone: body.phone||'',
            reserved_at: nowStr(), payment_method: payMethod, guest_id: vGid,
            transfer_deadline: payMethod==='transfer' ? Utilities.formatDate(deadline,'Asia/Tokyo','yyyy-MM-dd') : '' };
          Object.keys(cm2).forEach(function(k){ var ci=vt2H.indexOf(k); if(ci>=0) vts2.getRange(tRow2+1,ci+1).setValue(cm2[k]); });

          var vrs = sheet('vip_reservations');
          if (!vrs) {
            vrs = SS.insertSheet('vip_reservations');
            vrs.appendRow(['reservation_id','table_id','event_id','table_name','table_type',
              'name','email','phone','payment_method','status',
              'transfer_deadline','confirmed_at','guest_id','reserved_at','notes']);
          }
          var tName2 = String(vt2Rows[tRow2][vt2H.indexOf('table_name')]||'');
          var tType2 = String(vt2Rows[tRow2][vt2H.indexOf('table_type')]||'');
          var tPrice2 = Number(vt2Rows[tRow2][vt2H.indexOf('price')]||0);
          var evId2 = String(vt2Rows[tRow2][vt2H.indexOf('event_id')]||'');
          vrs.appendRow(['RES-'+Date.now().toString(36).toUpperCase(),tableId2,evId2,tName2,tType2,
            body.name||'',body.email||'',body.phone||'',payMethod,newSt2,
            payMethod==='transfer'?Utilities.formatDate(deadline,'Asia/Tokyo','yyyy-MM-dd'):'',
            '',vGid,nowStr(),body.notes||'']);
          SpreadsheetApp.flush();

          if (payMethod === 'transfer') {
            try {
              var replyToV = PropertiesService.getScriptProperties().getProperty('MAIL_REPLY_TO')||'luxe.party.com@gmail.com';
              var bankInfo = PropertiesService.getScriptProperties().getProperty('BANK_INFO')||'【お振込先】\nさわやか信用金庫 渋谷支店\n普通 No.1254947\n株式会社リュクス';
              var companyInfoV = '【発行者情報】\n株式会社リュクス\n〒150-0041 東京都渋谷区神南1-23-14\nTel: 03-6892-7253\n担当: 池田隆史\n登録番号: T2011001152835';
              var evNameV=''; var evSV=sheet('events');
              if(evSV){var evRV=evSV.getDataRange().getValues();var evHV=evRV[0].map(function(c){return String(c).trim();});
                for(var ei=1;ei<evRV.length;ei++){if(String(evRV[ei][evHV.indexOf('event_id')])===evId2){evNameV=String(evRV[ei][evHV.indexOf('name')]||'');break;}}}
              GmailApp.sendEmail(body.email,
                '【LUXE PARTY TOKYO】VIPテーブル仮予約のご確認',
                body.name+'様\n\nこの度はLUXE PARTY TOKYOにお申し込みいただき、誠にありがとうございます。\nVIPテーブルの仮予約を承りました。\n\n■ご予約内容\nイベント: '+evNameV+'\nテーブル: '+tName2+' ('+tType2+')\n料金: ¥'+tPrice2.toLocaleString()+'（税込）\n\n■お振込のお願い\n'+Utilities.formatDate(deadline,'Asia/Tokyo','yyyy年MM月dd日')+'までにお振込ください。\n期限を過ぎると自動キャンセルとなります。\n\n'+bankInfo+'\n振込金額: ¥'+tPrice2.toLocaleString()+'（税込）\n\n'+companyInfoV+'\n\n■ご注意\n・本予約はキャンセル・返金不可となります。予めご了承の上でお申し込みください。\n・上限席数を超えるご入場をご希望の場合は、男性お一人につき5万円頂戴します。\n\nご入金確認後、QRコード招待状をお送りします。\n\nLUXE PARTY TOKYO\n'+replyToV,
                {name:'LUXE PARTY TOKYO',replyTo:replyToV});
            } catch(e){ console.log('VIP振込メールエラー:',e); }
          }
          return res({ ok:true, guest_id:vGid, table_name:tName2, payment_method:payMethod,
            transfer_deadline: payMethod==='transfer'?Utilities.formatDate(deadline,'Asia/Tokyo','yyyy年MM月dd日'):'', price:tPrice2 });
        }

        case 'reserveVipByRank': {
          // ランク名から空きテーブルを自動割り当てして予約
          var rankType = body.rank_type || '';
          var evIdR = body.event_id || '';
          var invitedByR = body.invited_by || '';
          // price_hint: Secret VIPの¥500,000 / ¥300,000 等を区別するテーブル絞り込み用
          var priceHintR = body.price_hint ? Number(body.price_hint) : 0;
          if (!rankType) return res({ ok: false, message: 'ランクを指定してください' });
          var vtsR = addVipTableIfNeeded();
          var vtRRows = vtsR.getRange(1,1,vtsR.getLastRow(),vtsR.getLastColumn()).getValues();
          var vtRH = vtRRows[0].map(function(c){ return String(c).trim(); });
          var priceColR = vtRH.indexOf('price');
          // ランク名は table_type カラムで照合、price_hint・event_id も一致するものを優先
          var tRowR = -1;
          for (var i=1; i<vtRRows.length; i++) {
            var rowType = String(vtRRows[i][vtRH.indexOf('table_type')]||'');
            var rowEv   = String(vtRRows[i][vtRH.indexOf('event_id')]||'');
            var rowSt   = String(vtRRows[i][vtRH.indexOf('status')]||'');
            var rowPrR  = priceColR >= 0 ? Number(vtRRows[i][priceColR]||0) : 0;
            var priceOk = priceHintR <= 0 || rowPrR === priceHintR;
            if (rowType === rankType && rowSt === 'available' && priceOk) {
              if (evIdR && rowEv === evIdR) { tRowR = i; break; }
              if (!evIdR && tRowR < 0) { tRowR = i; break; }
            }
          }
          // event_id指定で見つからなければ全体から探す
          if (tRowR < 0 && evIdR) {
            for (var i=1; i<vtRRows.length; i++) {
              var rowType2 = String(vtRRows[i][vtRH.indexOf('table_type')]||'');
              var rowSt2   = String(vtRRows[i][vtRH.indexOf('status')]||'');
              var rowPrR2  = priceColR >= 0 ? Number(vtRRows[i][priceColR]||0) : 0;
              var priceOk2 = priceHintR <= 0 || rowPrR2 === priceHintR;
              if (rowType2 === rankType && rowSt2 === 'available' && priceOk2) { tRowR = i; break; }
            }
          }
          if (tRowR < 0) return res({ ok: false, message: '現在このランクに空きはありません' });

          var tableIdR = String(vtRRows[tRowR][vtRH.indexOf('table_id')]||'');
          // シートから直接再読みして最新状態を確認（TOCTOU対策: キャッシュではなく実値）
          var statusColIdxR = vtRH.indexOf('status') + 1;
          if (statusColIdxR < 1) return res({ ok: false, message: 'シートのスキーマエラー（statusカラム未定義）' });
          var liveStR = String(vtsR.getRange(tRowR+1, statusColIdxR).getValue() || '');
          if (liveStR !== 'available') return res({ ok: false, message: 'このテーブルはすでに予約済みです' });

          var vGidR    = 'VIP-' + Date.now().toString(36).toUpperCase();
          var payMethodR = body.payment_method || 'stripe';
          var nowR     = new Date();
          var deadlineR = new Date(nowR.getTime() + 3 * 24 * 60 * 60 * 1000);
          var newStR   = payMethodR === 'transfer' ? 'pending_payment' : 'reserved';
          // 全フィールドを一括 setValues で書き込む（途中失敗による不整合を最小化）
          var rowDataR = vtsR.getRange(tRowR+1, 1, 1, vtRH.length).getValues()[0];
          var cmR = {
            status: newStR,
            reserved_by: body.name||'', reserved_email: body.email||'', reserved_phone: body.phone||'',
            reserved_at: nowStr(), payment_method: payMethodR, guest_id: vGidR,
            transfer_deadline: payMethodR==='transfer' ? Utilities.formatDate(deadlineR,'Asia/Tokyo','yyyy-MM-dd') : ''
          };
          Object.keys(cmR).forEach(function(k){ var ci=vtRH.indexOf(k); if(ci>=0) rowDataR[ci]=cmR[k]; });
          vtsR.getRange(tRowR+1, 1, 1, vtRH.length).setValues([rowDataR]);

          var tNameR  = String(vtRRows[tRowR][vtRH.indexOf('table_name')]||'');
          var tTypeR  = String(vtRRows[tRowR][vtRH.indexOf('table_type')]||'');
          var tPriceR = Number(vtRRows[tRowR][vtRH.indexOf('price')]||0);
          var evIdR2  = String(vtRRows[tRowR][vtRH.indexOf('event_id')]||'') || evIdR;

          var vrsR = sheet('vip_reservations');
          if (!vrsR) {
            vrsR = SS.insertSheet('vip_reservations');
            vrsR.appendRow(['reservation_id','table_id','event_id','table_name','table_type',
              'name','email','phone','payment_method','status',
              'transfer_deadline','confirmed_at','guest_id','reserved_at','notes','invited_by']);
          }
          vrsR.appendRow(['RES-'+Date.now().toString(36).toUpperCase(),tableIdR,evIdR2,tNameR,tTypeR,
            body.name||'',body.email||'',body.phone||'',payMethodR,newStR,
            payMethodR==='transfer'?Utilities.formatDate(deadlineR,'Asia/Tokyo','yyyy-MM-dd'):'',
            '',vGidR,nowStr(),body.notes||'',invitedByR]);
          SpreadsheetApp.flush();

          if (payMethodR === 'transfer') {
            try {
              var replyToVR = PropertiesService.getScriptProperties().getProperty('MAIL_REPLY_TO')||'luxe.party.com@gmail.com';
              var bankInfoR = PropertiesService.getScriptProperties().getProperty('BANK_INFO')||'【お振込先】\nさわやか信用金庫 渋谷支店\n普通 No.1254947\n株式会社リュクス';
              var companyInfoVR = '【発行者情報】\n株式会社リュクス\n〒150-0041 東京都渋谷区神南1-23-14\nTel: 03-6892-7253\n担当: 池田隆史\n登録番号: T2011001152835';
              var evNameVR=''; var evSVR=sheet('events');
              if(evSVR){var evRVR=evSVR.getDataRange().getValues();var evHVR=evRVR[0].map(function(c){return String(c).trim();});
                for(var ei=1;ei<evRVR.length;ei++){if(String(evRVR[ei][evHVR.indexOf('event_id')])===evIdR2){evNameVR=String(evRVR[ei][evHVR.indexOf('name')]||'');break;}}}
              var invitedLineVR = invitedByR ? '\n紹介者: '+invitedByR : '';
              GmailApp.sendEmail(body.email,
                '【LUXE PARTY TOKYO】VIPテーブル仮予約のご確認',
                body.name+'様\n\nこの度はLUXE PARTY TOKYOにお申し込みいただき、誠にありがとうございます。\nVIPテーブルの仮予約を承りました。\n\n■ご予約内容\nイベント: '+evNameVR+'\nランク: '+tTypeR+'\nテーブル: '+tNameR+'\n料金: ¥'+tPriceR.toLocaleString()+'（税込）'+invitedLineVR+'\n\n■お振込のお願い\n'+Utilities.formatDate(deadlineR,'Asia/Tokyo','yyyy年MM月dd日')+'までにお振込ください。\n期限を過ぎると自動キャンセルとなります。\n\n'+bankInfoR+'\n振込金額: ¥'+tPriceR.toLocaleString()+'（税込）\n\n'+companyInfoVR+'\n\n■ご注意\n・本予約はキャンセル・返金不可となります。予めご了承の上でお申し込みください。\n・上限席数を超えるご入場をご希望の場合は、男性お一人につき5万円頂戴します。\n\nご入金確認後、QRコード招待状をお送りします。\n\nLUXE PARTY TOKYO\n'+replyToVR,
                {name:'LUXE PARTY TOKYO',replyTo:replyToVR});
            } catch(e){ console.log('VIP振込メールエラー(rank):',e); }
          }
          return res({ ok:true, guest_id:vGidR, table_name:tNameR, rank_type:tTypeR,
            payment_method:payMethodR,
            transfer_deadline: payMethodR==='transfer'?Utilities.formatDate(deadlineR,'Asia/Tokyo','yyyy年MM月dd日'):'',
            price:tPriceR });
        }

        case 'confirmVipPayment': {
          var vts3 = addVipTableIfNeeded();
          var vt3Rows = vts3.getRange(1,1,vts3.getLastRow(),vts3.getLastColumn()).getValues();
          var vt3H = vt3Rows[0].map(function(c){ return String(c).trim(); });
          var guestId3 = body.guest_id || '';
          var tRow3 = -1;
          for (var i=1;i<vt3Rows.length;i++) { if(String(vt3Rows[i][vt3H.indexOf('guest_id')])===guestId3){tRow3=i;break;} }
          if (tRow3 < 0) return res({ ok:false, message:'予約が見つかりません' });
          vts3.getRange(tRow3+1,vt3H.indexOf('status')+1).setValue('confirmed');
          vts3.getRange(tRow3+1,vt3H.indexOf('confirmed_at')+1).setValue(nowStr());
          var vrs3=sheet('vip_reservations');
          if(vrs3&&vrs3.getLastRow()>1){var vr3=vrs3.getRange(1,1,vrs3.getLastRow(),vrs3.getLastColumn()).getValues();var vrH=vr3[0].map(function(c){return String(c).trim();});
            for(var j=1;j<vr3.length;j++){if(String(vr3[j][vrH.indexOf('guest_id')])===guestId3){vrs3.getRange(j+1,vrH.indexOf('status')+1).setValue('confirmed');vrs3.getRange(j+1,vrH.indexOf('confirmed_at')+1).setValue(nowStr());break;}}}
          SpreadsheetApp.flush();
          var tName3=String(vt3Rows[tRow3][vt3H.indexOf('table_name')]||'');
          var tType3=String(vt3Rows[tRow3][vt3H.indexOf('table_type')]||'');
          var toEmail3=String(vt3Rows[tRow3][vt3H.indexOf('reserved_email')]||'');
          var toName3=String(vt3Rows[tRow3][vt3H.indexOf('reserved_by')]||'');
          var tPrice3=Number(vt3Rows[tRow3][vt3H.indexOf('price')]||0);
          var evId3=String(vt3Rows[tRow3][vt3H.indexOf('event_id')]||'');
          var evName3=''; var evS3=sheet('events');
          if(evS3){var evR3=evS3.getDataRange().getValues();var evH3=evR3[0].map(function(c){return String(c).trim();});
            for(var ei3=1;ei3<evR3.length;ei3++){if(String(evR3[ei3][evH3.indexOf('event_id')])===evId3){evName3=String(evR3[ei3][evH3.indexOf('name')]||'');break;}}}
          try {
            var rTo3=PropertiesService.getScriptProperties().getProperty('MAIL_REPLY_TO')||'luxe.party.com@gmail.com';
            var qrUrl3='https://luxepartycom.github.io/event-system/vip-ticket.html?id='+guestId3;
            GmailApp.sendEmail(toEmail3,'【LUXE PARTY TOKYO】VIPご招待状 / QRコード',
              toName3+'様\n\nお振込を確認いたしました。誠にありがとうございます。\nご予約が確定いたしました。\n\n■当日のご案内\n受付にて以下のQRコードをご提示ください。\nQRコードURL: '+qrUrl3+'\n\n本QRコードはご来場予定の各位にご共有いただけます。受付にて各自ご提示ください。\nご入場は購入席数を上限とさせていただきます。上限を超えるご入場をご希望の場合は、男性お一人につき5万円の追加料金が発生いたします。\n\n■ご注意\n・本予約はキャンセル・返金不可となります。\n・上限席数を超えるご入場をご希望の場合は、男性お一人につき5万円頂戴します。\n\nLUXE PARTY TOKYO\n'+rTo3,
              {name:'LUXE PARTY TOKYO',replyTo:rTo3});
          } catch(e){ console.log('VIP確定メールエラー:',e); }
          return res({ ok:true, guest_id:guestId3, table_name:tName3, email:toEmail3 });
        }

        case 'updateVipTableStatus': {
          var vts4 = addVipTableIfNeeded();
          var vt4Rows = vts4.getRange(1,1,vts4.getLastRow(),vts4.getLastColumn()).getValues();
          var vt4H = vt4Rows[0].map(function(c){ return String(c).trim(); });
          var tid4 = body.table_id || ''; var newSt4 = body.status || 'available';
          for (var i=1;i<vt4Rows.length;i++) {
            if(String(vt4Rows[i][vt4H.indexOf('table_id')])===tid4){
              vts4.getRange(i+1,vt4H.indexOf('status')+1).setValue(newSt4);
              if(newSt4==='available'){
                ['reserved_by','reserved_email','reserved_phone','reserved_at','payment_method','transfer_deadline','guest_id']
                  .forEach(function(k){var ci=vt4H.indexOf(k);if(ci>=0)vts4.getRange(i+1,ci+1).setValue('');});
              }
              SpreadsheetApp.flush();
              return res({ ok:true });
            }
          }
          return res({ ok:false, message:'テーブルが見つかりません' });
        }

      
        case 'createVipStripeLink': {
          var vtsL=addVipTableIfNeeded(),vtLRows=vtsL.getRange(1,1,vtsL.getLastRow(),vtsL.getLastColumn()).getValues(),vtLH=vtLRows[0].map(function(c){return String(c).trim();});
          var tableIdL=body.table_id||'',tRowL=-1;
          for(var i=1;i<vtLRows.length;i++){if(String(vtLRows[i][vtLH.indexOf('table_id')])===tableIdL){tRowL=i;break;}}
          if(tRowL<0) return res({ok:false,message:'テーブルが見つかりません'});
          if(String(vtLRows[tRowL][vtLH.indexOf('status')])!=='available') return res({ok:false,message:'このテーブルはすでに予約済みです'});
          var vGidL='VIP-'+Date.now().toString(36).toUpperCase();
          var tNameL=String(vtLRows[tRowL][vtLH.indexOf('table_name')]||''),tTypeL=String(vtLRows[tRowL][vtLH.indexOf('table_type')]||''),tPriceL=Number(vtLRows[tRowL][vtLH.indexOf('price')]||0),evIdL=String(vtLRows[tRowL][vtLH.indexOf('event_id')]||'');
          var guestName=body.name||'',guestEmail=body.email||'',guestPhone=body.phone||'';
          var skL=PropertiesService.getScriptProperties().getProperty('STRIPE_SECRET_KEY')||'';
          if(!skL) return res({ok:false,message:'Stripe設定がありません'});
          var evNameL='',evSL=sheet('events');
          if(evSL){var evRL=evSL.getDataRange().getValues(),evHL=evRL[0].map(function(c){return String(c).trim();});for(var ei=1;ei<evRL.length;ei++){if(String(evRL[ei][evHL.indexOf('event_id')])===evIdL){evNameL=String(evRL[ei][evHL.indexOf('name')]||'');break;}}}
          var pL='mode=payment&payment_method_types[0]=card&line_items[0][price_data][currency]=jpy&line_items[0][price_data][unit_amount]='+tPriceL+'&line_items[0][price_data][product_data][name]='+encodeURIComponent(evNameL+' VIP '+tNameL+' 飲食代')+'&line_items[0][quantity]=1&success_url='+encodeURIComponent('https://luxepartycom.github.io/event-system/vip-checkout.html?session_id={CHECKOUT_SESSION_ID}')+'&cancel_url='+encodeURIComponent('https://luxepartycom.github.io/event-system/')+'&customer_email='+encodeURIComponent(guestEmail)+'&metadata[event_id]='+evIdL+'&metadata[table_id]='+tableIdL+'&metadata[table_name]='+tNameL+'&metadata[guest_id]='+vGidL+'&metadata[name]='+encodeURIComponent(guestName)+'&metadata[amount]='+tPriceL;
          var authL=Utilities.base64Encode(skL+':'),strResL=UrlFetchApp.fetch('https://api.stripe.com/v1/checkout/sessions',{method:'post',headers:{'Authorization':'Basic '+authL,'Content-Type':'application/x-www-form-urlencoded'},payload:pL,muteHttpExceptions:true}),strDataL=JSON.parse(strResL.getContentText());
          if(strDataL.error) return res({ok:false,message:'Stripe: '+strDataL.error.message});
          vtsL.getRange(tRowL+1,vtLH.indexOf('status')+1).setValue('stripe_pending');
          var cmL={reserved_by:guestName,reserved_email:guestEmail,reserved_phone:guestPhone,reserved_at:nowStr(),payment_method:'stripe',guest_id:vGidL};
          Object.keys(cmL).forEach(function(k){var ci=vtLH.indexOf(k);if(ci>=0)vtsL.getRange(tRowL+1,ci+1).setValue(cmL[k]);});
          var vrsL=sheet('vip_reservations');if(!vrsL){vrsL=SS.insertSheet('vip_reservations');vrsL.appendRow(['reservation_id','table_id','event_id','table_name','table_type','name','email','phone','payment_method','status','transfer_deadline','confirmed_at','guest_id','reserved_at','notes']);}
          vrsL.appendRow(['RES-'+Date.now().toString(36).toUpperCase(),tableIdL,evIdL,tNameL,tTypeL,guestName,guestEmail,guestPhone,'stripe','stripe_pending','','',vGidL,nowStr(),'']);
          SpreadsheetApp.flush();
          try{var rtL=PropertiesService.getScriptProperties().getProperty('MAIL_REPLY_TO')||'luxe.party.com@gmail.com';GmailApp.sendEmail(guestEmail,'【LUXE PARTY TOKYO】VIPテーブル お申し込みありがとうございます',guestName+'様\n\nこの度はLUXE PARTY TOKYOへのお申し込み、誠にありがとうございます。\n以下の内容でVIPテーブルの仮予約を承りました。\n\n■ご予約内容\nイベント: '+evNameL+'\nテーブル: '+tNameL+' ('+tTypeL+')\n料金: ¥'+tPriceL.toLocaleString()+'（税込）\n\n■お支払いのご案内\n▼決済URL（有効期限：発行から24時間）\n'+strDataL.url+'\n\n期限を過ぎると決済URLが無効となり、予約は自動キャンセルとなります。\nお早めにお手続きください。\n\n■ご注意\n・本予約はキャンセル・返金不可となります。予めご了承の上でお申し込みください。\n・上限席数を超えるご入場をご希望の場合は、男性お一人につき5万円頂戴します。\n\n決済完了後、QRコード招待状をお送りします。\n\nLUXE PARTY TOKYO\n'+rtL,{name:'LUXE PARTY TOKYO',replyTo:rtL});}catch(eML){console.log('err:',eML);}
          return res({ok:true,guest_id:vGidL,checkout_url:strDataL.url,table_name:tNameL});
        }
        case 'createVipTransfer': {
          var vtsT=addVipTableIfNeeded(),vtTRows=vtsT.getRange(1,1,vtsT.getLastRow(),vtsT.getLastColumn()).getValues(),vtTH=vtTRows[0].map(function(c){return String(c).trim();});
          var tableIdT=body.table_id||'',tRowT=-1;
          for(var i=1;i<vtTRows.length;i++){if(String(vtTRows[i][vtTH.indexOf('table_id')])===tableIdT){tRowT=i;break;}}
          if(tRowT<0) return res({ok:false,message:'テーブルが見つかりません'});
          if(String(vtTRows[tRowT][vtTH.indexOf('status')])!=='available') return res({ok:false,message:'このテーブルはすでに予約済みです'});
          var vGidT='VIP-'+Date.now().toString(36).toUpperCase();
          var tNameT=String(vtTRows[tRowT][vtTH.indexOf('table_name')]||''),tTypeT=String(vtTRows[tRowT][vtTH.indexOf('table_type')]||''),tPriceT=Number(vtTRows[tRowT][vtTH.indexOf('price')]||0),evIdT=String(vtTRows[tRowT][vtTH.indexOf('event_id')]||'');
          var gNameT=body.name||'',gEmailT=body.email||'',gPhoneT=body.phone||'';
          var dlT=new Date(new Date().getTime()+5*24*60*60*1000),dlTStr=Utilities.formatDate(dlT,'Asia/Tokyo','yyyy年MM月dd日');
          var bankInfo=PropertiesService.getScriptProperties().getProperty('BANK_INFO')||'【お振込先】\nさわやか信用金庫 渋谷支店\n普通 No.1254947\n株式会社リュクス';
          var companyInfoT='【発行者情報】\n株式会社リュクス\n〒150-0041 東京都渋谷区神南1-23-14\nTel: 03-6892-7253\n担当: 池田隆史\n登録番号: T2011001152835';
          var evNameT='',evST=sheet('events');if(evST){var evRT=evST.getDataRange().getValues(),evHT=evRT[0].map(function(c){return String(c).trim();});for(var ei=1;ei<evRT.length;ei++){if(String(evRT[ei][evHT.indexOf('event_id')])===evIdT){evNameT=String(evRT[ei][evHT.indexOf('name')]||'');break;}}}
          vtsT.getRange(tRowT+1,vtTH.indexOf('status')+1).setValue('pending_payment');
          var cmT={reserved_by:gNameT,reserved_email:gEmailT,reserved_phone:gPhoneT,reserved_at:nowStr(),payment_method:'transfer',guest_id:vGidT,transfer_deadline:Utilities.formatDate(dlT,'Asia/Tokyo','yyyy-MM-dd')};
          Object.keys(cmT).forEach(function(k){var ci=vtTH.indexOf(k);if(ci>=0)vtsT.getRange(tRowT+1,ci+1).setValue(cmT[k]);});
          var vrsT=sheet('vip_reservations');if(!vrsT){vrsT=SS.insertSheet('vip_reservations');vrsT.appendRow(['reservation_id','table_id','event_id','table_name','table_type','name','email','phone','payment_method','status','transfer_deadline','confirmed_at','guest_id','reserved_at','notes']);}
          vrsT.appendRow(['RES-'+Date.now().toString(36).toUpperCase(),tableIdT,evIdT,tNameT,tTypeT,gNameT,gEmailT,gPhoneT,'transfer','pending_payment',Utilities.formatDate(dlT,'Asia/Tokyo','yyyy-MM-dd'),'',vGidT,nowStr(),'']);
          SpreadsheetApp.flush();
          try{var rtT=PropertiesService.getScriptProperties().getProperty('MAIL_REPLY_TO')||'luxe.party.com@gmail.com';GmailApp.sendEmail(gEmailT,'【LUXE PARTY TOKYO】VIPテーブル ご請求書',gNameT+'様\n\nこの度はLUXE PARTY TOKYOにお申し込みいただき、誠にありがとうございます。\n\n■ご請求内容\n請求先: '+gNameT+' 様\nイベント: '+evNameT+'\nテーブル: '+tNameT+' ('+tTypeT+')\n品目: 飲食代\n金額: ¥'+tPriceT.toLocaleString()+'（税込）\nお振込期限: '+dlTStr+'\n\n'+bankInfo+'\n振込金額: ¥'+tPriceT.toLocaleString()+'（税込）\n\n'+companyInfoT+'\n\n■ご注意\n・本予約はキャンセル・返金不可となります。予めご了承の上でお申し込みください。\n・上限席数を超えるご入場をご希望の場合は、男性お一人につき5万円頂戴します。\n\n期限までにご入金をお願いいたします。\nご入金確認後、QRコード招待状をお送りします。\n\nLUXE PARTY TOKYO\n'+rtT,{name:'LUXE PARTY TOKYO',replyTo:rtT});}catch(eTM){console.log('VIPtransfermail:',eTM);}
          return res({ok:true,guest_id:vGidT,table_name:tNameT,transfer_deadline:dlTStr});
        }
        case 'completeVipStripePayment': {
          var skCV=PropertiesService.getScriptProperties().getProperty('STRIPE_SECRET_KEY')||'';
          if(!skCV) return res({ok:false,message:'Stripe設定がありません'});
          var sessIdCV=body.session_id||'';if(!sessIdCV) return res({ok:false,message:'session_idが必要です'});
          var authCV=Utilities.base64Encode(skCV+':'),sessResCV=UrlFetchApp.fetch('https://api.stripe.com/v1/checkout/sessions/'+sessIdCV,{method:'get',headers:{'Authorization':'Basic '+authCV},muteHttpExceptions:true}),sessCV=JSON.parse(sessResCV.getContentText());
          if(sessCV.error) return res({ok:false,message:'Stripe: '+sessCV.error.message});
          if(sessCV.payment_status!=='paid') return res({ok:false,message:'決済が完了していません'});
          var metaCV=sessCV.metadata||{},guestIdCV=metaCV.guest_id||'',tableIdCV=metaCV.table_id||'',gNameCV=decodeURIComponent(metaCV.name||''),gEmailCV=sessCV.customer_email||'',amtCV=Number(metaCV.amount||0);
          var vtsCVS=addVipTableIfNeeded(),vtCVRows=vtsCVS.getRange(1,1,vtsCVS.getLastRow(),vtsCVS.getLastColumn()).getValues(),vtCVH=vtCVRows[0].map(function(c){return String(c).trim();});
          var tRowCV=-1;for(var i=1;i<vtCVRows.length;i++){if(String(vtCVRows[i][vtCVH.indexOf('table_id')])===tableIdCV||String(vtCVRows[i][vtCVH.indexOf('guest_id')])===guestIdCV){tRowCV=i;break;}}
          var tNameCV=tRowCV>=0?String(vtCVRows[tRowCV][vtCVH.indexOf('table_name')]||''):'',tTypeCV=tRowCV>=0?String(vtCVRows[tRowCV][vtCVH.indexOf('table_type')]||''):'',evIdCV=tRowCV>=0?String(vtCVRows[tRowCV][vtCVH.indexOf('event_id')]||''):'';
          if(tRowCV>=0){vtsCVS.getRange(tRowCV+1,vtCVH.indexOf('status')+1).setValue('confirmed');vtsCVS.getRange(tRowCV+1,vtCVH.indexOf('confirmed_at')+1).setValue(nowStr());}
          var vrsCVS=sheet('vip_reservations');if(vrsCVS&&vrsCVS.getLastRow()>1){var vrCV=vrsCVS.getRange(1,1,vrsCVS.getLastRow(),vrsCVS.getLastColumn()).getValues(),vrHCV=vrCV[0].map(function(c){return String(c).trim();});for(var j=1;j<vrCV.length;j++){if(String(vrCV[j][vrHCV.indexOf('guest_id')])===guestIdCV){vrsCVS.getRange(j+1,vrHCV.indexOf('status')+1).setValue('confirmed');vrsCVS.getRange(j+1,vrHCV.indexOf('confirmed_at')+1).setValue(nowStr());break;}}}
          SpreadsheetApp.flush();
          var evNameCV='',evSCV=sheet('events');if(evSCV){var evRCV=evSCV.getDataRange().getValues(),evHCV=evRCV[0].map(function(c){return String(c).trim();});for(var ei=1;ei<evRCV.length;ei++){if(String(evRCV[ei][evHCV.indexOf('event_id')])===evIdCV){evNameCV=String(evRCV[ei][evHCV.indexOf('name')]||'');break;}}}
          try{var rtCV=PropertiesService.getScriptProperties().getProperty('MAIL_REPLY_TO')||'luxe.party.com@gmail.com';var qrCV='https://luxepartycom.github.io/event-system/vip-ticket.html?id='+guestIdCV;GmailApp.sendEmail(gEmailCV,'【LUXE PARTY TOKYO】VIPご招待状 / QRコード',gNameCV+'様\n\nお支払いを確認いたしました。誠にありがとうございます。\nご予約が確定いたしました。\n\n■当日のご案内\n受付にて以下のQRコードをご提示ください。\nQRコードURL: '+qrCV+'\n\n本QRコードはご来場予定の各位にご共有いただけます。受付にて各自ご提示ください。\nご入場は購入席数を上限とさせていただきます。上限を超えるご入場をご希望の場合は、男性お一人につき5万円の追加料金が発生いたします。\n\n■ご注意\n・本予約はキャンセル・返金不可となります。\n・上限席数を超えるご入場をご希望の場合は、男性お一人につき5万円頂戴します。\n\nLUXE PARTY TOKYO\n'+rtCV,{name:'LUXE PARTY TOKYO',replyTo:rtCV});}catch(eCVMail){console.log('VIPconfirmmail:',eCVMail);}
          return res({ok:true,guest_id:guestIdCV,name:gNameCV,amount:amtCV,table_name:tNameCV,event_name:evNameCV});
        }
default: return res({ ok: false, message: '\u4e0d\u660e\u306aaction: ' + action });
    }
  } catch(err) { return res({ ok: false, message: err.message }); }
}


// ================================================================
// VIP システム
// ================================================================

// ── VIPテーブル一覧取得 ──────────────────────────────────────────
function getVipTables(eventId) {
  var s = sheet('vip_tables');
  if (!s) return [];
  var rows = s.getRange(1,1,s.getLastRow(),s.getLastColumn()).getValues();
  var h = rows[0].map(function(c){ return String(c).trim(); });
  var result = [];
  for (var i=1; i<rows.length; i++) {
    var r = rows[i];
    if (!eventId || String(r[h.indexOf('event_id')]) === String(eventId)) {
      var obj = {};
      h.forEach(function(k,j){ obj[k] = r[j]; });
      result.push(obj);
    }
  }
  return result;
}

// ── VIPテーブル追加 ─────────────────────────────────────────────
function addVipTableIfNeeded() {
  var s = sheet('vip_tables');
  var header = [
    'table_id','event_id','table_name','table_type',
    'capacity','price','status','reserved_by','reserved_email',
    'reserved_phone','reserved_at','payment_method',
    'transfer_deadline','confirmed_at','guest_id','notes'
  ];
  if (!s) {
    s = SS.insertSheet('vip_tables');
    s.appendRow(header);
    SpreadsheetApp.flush();
  } else if (s.getLastRow() < 1) {
    // シートが存在するが全行削除された場合、ヘッダーを復元
    s.appendRow(header);
    SpreadsheetApp.flush();
  }
  return s;
}

// ── VIP予約一覧取得 ─────────────────────────────────────────────
function getVipReservations(eventId) {
  var s = sheet('vip_reservations');
  if (!s) return [];
  var rows = s.getRange(1,1,s.getLastRow(),s.getLastColumn()).getValues();
  var h = rows[0].map(function(c){ return String(c).trim(); });

  // vip_tablesから価格マップを作成（table_id → price）
  var priceMap = {};
  var vts = sheet('vip_tables');
  if (vts) {
    var vtRows = vts.getRange(1,1,vts.getLastRow(),vts.getLastColumn()).getValues();
    var vtH = vtRows[0].map(function(c){ return String(c).trim(); });
    var tidI = vtH.indexOf('table_id');
    var prI  = vtH.indexOf('price');
    for (var k=1; k<vtRows.length; k++) {
      priceMap[String(vtRows[k][tidI])] = Number(vtRows[k][prI] || 0);
    }
  }

  var result = [];
  for (var i=1; i<rows.length; i++) {
    var r = rows[i];
    if (!eventId || String(r[h.indexOf('event_id')]) === String(eventId)) {
      var obj = {};
      h.forEach(function(k,j){ obj[k] = r[j]; });
      // 価格を補完
      obj.price = priceMap[String(obj.table_id)] || 0;
      result.push(obj);
    }
  }
  return result;
}

// ── 仮押さえ期限切れチェック（毎時トリガー推奨）──────────────────
function checkVipTransferDeadlines() {
  var s = sheet('vip_tables');
  var rs = sheet('vip_reservations');
  if (!s || !rs) return;

  var rows = s.getRange(1,1,s.getLastRow(),s.getLastColumn()).getValues();
  var h = rows[0].map(function(c){ return String(c).trim(); });

  var rCol = h.indexOf('reminder_sent_at');
  if (rCol < 0) {
    s.getRange(1, h.length + 1).setValue('reminder_sent_at');
    h.push('reminder_sent_at');
    rCol = h.length - 1;
    rows = s.getRange(1,1,s.getLastRow(),s.getLastColumn()).getValues();
  }

  var now = new Date();
  var replyTo = PropertiesService.getScriptProperties().getProperty('MAIL_REPLY_TO') || 'luxe.party.com@gmail.com';
  var bankInfo = PropertiesService.getScriptProperties().getProperty('BANK_INFO') || '《お振込先》\nさわやか信用金庫 渋谷支店\n普通 No.1254947\n株式会社リュクス';
  var adminEmails = vipGetAdminEmails_();

  for (var i = 1; i < rows.length; i++) {
    var row = rows[i];
    var status = String(row[h.indexOf('status')] || '');
    if (status !== 'stripe_pending' && status !== 'pending_payment') continue;

    var guestEmail = String(row[h.indexOf('reserved_email')] || '');
    var guestName  = String(row[h.indexOf('reserved_by')]    || '');
    var tableName  = String(row[h.indexOf('table_name')]     || '');
    var tableType  = String(row[h.indexOf('table_type')]     || '');
    var tableId    = String(row[h.indexOf('table_id')]       || '');
    var price      = Number(row[h.indexOf('price')]          || 0);
    var evId       = String(row[h.indexOf('event_id')]       || '');
    var reservedAt = row[h.indexOf('reserved_at')];
    var reminderSentAt = row[rCol];
    if (!reservedAt || !guestEmail) continue;

    var evName = vipGetEventName_(evId);
    var reservedAtDate = new Date(reservedAt);

    if (status === 'stripe_pending') {
      var finalDeadline = new Date(reservedAtDate.getTime() + 72 * 60 * 60 * 1000);
      var hoursSince = (now - reservedAtDate) / (1000 * 60 * 60);

      if (now >= finalDeadline) {
        s.getRange(i+1, h.indexOf('status')+1).setValue('available');
        vipClearReservationFields_(s, i+1, h);
        vipUpdateReservationsStatus_(rs, guestEmail, tableId, 'expired');
        vipNotifyAutoCancel_(guestEmail, guestName, evName, tableName, tableType, 'カード（Stripe）', replyTo, adminEmails, now);
      } else if (hoursSince >= 48 && !reminderSentAt) {
        var newUrl = vipCreateStripeSessionForReminder_(evId, evName, tableName, tableType, price, guestName, guestEmail);
        if (newUrl) {
          var fds = Utilities.formatDate(finalDeadline, 'Asia/Tokyo', 'yyyy年MM月dd日 HH:mm');
          try {
            vipSendStripeReminder_(guestEmail, guestName, evName, tableName, tableType, price, newUrl, fds, replyTo);
            s.getRange(i+1, rCol+1).setValue(nowStr());
          } catch(e) { console.log('Stripe reminder error:', e); }
        }
      }

    } else if (status === 'pending_payment') {
      var tdStr = String(row[h.indexOf('transfer_deadline')] || '');
      if (!tdStr) continue;
      var td = new Date(tdStr);
      td.setHours(23, 59, 59);

      if (now >= td) {
        s.getRange(i+1, h.indexOf('status')+1).setValue('available');
        vipClearReservationFields_(s, i+1, h);
        vipUpdateReservationsStatus_(rs, guestEmail, tableId, 'expired');
        vipNotifyAutoCancel_(guestEmail, guestName, evName, tableName, tableType, '銀行振込', replyTo, adminEmails, now);
      } else {
        var daysLeft = (td - now) / (1000 * 60 * 60 * 24);
        if (daysLeft <= 2 && !reminderSentAt) {
          var ddisplay = Utilities.formatDate(new Date(tdStr), 'Asia/Tokyo', 'yyyy年MM月dd日');
          try {
            vipSendTransferReminder_(guestEmail, guestName, evName, tableName, tableType, price, bankInfo, ddisplay, replyTo);
            s.getRange(i+1, rCol+1).setValue(nowStr());
          } catch(e) { console.log('Transfer reminder error:', e); }
        }
      }
    }
    SpreadsheetApp.flush();
  }
}

// ================================================================
// トリガー設定（GASエディタから一度だけ手動実行）
// 実行後はこの関数を再度呼ぶ必要はありません
// ================================================================
function setupVipTransferDeadlinesTrigger() {
  var targets = ['checkVipTransferDeadlines', 'sendVipDailySummary'];
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (targets.indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('checkVipTransferDeadlines').timeBased().everyHours(2).create();
  ScriptApp.newTrigger('sendVipDailySummary').timeBased().atHour(10).everyDays(1).create();
  console.log('トリガー設定完了: checkVipTransferDeadlines(2時間ごと) + sendVipDailySummary(毎朝10時)');
}

// ================================================================
// VIPテーブル初期登録（GASエディタから手動実行）
// 実行前にeventIdを正しいものに書き換えてください
// ================================================================

// ================================================================
// VIPテーブル初期登録（GASエディタから手動実行）
// ================================================================
function initVipTablesForEvent() {
  var eventId = 'EV-MP45BP13'; // ← 対象イベントIDに変更

  var tables = [
    { name:'S1', type:'Secret VIP',  capacity:5, price:500000 },
    { name:'S2', type:'Secret VIP',  capacity:4, price:300000 },
    { name:'S3', type:'Secret VIP',  capacity:5, price:500000 },
    { name:'V1', type:'VVIP',        capacity:4, price:300000 },
    { name:'V2', type:'VVIP',        capacity:4, price:300000 },
    { name:'V3', type:'VVIP',        capacity:5, price:300000 },
    { name:'V4', type:'VVIP',        capacity:5, price:300000 },
    { name:'V5', type:'VVIP',        capacity:5, price:300000 },
    { name:'V6', type:'VVIP',        capacity:5, price:300000 },
    { name:'G1', type:'GOLD VIP',    capacity:5, price:1000000 },
    { name:'G2', type:'GOLD VIP',    capacity:5, price:1000000 },
    { name:'D1', type:'Diamond VIP', capacity:7, price:1000000 },
  ];

  var s = addVipTableIfNeeded();
  var h = s.getRange(1,1,1,s.getLastColumn()).getValues()[0].map(function(c){ return String(c).trim(); });

  tables.forEach(function(t) {
    var tid = 'VT-' + Date.now().toString(36).toUpperCase() + '-' + t.name;
    Utilities.sleep(10);
    var row = h.map(function(k) {
      switch(k) {
        case 'table_id':   return tid;
        case 'event_id':   return eventId;
        case 'table_name': return t.name;
        case 'table_type': return t.type;
        case 'capacity':   return t.capacity;
        case 'price':      return t.price;
        case 'status':     return 'available';
        default:           return '';
      }
    });
    s.appendRow(row);
  });

  SpreadsheetApp.flush();
  Logger.log('VIPテーブル登録完了: ' + tables.length + '件');
  Logger.log('イベントID: ' + eventId);
}

// ── ステージングSSにテストデータを投入（GASエディタから手動実行） ──
// 本番SSには一切書き込まない。staging SS のみに vip_tables テストデータを追加する。
function seedStagingVipTables() {
  var stagingId = PropertiesService.getScriptProperties().getProperty('STAGING_SPREADSHEET_ID');
  if (!stagingId) {
    Logger.log('ERROR: STAGING_SPREADSHEET_ID が未設定。先に setupStagingSpreadsheet() を実行してください');
    return;
  }
  var stgSS  = SpreadsheetApp.openById(stagingId);
  var s      = stgSS.getSheetByName('vip_tables');
  var header = [
    'table_id','event_id','table_name','table_type',
    'capacity','price','status','reserved_by','reserved_email',
    'reserved_phone','reserved_at','payment_method',
    'transfer_deadline','confirmed_at','guest_id','notes'
  ];
  if (!s) { s = stgSS.insertSheet('vip_tables'); }
  // ヘッダー確保 + データ行をすべてクリア（べき等: 何度実行しても重複しない）
  if (s.getLastRow() < 1) {
    s.appendRow(header);
  } else if (s.getLastRow() > 1) {
    s.deleteRows(2, s.getLastRow() - 1);
  }
  var existH = s.getRange(1,1,1,s.getLastColumn()).getValues()[0].map(function(c){ return String(c).trim(); });

  var eventId = 'EV-MP45BP13';
  var tables = [
    { name:'S1', type:'Secret VIP',  capacity:5, price:500000 },
    { name:'S2', type:'Secret VIP',  capacity:4, price:300000 },
    { name:'S3', type:'Secret VIP',  capacity:5, price:500000 },
    { name:'V1', type:'VVIP',        capacity:4, price:300000 },
    { name:'V2', type:'VVIP',        capacity:4, price:300000 },
    { name:'V3', type:'VVIP',        capacity:5, price:300000 },
    { name:'V4', type:'VVIP',        capacity:5, price:300000 },
    { name:'V5', type:'VVIP',        capacity:5, price:300000 },
    { name:'V6', type:'VVIP',        capacity:5, price:300000 },
    { name:'G1', type:'GOLD VIP',    capacity:5, price:1000000 },
    { name:'G2', type:'GOLD VIP',    capacity:5, price:1000000 },
    { name:'D1', type:'Diamond VIP', capacity:7, price:1000000 },
  ];
  tables.forEach(function(t) {
    var tid = 'VT-STG-' + t.name;
    var row = existH.map(function(k) {
      switch(k) {
        case 'table_id':   return tid;
        case 'event_id':   return eventId;
        case 'table_name': return t.name;
        case 'table_type': return t.type;
        case 'capacity':   return t.capacity;
        case 'price':      return t.price;
        case 'status':     return 'available';
        default:           return '';
      }
    });
    s.appendRow(row);
  });
  SpreadsheetApp.flush();
  Logger.log('✅ Staging vip_tables 投入完了: ' + tables.length + '件 / イベント: ' + eventId);
}

// ================================================================
// VIP期限管理 ヘルパー関数群
// ================================================================

function vipGetAdminEmails_() {
  var s = PropertiesService.getScriptProperties().getProperty('VIP_ADMIN_EMAILS')
    || PropertiesService.getScriptProperties().getProperty('MAIL_REPLY_TO')
    || 'luxe.party.com@gmail.com';
  return s.split(',').map(function(e){ return e.trim(); }).filter(function(e){ return !!e; });
}

function vipGetEventName_(evId) {
  if (!evId) return '';
  var evS = sheet('events');
  if (!evS) return '';
  var rows = evS.getDataRange().getValues();
  var h = rows[0].map(function(c){ return String(c).trim(); });
  for (var i=1; i<rows.length; i++) {
    if (String(rows[i][h.indexOf('event_id')]) === evId) return String(rows[i][h.indexOf('name')] || '');
  }
  return '';
}

function vipClearReservationFields_(s, rowNum, h) {
  ['reserved_by','reserved_email','reserved_phone','reserved_at','payment_method',
   'transfer_deadline','guest_id','reminder_sent_at'].forEach(function(k) {
    var ci = h.indexOf(k);
    if (ci >= 0) s.getRange(rowNum, ci+1).setValue('');
  });
}

function vipUpdateReservationsStatus_(rs, guestEmail, tableId, newStatus) {
  if (!rs || rs.getLastRow() < 2) return;
  var rows = rs.getRange(1,1,rs.getLastRow(),rs.getLastColumn()).getValues();
  var h = rows[0].map(function(c){ return String(c).trim(); });
  for (var j=1; j<rows.length; j++) {
    var rowEmail   = String(rows[j][h.indexOf('email')]    || '');
    var rowTableId = String(rows[j][h.indexOf('table_id')] || '');
    var rowStatus  = String(rows[j][h.indexOf('status')]   || '');
    if ((rowEmail === guestEmail || rowTableId === tableId)
        && (rowStatus === 'stripe_pending' || rowStatus === 'pending_payment')) {
      rs.getRange(j+1, h.indexOf('status')+1).setValue(newStatus);
    }
  }
}

function vipNotifyAutoCancel_(guestEmail, guestName, evName, tableName, tableType, payMethod, replyTo, adminEmails, now) {
  var nowFmt = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy年MM月dd日 HH:mm');
  try {
    GmailApp.sendEmail(guestEmail, '【LUXE PARTY TOKYO】VIPテーブルご予約キャンセルのご連絡',
      guestName+'様\n\n誠に恐れながら、お支払い期限を過ぎましたため、VIPテーブルのご予約をキャンセルいたしました。\n\n改めてのご参加をご希望の場合は、お手数ですが再度お申し込みください。\n満席の場合はご期待に添えないこともございますが、ご了承ください。\n\nLUXE PARTY TOKYO\n'+replyTo,
      {name:'LUXE PARTY TOKYO', replyTo:replyTo});
  } catch(e) { console.log('cancel notify guest error:', e); }
  var opBody = '以下のVIP予約が期限切れにより自動キャンセルされました。\n\n'
    +'ゲスト: '+guestName+'\nメール: '+guestEmail+'\nイベント: '+evName
    +'\nテーブル: '+tableName+' ('+tableType+')\n支払い方法: '+payMethod
    +'\nキャンセル日時: '+nowFmt+'\n\nテーブルは「空き」に戻しました。';
  adminEmails.forEach(function(email) {
    try {
      GmailApp.sendEmail(email, '【VIP管理】自動キャンセル — '+guestName+' / '+tableName, opBody, {name:'LPT VIP管理'});
    } catch(e) { console.log('cancel notify admin error:', e); }
  });
}

function vipCreateStripeSessionForReminder_(evId, evName, tableName, tableType, price, guestName, guestEmail) {
  var sk = PropertiesService.getScriptProperties().getProperty('STRIPE_SECRET_KEY') || '';
  if (!sk) return null;
  var auth = Utilities.base64Encode(sk+':');
  var p = 'mode=payment&payment_method_types[0]=card'
    +'&line_items[0][price_data][currency]=jpy'
    +'&line_items[0][price_data][unit_amount]='+price
    +'&line_items[0][price_data][product_data][name]='+encodeURIComponent(evName+' VIP '+tableName+' 飲食代')
    +'&line_items[0][quantity]=1'
    +'&success_url='+encodeURIComponent('https://luxepartycom.github.io/event-system/vip-checkout.html?session_id={CHECKOUT_SESSION_ID}')
    +'&cancel_url='+encodeURIComponent('https://luxepartycom.github.io/event-system/')
    +'&customer_email='+encodeURIComponent(guestEmail)
    +'&metadata[event_id]='+evId
    +'&metadata[table_name]='+tableName
    +'&metadata[name]='+encodeURIComponent(guestName)
    +'&metadata[amount]='+price;
  try {
    var res = UrlFetchApp.fetch('https://api.stripe.com/v1/checkout/sessions', {
      method:'post',
      headers:{'Authorization':'Basic '+auth,'Content-Type':'application/x-www-form-urlencoded'},
      payload:p, muteHttpExceptions:true
    });
    var data = JSON.parse(res.getContentText());
    return data.error ? null : (data.url || null);
  } catch(e) { console.log('Stripe reminder session error:', e); return null; }
}

function vipSendStripeReminder_(guestEmail, guestName, evName, tableName, tableType, price, newUrl, finalDeadlineStr, replyTo) {
  GmailApp.sendEmail(guestEmail, '【LUXE PARTY TOKYO】VIPテーブル お支払いのご案内（再送）',
    guestName+'様\n\n先日お申し込みいただいたVIPテーブルの決済URLの有効期限が切れましたため、新しい決済URLをご案内いたします。\n\n■ご予約内容\nイベント: '+evName+'\nテーブル: '+tableName+' ('+tableType+')\n料金: ¥'+price.toLocaleString()+'（税込）\n\n■お支払いのご案内（最終期限：'+finalDeadlineStr+'）\n▼決済URL（有効期限：発行から24時間）\n'+newUrl+'\n\n最終期限までにお手続きがない場合、誠に恐れながらご予約をキャンセルいたします。\n\n■ご注意\n・本予約はキャンセル・返金不可となります。予めご了承の上でお申し込みください。\n・上限席数を超えるご入場をご希望の場合は、男性お一人につき5万円頂戴します。\n\n決済完了後、QRコード招待状をお送りします。\n\nLUXE PARTY TOKYO\n'+replyTo,
    {name:'LUXE PARTY TOKYO', replyTo:replyTo});
}

function vipSendTransferReminder_(guestEmail, guestName, evName, tableName, tableType, price, bankInfo, deadlineStr, replyTo) {
  GmailApp.sendEmail(guestEmail, '【LUXE PARTY TOKYO】VIPテーブル お振込期限のご案内',
    guestName+'様\n\nVIPテーブルのご予約について、お振込の確認ができておりません。\nお振込期限まで残り2日となっております。お早めにお手続きください。\n\n■ご予約内容\nイベント: '+evName+'\nテーブル: '+tableName+' ('+tableType+')\n料金: ¥'+price.toLocaleString()+'（税込）\n\n■お振込先\n'+bankInfo+'\n振込金額: ¥'+price.toLocaleString()+'（税込）\nお振込期限: '+deadlineStr+'\n\n期限を過ぎた場合、誠に恐れながらご予約をキャンセルいたします。\n\n■ご注意\n・本予約はキャンセル・返金不可となります。予めご了承の上でお申し込みください。\n・上限席数を超えるご入場をご希望の場合は、男性お一人につき5万円頂戴します。\n\nLUXE PARTY TOKYO\n'+replyTo,
    {name:'LUXE PARTY TOKYO', replyTo:replyTo});
}

// ================================================================
// VIP日次サマリー（毎朝10時 自動送信）
// ================================================================
function sendVipDailySummary() {
  var adminEmails = vipGetAdminEmails_();
  if (!adminEmails.length) return;
  var s = sheet('vip_tables');
  var today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd');
  if (!s || s.getLastRow() < 2) {
    adminEmails.forEach(function(email) {
      try { GmailApp.sendEmail(email, '【VIP管理】本日のVIP予約状況 '+today, 'VIP予約なし。', {name:'LPT VIP管理'}); } catch(e){}
    });
    return;
  }
  var rows = s.getRange(1,1,s.getLastRow(),s.getLastColumn()).getValues();
  var h = rows[0].map(function(c){ return String(c).trim(); });
  var now = new Date();

  var requireAction = [], stripePending = [], transferPending = [], confirmedList = [], cancelSoon = [];

  for (var i=1; i<rows.length; i++) {
    var status    = String(rows[i][h.indexOf('status')]     || '');
    var guestName = String(rows[i][h.indexOf('reserved_by')]|| '');
    var tableName = String(rows[i][h.indexOf('table_name')] || '');
    var evId      = String(rows[i][h.indexOf('event_id')]   || '');
    if (!status || !tableName) continue;
    var evName = vipGetEventName_(evId);

    if (status === 'stripe_pending') {
      var ra = new Date(rows[i][h.indexOf('reserved_at')]);
      var finalDl = new Date(ra.getTime() + 72*60*60*1000);
      var hLeft = (finalDl - now) / (1000*60*60);
      if (hLeft <= 24) {
        cancelSoon.push(guestName+' | '+tableName+' | カード未決済（約'+Math.round(hLeft)+'時間後キャンセル予定）');
      } else {
        stripePending.push(guestName+' | '+tableName+' | '+evName);
      }
    } else if (status === 'pending_payment') {
      var dlStr = String(rows[i][h.indexOf('transfer_deadline')] || '');
      if (!dlStr) continue;
      var dl = new Date(dlStr);
      var dLeft = (dl - now) / (1000*60*60*24);
      var dlDisp = Utilities.formatDate(dl, 'Asia/Tokyo', 'MM月dd日');
      if (dLeft <= 1) {
        requireAction.push(guestName+' | '+tableName+' | 振込期限: '+dlDisp+'（要確認）');
      } else {
        transferPending.push(guestName+' | '+tableName+' | 振込期限: '+dlDisp);
      }
    } else if (status === 'confirmed') {
      confirmedList.push(guestName+' | '+tableName+' | '+evName);
    }
  }

  var fmt = function(arr) {
    return arr.length ? arr.map(function(l){ return '  · '+l; }).join('\n') : '  なし';
  };
  var body = '■ 要対応：振込の入金確認（手動でconfirm操作が必要）\n'+fmt(requireAction)
    +'\n\n■ 未払い（Stripe決済待ち）\n'+fmt(stripePending)
    +'\n\n■ 未払い（振込待ち）\n'+fmt(transferPending)
    +'\n\n■ 確定済み（VIPテーブル）\n'+fmt(confirmedList)
    +'\n\n■ 本日キャンセル予定\n'+fmt(cancelSoon);

  adminEmails.forEach(function(email) {
    try {
      GmailApp.sendEmail(email, '【VIP管理】本日のVIP予約状況 '+today, body, {name:'LPT VIP管理'});
    } catch(e) { console.log('Daily summary error:', e); }
  });
}
