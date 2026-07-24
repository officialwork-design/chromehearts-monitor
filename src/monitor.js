import { chromium } from '@playwright/test';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const CONFIG = {
  targetUrl: 'https://www.chromehearts.com/',
  statePath: 'state/state.json',
  screenshotPath: 'state/latest-homepage.png',
  timeoutMs: 45_000,
  maxNotifyItems: 12,
  timezone: 'Asia/Tokyo',
  viewport: { width: 1440, height: 1600 },
  userAgent:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ChromeHeartsMonitor/1.0 Safari/537.36',
  selectorsToIgnore: [
    'script',
    'style',
    'noscript',
    'iframe',
    '[data-testid="cookie-banner"]',
    '[id*="cookie" i]',
    '[class*="cookie" i]',
    '[id*="consent" i]',
    '[class*="consent" i]'
  ],
  // 誤検知フィルタ: 毎回入れ替わる無意味な要素を通知・比較から除外する。
  // ここに追加すれば、リンク/ボタン/見出し/重要テキスト/HTMLハッシュから取り除かれる。
  noisePatterns: [
    /accessibe\.com/i,
    /Screen-Reader Guide/i,
    /New window/i
  ],
  // アクセス遮断検知: bot対策・エラーページの兆候。検知したら「変化なし」ではなくエラーとして通知する。
  // 注意: 目に見えるテキスト（title + bodyText）のみを対象にする。HTML全体を対象にすると
  //       reCAPTCHAライブラリ等に含まれる "captcha" などに誤反応するため。
  //       単語単体（captcha 等）ではなく、遮断ページ特有のフレーズだけを使う。
  blockSignals: [
    /access denied/i,
    /attention required/i,          // Cloudflare
    /checking your browser/i,       // Cloudflare
    /just a moment\.\.\./i,         // Cloudflare
    /verify you are (a )?human/i,
    /unusual traffic/i,
    /request blocked/i,
    /you have been blocked/i,
    /pardon our interruption/i,     // HUMAN/PerimeterX
    /please enable (cookies|javascript) to continue/i
  ],
  // 本文がこの文字数未満なら、正常に読み込めていない（遮断の）可能性が高いとみなす。
  minBodyTextLength: 120
};

const REQUIRED_ENV = ['LINE_CHANNEL_ACCESS_TOKEN', 'LINE_USER_ID'];

async function main() {
  validateEnv();

  const previousState = await readPreviousState();
  const currentSnapshot = await captureSnapshot();
  const diff = buildDiff(previousState?.snapshot ?? null, currentSnapshot);

  const nextState = {
    version: 1,
    targetUrl: CONFIG.targetUrl,
    updatedAt: currentSnapshot.checkedAt,
    snapshot: currentSnapshot,
    lastDiff: diff,
    lastNotificationAt: diff.hasChanged && previousState?.snapshot ? currentSnapshot.checkedAt : previousState?.lastNotificationAt ?? null
  };

  await ensureDir(path.dirname(CONFIG.statePath));
  await fs.writeFile(CONFIG.statePath, `${JSON.stringify(nextState, null, 2)}\n`, 'utf8');

  if (!previousState?.snapshot) {
    console.log('Initial baseline saved. No LINE notification sent.');
    return;
  }

  if (!diff.hasChanged) {
    console.log('No change detected.');
    return;
  }

  const message = buildLineMessage(currentSnapshot, diff);
  await sendLineMessage(message);
  console.log('Change detected. LINE notification sent.');
}

function validateEnv() {
  const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

async function captureSnapshot() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: CONFIG.viewport,
    userAgent: CONFIG.userAgent,
    locale: 'en-US',
    timezoneId: CONFIG.timezone
  });

  try {
    const navResponse = await page.goto(CONFIG.targetUrl, {
      waitUntil: 'networkidle',
      timeout: CONFIG.timeoutMs
    });

    await dismissPossiblePopups(page);
    await page.waitForTimeout(2500);

    const title = await page.title();
    const url = page.url();

    const data = await page.evaluate((selectorsToIgnore) => {
      for (const selector of selectorsToIgnore) {
        document.querySelectorAll(selector).forEach((node) => node.remove());
      }

      const normalizeText = (value) => value.replace(/\s+/g, ' ').trim();
      const normalizeUrl = (value) => {
        if (!value) return '';
        try {
          return new URL(value, window.location.origin).href;
        } catch {
          return value;
        }
      };

      const links = Array.from(document.querySelectorAll('a[href]'))
        .map((a) => ({
          text: normalizeText(a.innerText || a.textContent || ''),
          href: normalizeUrl(a.getAttribute('href'))
        }))
        .filter((item) => item.href)
        .map((item) => `${item.text || '(no text)'} => ${item.href}`);

      const images = Array.from(document.querySelectorAll('img'))
        .map((img) => normalizeUrl(img.currentSrc || img.src || img.getAttribute('src') || ''))
        .filter(Boolean);

      const buttons = Array.from(document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]'))
        .map((button) => normalizeText(button.innerText || button.textContent || button.value || ''))
        .filter(Boolean);

      const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6'))
        .map((heading) => normalizeText(heading.innerText || heading.textContent || ''))
        .filter(Boolean);

      const bodyText = normalizeText(document.body?.innerText || '');
      const html = document.documentElement.outerHTML
        .replace(/\s+/g, ' ')
        .replace(/nonce="[^"]*"/gi, '')
        .replace(/data-[a-zA-Z0-9_-]+="[^"]*"/g, '')
        .trim();

      return { links, images, buttons, headings, bodyText, html };
    }, CONFIG.selectorsToIgnore);

    assertNotBlocked({
      status: navResponse ? navResponse.status() : 0,
      title,
      bodyText: data.bodyText,
      html: data.html
    });

    const screenshotBuffer = await page.screenshot({ fullPage: true });
    await ensureDir(path.dirname(CONFIG.screenshotPath));
    await fs.writeFile(CONFIG.screenshotPath, screenshotBuffer);

    const normalized = {
      title,
      url,
      links: stripNoise(uniqueSorted(data.links)),
      images: uniqueSorted(data.images),
      buttons: stripNoise(uniqueSorted(data.buttons)),
      headings: stripNoise(uniqueSorted(data.headings)),
      importantText: stripNoise(extractImportantText(data.bodyText)),
      htmlHash: sha256(stripNoiseFromText(data.html)),
      screenshotHash: sha256(screenshotBuffer.toString('base64'))
    };

    return {
      checkedAt: formatDate(new Date()),
      ...normalized,
      aggregateHash: sha256(JSON.stringify(normalized))
    };
  } finally {
    await browser.close();
  }
}

