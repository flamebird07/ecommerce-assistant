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
    // 先截图并打印右上角所有元素，用于调试
    await page.screenshot({ path: 'debug-shop-name.png', timeout: 10000 });
    const candidates = await page.evaluate(() => {
      const allElements = document.querySelectorAll('*');
      const results = [];
      for (const el of allElements) {
        const text = el.innerText?.trim();
        const rect = el.getBoundingClientRect();
        // 收集右上角区域的所有文本元素
        if (text && text.length >= 2 && text.length <= 20 &&
            rect.left > 1200 && rect.top > 100 && rect.top < 250 &&
            rect.width > 0 && rect.height > 0) {
          results.push({
            text: text.split('\n')[0].trim(),
            left: Math.round(rect.left),
            top: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            tag: el.tagName
          });
        }
      }
      return results;
    });
    console.log('右上角候选元素:', candidates.length, '个');

    let shopName = await page.evaluate(() => {
      const allElements = document.querySelectorAll('*');
      const excludeKeywords = ['退出', '登录', '消息', '首页', '近7天', '近30天', '近90天',
        '筛选', '导出', '下载', '刷新', '搜索', '设置', '帮助', '反馈',
        '天', '日', '周', '月', '年', '排序', '筛选条件',
        '大促', '活动', '优惠', '促销', '折扣', '满减', '券',
        '待发货', '待付款', '已完成', '已取消', '退款',
        '订单', '商品', '客服', '财务', '店铺', '营销',
        '直播', '短视频', '达人', '联盟', '数据中心'];

      for (const el of allElements) {
        const text = el.innerText?.trim();
        const rect = el.getBoundingClientRect();
        if (text && text.length >= 2 && text.length <= 20 &&
            rect.left > 1200 && rect.top > 100 && rect.top < 250 &&
            rect.width > 50 && rect.height > 20 && rect.height < 60) {
          const shouldExclude = excludeKeywords.some(kw => text.includes(kw));
          if (!shouldExclude) {
            return text.split('\n')[0].trim();
          }
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
