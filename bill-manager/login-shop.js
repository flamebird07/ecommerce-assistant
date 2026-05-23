/**
 * 抖店新账号登录脚本
 * 扫码登录后获取店铺名称并保存cookie
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const COOKIES_DIR = path.join(__dirname, 'cookies');
const LOGIN_URL = 'https://fxg.jinritemai.com/ffa/mshop/homepage/index';

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('启动浏览器，准备扫码登录...');

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

  let browserClosed = false;

  try {
    // 访问登录页
    console.log('访问抖店登录页...');
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await sleep(5000);

    // 检查是否已登录
    let isLoggedIn = await page.evaluate(() => {
      return window.location.href.includes('fxg.jinritemai.com/ffa/mshop/homepage');
    });

    if (!isLoggedIn) {
      console.log('请使用抖音App扫码登录...');
      console.log('等待扫码完成（超时10分钟）...');

      try {
        await page.waitForFunction(() => {
          return window.location.href.includes('fxg.jinritemai.com/ffa/mshop/homepage');
        }, { timeout: 600000 });
        isLoggedIn = true;
        console.log('登录成功！');
      } catch (e) {
        console.log('等待超时，登录未完成');
        if (!browserClosed) {
          await browser.close();
        }
        process.exit(1);
      }
    } else {
      console.log('已检测到登录状态');
    }

    await sleep(5000);

    // 获取店铺名称
    console.log('获取店铺名称...');
    let shopName = await page.evaluate(() => {
      // 方法1: 查找右上角店铺名称元素 (top < 250, left > 1200)
      const allElements = document.querySelectorAll('*');
      for (const el of allElements) {
        const text = el.innerText?.trim();
        const rect = el.getBoundingClientRect();
        // 店铺名称特征: 在页面右侧上部，字体较大，文字较短
        if (text && text.length >= 2 && text.length <= 20 &&
            rect.left > 1200 && rect.top > 100 && rect.top < 250 &&
            rect.width > 50 && rect.height > 20 && rect.height < 60 &&
            !text.includes('退出') && !text.includes('登录') &&
            !text.includes('消息') && !text.includes('首页')) {
          return text.split('\n')[0].trim();
        }
      }
      return '';
    });

    if (!shopName) {
      // 方法2: 从店铺主页URL获取
      const url = page.url();
      console.log('当前URL:', url);
    }

    if (!shopName || shopName.includes('排行') || shopName.includes('退出')) {
      // 方法3: 截图区域分析 - 查找右侧区域文字
      await page.screenshot({ path: 'shop-name-check.png' });
      // 从compass页面获取
      await page.goto('https://compass.jinritemai.com/shop', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(8000);
      shopName = await page.evaluate(() => {
        // 查找所有可能的店铺名称元素
        const elements = document.querySelectorAll('[class*="shop"], [class*="name"], [class*="brand"], span, div');
        for (const el of elements) {
          const text = el.innerText?.trim();
          const rect = el.getBoundingClientRect();
          if (text && text.length >= 2 && text.length <= 15 &&
              rect.left > 1400 && rect.top > 50 && rect.top < 200 &&
              rect.width > 30 && rect.height > 15 && rect.height < 50) {
            return text;
          }
        }
        return '';
      });
    }

    if (!shopName || shopName.includes('排行') || shopName.includes('退出') || shopName.includes('登录')) {
      shopName = '未知店铺';
    }

    console.log(`店铺名称: ${shopName}`);

    // 保存cookie
    const cookies = await context.cookies();
    const safeName = shopName.replace(/[\\/:*?"<>|]/g, '_');
    const cookiePath = path.join(COOKIES_DIR, `${safeName}.json`);
    fs.writeFileSync(cookiePath, JSON.stringify(cookies, null, 2));
    console.log(`Cookie已保存: ${cookiePath}`);
    console.log(`SHOP_NAME:${safeName}`);

    await browser.close();
    process.exit(0);

  } catch (error) {
    console.error('登录出错:', error.message);
    await browser.close();
    process.exit(1);
  }
}

main();
