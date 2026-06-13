/**
 * 拼多多商品数据采集脚本
 * 功能：登录拼多多商家后台 -> 进入商品数据页面 -> 筛选30日数据 -> 按成交件数排序 -> 提取商品信息
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const COOKIES_DIR = path.join(__dirname, 'pdd-cookies');

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 加载Cookie
async function loadCookies(context, cookiePath) {
  if (!fs.existsSync(cookiePath)) return false;
  try {
    const cookies = JSON.parse(fs.readFileSync(cookiePath, 'utf-8'));
    if (cookies && cookies.length > 0) {
      await context.addCookies(cookies);
      console.log(`Cookie已加载: ${cookiePath}`);
      return true;
    }
  } catch (e) {
    console.log(`Cookie加载失败: ${e.message}`);
  }
  return false;
}

// 主函数
async function main() {
  const targetCount = parseInt(process.argv[2]) || 10;

  // 从临时文件读取店铺名（和抖店一样的方式）
  let shopNameArg = '';
  const shopNameFile = path.join(__dirname, 'current_shop.txt');
  try {
    if (fs.existsSync(shopNameFile)) {
      shopNameArg = fs.readFileSync(shopNameFile, 'utf-8').trim();
    }
  } catch (e) {}

  console.log('===========================================');
  console.log('拼多多商品数据采集脚本');
  console.log('===========================================');
  console.log(`店铺: ${shopNameArg}`);
  console.log(`目标数量: ${targetCount}`);

  // 确定Cookie路径
  let cookiePath = path.join(COOKIES_DIR, 'default.json');
  if (shopNameArg) {
    const safeName = shopNameArg.replace(/[\\/:*?"<>|]/g, '_');
    cookiePath = path.join(COOKIES_DIR, safeName + '.json');
  }
  console.log(`Cookie路径: ${cookiePath}`);

  if (!fs.existsSync(cookiePath)) {
    console.log('Cookie文件不存在，请先登录');
    process.exit(1);
  }

  const browser = await chromium.launch({
    headless: false,
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    args: ['--start-maximized', '--window-size=1920,1080']
  });

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 }
  });

  const page = await context.newPage();

  try {
    // 加载Cookie
    await loadCookies(context, cookiePath);

    // 先访问商家后台主页
    console.log('访问商家后台主页...');
    await page.goto('https://mms.pinduoduo.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(5000);

    // 检查是否需要登录
    if (page.url().includes('login') || page.url().includes('passport')) {
      console.log('未登录或Cookie已过期，当前URL:', page.url());
      process.exit(1);
    }
    console.log('已登录，当前URL:', page.url());

    // 直接访问商品数据页面（数据中心 > 商品数据）
    console.log('访问商品数据页面...');
    await page.goto('https://mms.pinduoduo.com/data-center/product-data', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(5000);
    console.log('当前URL:', page.url());

    // 点击30日筛选
    console.log('点击30日筛选...');
    try {
      const btn30 = await page.locator('text=30日').first();
      await btn30.click();
      console.log('已点击30日筛选');
      await sleep(3000);
    } catch (e) {
      console.log('点击30日失败:', e.message);
    }

    // 点击成交件数排序（降序）
    console.log('点击成交件数排序...');
    try {
      const header = await page.locator('text=成交件数').first();
      await header.click();
      console.log('已点击成交件数');
      await sleep(2000);
      // 再次点击确保降序
      await header.click();
      console.log('再次点击确保降序');
      await sleep(2000);
    } catch (e) {
      console.log('点击成交件数失败:', e.message);
    }

    // 提取商品数据
    console.log('提取商品数据...');
    const products = await page.evaluate((maxCount) => {
      const results = [];
      const rows = document.querySelectorAll('table tbody tr, .product-list-item, [class*="product-row"], [class*="item"]');

      for (const row of rows) {
        if (results.length >= maxCount) break;
        const text = row.innerText || '';
        const cells = row.querySelectorAll('td, [class*="cell"]');

        // 提取商品ID（通常是15-20位数字）
        const idMatch = text.match(/\b(\d{15,20})\b/);
        const productId = idMatch ? idMatch[1] : '';

        // 提取成交件数
        let salesCount = 0;
        const numbers = text.match(/\b(\d+)\b/g);
        if (numbers) {
          for (const num of numbers) {
            const n = parseInt(num);
            if (n > salesCount && n < 100000) {
              salesCount = n;
            }
          }
        }

        if (productId && salesCount > 0) {
          results.push({
            id: productId,
            salesCount: salesCount,
            rawText: text.substring(0, 200)
          });
        }
      }
      return results;
    }, targetCount);

    console.log(`\n提取到 ${products.length} 个商品:`);
    products.forEach((p, i) => {
      console.log(`  ${i+1}. ID: ${p.id}, 成交件数: ${p.salesCount}`);
    });

    // 保存结果到文件
    const resultFile = path.join(__dirname, 'pdd_products.json');
    fs.writeFileSync(resultFile, JSON.stringify(products, null, 2), 'utf-8');
    console.log(`\n结果已保存到: ${resultFile}`);

  } catch (e) {
    console.error('执行出错:', e.message);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main();
