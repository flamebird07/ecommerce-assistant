const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const COOKIES_DIR = path.join(__dirname, 'cookies');
const COOKIE_FILE = path.join(COOKIES_DIR, '瑾漂亮高定私服.json');

(async () => {
  const browser = await chromium.launch({
    headless: false,
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    args: ['--start-maximized', '--window-size=1920,1080']
  });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  
  console.log('访问抖店登录页...');
  await page.goto('https://fxg.jinritemai.com/ffa/mshop/homepage/index', { waitUntil: 'domcontentloaded', timeout: 120000 });
  
  console.log('请在浏览器中切换到瑾漂亮高定私服店铺，或扫码登录...');
  console.log('等待最多10分钟...');
  
  let loggedIn = false;
  for (let i = 0; i < 120; i++) {
    await new Promise(r => setTimeout(r, 5000));
    try {
      const url = page.url();
      if (url.includes('mshop/homepage') && !url.includes('login')) {
        loggedIn = true;
        console.log('检测到登录状态，保存Cookie...');
        const cookies = await context.cookies();
        fs.writeFileSync(COOKIE_FILE, JSON.stringify(cookies, null, 2));
        console.log('Cookie已保存到:', COOKIE_FILE);
        console.log('LOGIN_SUCCESS');
        break;
      }
    } catch (e) {
      // page可能已关闭
    }
  }
  
  if (!loggedIn) {
    console.log('LOGIN_TIMEOUT');
  }
  
  await browser.close();
  console.log('浏览器已关闭');
})();