async function dismissPossiblePopups(page) {
  const labels = ['Accept', 'Accept All', 'I Agree', 'Agree', 'OK', 'Close', '×'];

  for (const label of labels) {
    try {
      const locator = page.getByText(label, { exact: true }).first();
      if (await locator.isVisible({ timeout: 1000 })) {
        await locator.click({ timeout: 1000 });
        await page.waitForTimeout(500);
        return;
      }
    } catch {
      // Ignore popup handling failures because the monitor must continue.
    }
  }
}

function buildDiff(previous, current) {
  if (!previous) {
    return {
      hasChanged: false,
      reason: 'INITIAL_BASELINE',
      addedLinks: [],
      removedLinks: [],
      addedImages: [],
      removedImages: [],
      addedButtons: [],
      removedButtons: [],
      addedHeadings: [],
      removedHeadings: [],
      addedImportantText: [],
      removedImportantText: [],
      htmlChanged: false,
      screenshotChanged: false,
      summary: 'Initial baseline saved.'
    };
  }

  const addedLinks = arrayDiff(current.links, previous.links);
  const removedLinks = arrayDiff(previous.links, current.links);
  const addedImages = arrayDiff(current.images, previous.images);
  const removedImages = arrayDiff(previous.images, current.images);
  const addedButtons = arrayDiff(current.buttons, previous.buttons);
  const removedButtons = arrayDiff(previous.buttons, current.buttons);
  const addedHeadings = arrayDiff(current.headings, previous.headings);
  const removedHeadings = arrayDiff(previous.headings, current.headings);
  const addedImportantText = arrayDiff(current.importantText, previous.importantText);
  const removedImportantText = arrayDiff(previous.importantText, current.importantText);
  const htmlChanged = current.htmlHash !== previous.htmlHash;
  const screenshotChanged = current.screenshotHash !== previous.screenshotHash;

  const hasChanged =
    addedLinks.length > 0 ||
    removedLinks.length > 0 ||
    addedImages.length > 0 ||
    removedImages.length > 0 ||
    addedButtons.length > 0 ||
    removedButtons.length > 0 ||
    addedHeadings.length > 0 ||
    removedHeadings.length > 0 ||
    addedImportantText.length > 0 ||
    removedImportantText.length > 0 ||
    htmlChanged ||
    screenshotChanged;

  const summaryParts = [];
  if (addedLinks.length || removedLinks.length) summaryParts.push(`links +${addedLinks.length}/-${removedLinks.length}`);
  if (addedImages.length || removedImages.length) summaryParts.push(`images +${addedImages.length}/-${removedImages.length}`);
  if (addedButtons.length || removedButtons.length) summaryParts.push(`buttons +${addedButtons.length}/-${removedButtons.length}`);
  if (addedHeadings.length || removedHeadings.length) summaryParts.push(`headings +${addedHeadings.length}/-${removedHeadings.length}`);
  if (addedImportantText.length || removedImportantText.length) summaryParts.push(`texts +${addedImportantText.length}/-${removedImportantText.length}`);
  if (htmlChanged) summaryParts.push('html changed');
  if (screenshotChanged) summaryParts.push('screenshot changed');

  return {
    hasChanged,
    reason: hasChanged ? 'CHANGED' : 'NO_CHANGE',
    addedLinks,
    removedLinks,
    addedImages,
    removedImages,
    addedButtons,
    removedButtons,
    addedHeadings,
    removedHeadings,
    addedImportantText,
    removedImportantText,
    htmlChanged,
    screenshotChanged,
    summary: summaryParts.join(' / ') || 'No change.'
  };
}

