/**
 * 拼多多新账号登录脚本
 * 扫码登录后获取店铺名称并保存cookie
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const COOKIES_DIR = path.join(__dirname, 'pdd-cookies');
const LOGIN_URL = 'https://mms.pinduoduo.com/login/';

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  // 确保cookies目录存在
  if (!fs.existsSync(COOKIES_DIR)) {
    fs.mkdirSync(COOKIES_DIR, { recursive: true });
  }

  console.log('启动浏览器，准备登录拼多多...');

  const browser = await chromium.launch({
    headless: false,
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    args: ['--start-maximized', '--window-size=1920,1080']
  });

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 }
  });

  const page = await context.newPage();

  // 监听页面崩溃
  page.on('crash', () => {
    console.log('页面崩溃');
    process.exit(1);
  });

  await page.evaluate(() => {
    window.moveTo(0, 0);
    window.resizeTo(1920, 1080);
  });

  try {
    // 访问登录页
    console.log('访问拼多多登录页...');
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await sleep(5000);

    // 检查是否已登录（如果跳转到了后台页面）
    let isLoggedIn = await page.evaluate(() => {
      return window.location.href.includes('mms.pinduoduo.com') && !window.location.href.includes('/login');
    });

    if (!isLoggedIn) {
      console.log('请使用手机扫码登录拼多多商家后台...');
      console.log('等待扫码完成（超时10分钟）...');

      try {
        // 等待URL变化，表示登录成功
        await page.waitForFunction(() => {
          return window.location.href.includes('mms.pinduoduo.com') && !window.location.href.includes('/login');
        }, { timeout: 600000 });
        isLoggedIn = true;
        console.log('登录成功！');
      } catch (e) {
        console.log('等待超时，登录未完成');
        await browser.close();
        process.exit(1);
      }
    } else {
      console.log('已检测到登录状态');
    }

    await sleep(3000);

    // 获取店铺名称 - 直接从当前页面获取，不跳转
    console.log('获取店铺名称...');
    let shopName = '';

    // 从页面右上角获取店铺名
    shopName = await page.evaluate(() => {
      const allElements = [...document.querySelectorAll('span, a, div, p')];
      // 方法1: 找"规则中心"右边的元素
      let ruleRect = null;
      for (const el of allElements) {
        const text = el.innerText?.trim();
        if (text === '规则中心') {
          ruleRect = el.getBoundingClientRect();
          break;
        }
      }

      if (ruleRect) {
        const candidates = [];
        for (const el of allElements) {
          if (el.children.length > 2) continue;
          const text = el.textContent?.trim();
          const rect = el.getBoundingClientRect();
          if (text && text.length >= 2 && text.length <= 15 &&
              Math.abs(rect.top - ruleRect.top) < 25 &&
              rect.left > ruleRect.right + 5 &&
              rect.height > 10 && rect.height < 45 &&
              !text.includes('规则') && !text.includes('跨境') &&
              !text.includes('社区') && !text.includes('团购') &&
              !text.includes('消息') && !text.includes('帮助') &&
              !text.includes('客服') && !text.includes('退出')) {
            candidates.push({ text, left: rect.left });
          }
        }
        candidates.sort((a, b) => a.left - b.left);
        if (candidates.length > 0) return candidates[0].text;
      }

      // 方法2: 找页面标题或店铺名显示区域
      const titleEl = document.querySelector('h1, h2, .shop-name, [class*="shop-name"]');
      if (titleEl) {
        const text = titleEl.textContent?.trim();
        if (text && text.length >= 2 && text.length <= 15) return text;
      }

      return '';
    });

    if (!shopName || shopName.includes('退出') || shopName.includes('登录') || shopName.includes('逾期')) {
      console.log('无法自动获取店铺名称，使用默认名称');
      shopName = '未知拼多多店铺';
    }

    // 清理店铺名称：去掉"主账号"、"子账号"等后缀
    shopName = shopName.replace(/主账号$/, '').replace(/子账号$/, '').trim();

    console.log(`店铺名称: ${shopName}`);

    // 保存cookie
    const cookies = await context.cookies();
    const safeName = shopName.replace(/[\\/:*?"<>|]/g, '_');
    const cookiePath = path.join(COOKIES_DIR, `${safeName}.json`);
    fs.writeFileSync(cookiePath, JSON.stringify(cookies, null, 2));
    console.log(`Cookie已保存: ${cookiePath}`);
    // 使用stderr输出SHOP_NAME，避免stdout缓冲问题
    process.stderr.write(`SHOP_NAME:${safeName}\n`);

    await browser.close();
    process.exit(0);

  } catch (error) {
    console.error('登录出错:', error.message);
    await browser.close();
    process.exit(1);
  }
}

main();
