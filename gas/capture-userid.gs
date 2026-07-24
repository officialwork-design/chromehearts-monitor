/**
 * LINE userId 取得用の一時的なGAS Webアプリ。
 *
 * 使い方:
 *  1. GASで新規プロジェクトを作り、このファイルの内容を貼り付けて保存。
 *  2. 「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」
 *       - 次のユーザーとして実行: 自分
 *       - アクセスできるユーザー: 全員
 *     でデプロイし、発行される「ウェブアプリのURL（.../exec）」をコピー。
 *  3. LINE Developersコンソール → 対象の Messaging API チャネル
 *     （= 監視で使っている LINE_CHANNEL_ACCESS_TOKEN と同じチャネル）
 *     → 「Messaging API設定」→ Webhook URL に 2 のURLを貼り、「Webhookの利用」をオン。
 *  4. 通知を受け取りたい人それぞれに、そのLINE公式アカウントを友だち追加してもらい、
 *     トークで何かメッセージを1通送ってもらう。
 *  5. GASエディタの「実行数」またはログ、もしくは showCapturedUserIds() を実行して
 *     取得できた userId（Uで始まる文字列）を確認。
 *  6. 取得した userId を GitHub の Secrets「LINE_USER_IDS」に
 *     カンマ区切りで登録（例: Uxxxx...,Uyyyy...）。
 *  7. 確認が済んだら、LINE側のWebhook利用をオフに戻し、このデプロイは削除してよい。
 *
 * 注意: Webhook URL を設定するチャネルは、監視で使っているチャネルと必ず同一にすること。
 *       チャネルが違うと取得した userId では通知が届かない。
 */

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var events = body.events || [];
    var found = [];

    for (var i = 0; i < events.length; i++) {
      var source = events[i].source || {};
      if (source.userId) {
        found.push(source.userId);
      }
    }

    if (found.length > 0) {
      var props = PropertiesService.getScriptProperties();
      var existing = props.getProperty('CAPTURED_USER_IDS');
      var set = {};
      (existing ? existing.split(',') : []).forEach(function (id) {
        if (id) set[id] = true;
      });
      found.forEach(function (id) {
        set[id] = true;
      });
      var merged = Object.keys(set);
      props.setProperty('CAPTURED_USER_IDS', merged.join(','));
      Logger.log('Captured userId: ' + found.join(', '));
      Logger.log('All captured so far: ' + merged.join(', '));
    }
  } catch (err) {
    Logger.log('doPost error: ' + err);
  }

  // LINEには常に200を返す。
  return ContentService.createTextOutput(
    JSON.stringify({ ok: true })
  ).setMimeType(ContentService.MimeType.JSON);
}

/**
 * 取得済みの userId を確認する。GASエディタでこの関数を実行し、ログを見る。
 */
function showCapturedUserIds() {
  var ids = PropertiesService.getScriptProperties().getProperty('CAPTURED_USER_IDS');
  Logger.log(ids ? ids : '(まだ取得できていません。友だち追加後にメッセージを送ってもらってください)');
  return ids;
}

/**
 * 取得済みリストをリセットしたいとき用。
 */
function clearCapturedUserIds() {
  PropertiesService.getScriptProperties().deleteProperty('CAPTURED_USER_IDS');
  Logger.log('CAPTURED_USER_IDS を削除しました。');
}
