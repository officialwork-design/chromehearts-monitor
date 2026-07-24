const REQUIRED_ENV = ['LINE_CHANNEL_ACCESS_TOKEN'];

function validateEnv() {
  const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  if (getRecipients().length === 0) {
    throw new Error(
      '通知先が未設定です。LINE_USER_IDS（カンマ区切りで複数可）または LINE_USER_ID を設定してください。'
    );
  }
}

// 通知先のuserIdを取得（monitor.js と同じ仕様）。
// LINE_USER_IDS（カンマ/空白/改行区切り）を優先し、旧 LINE_USER_ID も後方互換で受け付ける。
function getRecipients() {
  const raw = [process.env.LINE_USER_IDS, process.env.LINE_USER_ID].filter(Boolean).join(',');
  const ids = raw
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
  return Array.from(new Set(ids));
}

function formatDate(date) {
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(date).replaceAll('/', '-');
}

async function sendLineMessage(text) {
  const recipients = getRecipients();
  if (recipients.length === 0) {
    throw new Error('LINE通知先のuserIdがありません。');
  }

  // 1人ならPush API、2人以上ならMulticast API。
  const isMulticast = recipients.length > 1;
  const endpoint = isMulticast
    ? 'https://api.line.me/v2/bot/message/multicast'
    : 'https://api.line.me/v2/bot/message/push';
  const payload = isMulticast
    ? { to: recipients, messages: [{ type: 'text', text }] }
    : { to: recipients[0], messages: [{ type: 'text', text }] };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`LINE notification failed. HTTP ${response.status}: ${body}`);
  }

  console.log(`LINE test notification sent to ${recipients.length} recipient(s).`);
}

async function main() {
  validateEnv();

  await sendLineMessage([
    '【Chrome Hearts監視BOT テスト通知】',
    'LINE通知の疎通確認に成功しました。',
    '',
    `送信時刻: ${formatDate(new Date())}`,
    '監視URL: https://www.chromehearts.com/',
    '',
    'この通知が届いていれば、GitHub Actions から LINE Push 通知まで正常です。'
  ].join('\n'));

  console.log('LINE test notification sent.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