function buildLineMessage(snapshot, diff) {
  const lines = [];
  lines.push('【Chrome Hearts公式サイト監視】');
  lines.push('公式サイトに変化を検知しました。');
  lines.push('');
  lines.push(`検知時刻: ${snapshot.checkedAt}`);
  lines.push(`監視URL: ${CONFIG.targetUrl}`);
  lines.push(`現在URL: ${snapshot.url}`);
  lines.push('');
  lines.push('■ 変化概要');
  lines.push(diff.summary);
  lines.push('');

  appendSection(lines, '追加リンク', diff.addedLinks);
  appendSection(lines, '削除リンク', diff.removedLinks);
  appendSection(lines, '追加画像', diff.addedImages);
  appendSection(lines, '追加見出し', diff.addedHeadings);
  appendSection(lines, '追加ボタン/UI文言', diff.addedButtons);
  appendSection(lines, '追加重要テキスト候補', diff.addedImportantText);

  lines.push('■ 判断');
  lines.push('新作追加、商品導線変更、Magazine更新、トップUI変更の可能性があります。公式サイトを直接確認してください。');

  return lines.join('\n').slice(0, 4500);
}

function appendSection(lines, title, items) {
  if (!items?.length) return;
  lines.push(`■ ${title}`);
  items.slice(0, CONFIG.maxNotifyItems).forEach((item) => lines.push(`・${item}`));
  if (items.length > CONFIG.maxNotifyItems) {
    lines.push(`・他 ${items.length - CONFIG.maxNotifyItems} 件`);
  }
  lines.push('');
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

async function readPreviousState() {
  try {
    const raw = await fs.readFile(CONFIG.statePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function extractImportantText(bodyText) {
  const keywords = [
    'New',
    'New Arrivals',
    'Shop',
    'Jewelry',
    'Accessories',
    'Eyewear',
    'Apparel',
    'Shoes',
    'Fragrance',
    'Home Goods',
    'Magazine',
    'Featured',
    'Collection',
    'Chrome Hearts'
  ];

  const results = [];
  for (const keyword of keywords) {
    const regex = new RegExp(`.{0,60}${escapeRegExp(keyword)}.{0,60}`, 'gi');
    const matches = bodyText.match(regex) || [];
    results.push(...matches.map((item) => item.replace(/\s+/g, ' ').trim()));
  }
  return uniqueSorted(results);
}

function arrayDiff(a = [], b = []) {
  const bSet = new Set(b);
  return a.filter((item) => !bSet.has(item));
}

// 誤検知フィルタ: noisePatterns にマッチする項目を配列から除外する。
function stripNoise(items = []) {
  return items.filter((item) => !CONFIG.noisePatterns.some((re) => re.test(item)));
}

// 誤検知フィルタ（文字列版）: HTMLハッシュ計算前に、毎回変動する文字列を取り除く。
function stripNoiseFromText(text) {
  let out = String(text);
  for (const re of CONFIG.noisePatterns) {
    const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
    out = out.replace(new RegExp(re.source, flags), ' ');
  }
  return out.replace(/\s+/g, ' ').trim();
}

// アクセス遮断検知: bot対策・エラーページ・空ページを検知したら例外を投げる。
// 例外は main() の catch で捕捉され、「監視エラー」としてLINE通知される。
// これにより、遮断されたのに「変化なし」と誤認するのを防ぐ。
function assertNotBlocked({ status, title, bodyText, html }) {
  if (status && (status === 401 || status === 403 || status === 429 || status >= 500)) {
    throw new Error(
      `アクセス遮断の可能性: HTTP ${status} が返されました。bot対策またはサーバ側制限の可能性があります。`
    );
  }

  // 目に見えるテキストのみを対象にする（HTML全体はスキャンしない）。
  const haystack = `${title || ''}\n${bodyText || ''}`;
  const hit = CONFIG.blockSignals.find((re) => re.test(haystack));
  if (hit) {
    throw new Error(
      `アクセス遮断の可能性: ページ内容にbot対策/エラーの兆候（${hit}）を検知しました。`
    );
  }

  const length = bodyText ? bodyText.length : 0;
  if (length < CONFIG.minBodyTextLength) {
    throw new Error(
      `アクセス遮断の可能性: 本文が短すぎます（${length}文字 < ${CONFIG.minBodyTextLength}）。正常に読み込めていない可能性があります。`
    );
  }
}

function uniqueSorted(values = []) {
  return Array.from(new Set(values.filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatDate(date) {
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: CONFIG.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  })
    .format(date)
    .replaceAll('/', '-');
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

main().catch(async (error) => {
  console.error(error);

  if (process.env.LINE_CHANNEL_ACCESS_TOKEN && process.env.LINE_USER_ID) {
    try {
      await sendLineMessage([
        '【Chrome Hearts公式サイト監視エラー】',
        '監視処理でエラーが発生しました。',
        '',
        `時刻: ${formatDate(new Date())}`,
        `内容: ${error.message}`
      ].join('\n'));
    } catch (notifyError) {
      console.error('Failed to send error notification:', notifyError);
    }
  }

  process.exit(1);
});
