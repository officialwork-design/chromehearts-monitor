const REQUIRED_ENV = ['LINE_CHANNEL_ACCESS_TOKEN', 'LINE_USER_ID'];

function validateEnv() {
  const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
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
  const response = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      to: process.env.LINE_USER_ID,
      messages: [{ type: 'text', text }]
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`LINE notification failed. HTTP ${response.status}: ${body}`);
  }
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
