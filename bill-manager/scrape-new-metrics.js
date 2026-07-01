/**
 * 抖店商品列表数据采集脚本
 * 功能：动态检测列索引，采集发货后退款率和投放消耗
 * 支持分页采集所有页面数据
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const COOKIES_DIR = path.join(__dirname, 'cookies');
const COOKIE_FILE = path.join(COOKIES_DIR, '瑾漂亮潮流服饰.json');

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function loadCookies(context) {
  if (!fs.existsSync(COOKIE_FILE)) {
    throw new Error(`Cookie文件不存在: ${COOKIE_FILE}`);
  }
  const cookies = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf-8'));
  await context.addCookies(cookies);
  console.log('Cookie已加载');
}

async function scrapeProductMetrics() {
  const browser = await chromium.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: false,
    args: ['--start-maximized', '--window-size=1920,1080'],
    viewport: { width: 1920, height: 1080 }
  });

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 }
  });
  const page = await context.newPage();

  try {
    await loadCookies(context);

    // 导航到商品列表页
    const productUrl = 'https://compass.jinritemai.com/shop/commodity/product-list';
    console.log(`正在访问: ${productUrl}`);
    await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // 等待页面稳定
    console.log('等待页面加载...');
    await page.waitForSelector('.ecom-table-row', { timeout: 30000 });
    await page.waitForTimeout(5000);

    // 检查是否需要登录
    if (page.url().includes('login') || page.url().includes('sso')) {
      throw new Error('Cookie已过期，请重新登录获取Cookie');
    }

    // 点击"近30天"按钮切换到30天数据（带重试逻辑）
    const MAX_NAV_RETRIES = 3;
    let thirtyDayClicked = false;

    for (let navAttempt = 1; navAttempt <= MAX_NAV_RETRIES; navAttempt++) {
      console.log(`点击"近30天"按钮... (尝试 ${navAttempt}/${MAX_NAV_RETRIES})`);

      // 如果是重试，重新导航到页面
      if (navAttempt > 1) {
        console.log('重新导航到商品列表页...');
        await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForSelector('.ecom-table-row', { timeout: 30000 });
        await page.waitForTimeout(5000);
      }

      let clicked = false;
      try {
        const thirtyDayBtn = page.locator('text=近30天').first();
        await thirtyDayBtn.waitFor({ timeout: 20000 });
        await thirtyDayBtn.click({ timeout: 20000 });
        clicked = true;
        console.log('点击了"近30天"按钮');
      } catch (e1) {
        console.log('策略1失败:', e1.message);
        try {
          const thirtyDayBtn2 = page.locator('button:has-text("近30天")').first();
          await thirtyDayBtn2.waitFor({ timeout: 20000 });
          await thirtyDayBtn2.click({ timeout: 20000 });
          clicked = true;
          console.log('策略2成功点击了"近30天"按钮');
        } catch (e2) {
          console.log('策略2也失败:', e2.message);
          try {
            const dateDropdown = page.locator('[class*="date"], [class*="picker"], [class*="select"]').filter({ hasText: /天|日/ }).first();
            await dateDropdown.waitFor({ timeout: 10000 });
            await dateDropdown.click();
            await page.waitForTimeout(2000);
            const thirtyDayInDropdown = page.locator('text=近30天').first();
            await thirtyDayInDropdown.waitFor({ timeout: 10000 });
            await thirtyDayInDropdown.click();
            clicked = true;
            console.log('策略3成功点击了"近30天"按钮');
          } catch (e3) {
            console.log('策略3也失败:', e3.message);
            try {
              const sevenDayBtn = page.locator('text=7天').first();
              await sevenDayBtn.waitFor({ timeout: 10000 });
              await sevenDayBtn.click();
              await page.waitForTimeout(2000);
              const thirtyDayAfterClick = page.locator('text=近30天').first();
              await thirtyDayAfterClick.waitFor({ timeout: 10000 });
              await thirtyDayAfterClick.click();
              clicked = true;
              console.log('策略4成功点击了"近30天"按钮');
            } catch (e4) {
              console.log('策略4也失败:', e4.message);
            }
          }
        }
      }

      if (!clicked) {
        console.log(`第 ${navAttempt} 次尝试：所有点击策略均失败`);
        if (navAttempt < MAX_NAV_RETRIES) {
          console.log('等待后重试...');
          await page.waitForTimeout(10000);
        }
        continue;
      }

      // 验证"近30天"是否已激活
      console.log('验证"近30天"是否已激活...');
      await page.waitForTimeout(3000);

      let verified = false;
      try {
        verified = await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('*')).filter(el => el.innerText?.trim() === '近30天');
          for (const btn of btns) {
            const classes = (btn.className || '').toLowerCase();
            const parentClasses = (btn.parentElement?.className || '').toLowerCase();
            if (classes.includes('active') || classes.includes('selected') || classes.includes('checked') ||
                parentClasses.includes('active') || parentClasses.includes('selected') || parentClasses.includes('checked') ||
                btn.getAttribute('aria-selected') === 'true' || btn.getAttribute('aria-pressed') === 'true') {
              return true;
            }
          }
          // 检查页面是否显示"近7天"（说明没切过去）
          const has7Day = Array.from(document.querySelectorAll('*')).some(el => {
            const text = el.innerText?.trim();
            return text === '近7天' && el.children.length === 0;
          });
          // 如果页面上没有"近7天"文本，可能已经切到30天了
          return !has7Day;
        });
      } catch (e) {
        console.log('验证按钮状态出错:', e.message);
      }

      if (verified) {
        console.log('验证通过："近30天"已激活');
        thirtyDayClicked = true;
        break;
      }

      // 验证未通过，等待10秒后重新点击
      console.log('验证未通过："近30天"未激活，等待10秒后重新点击...');
      await page.waitForTimeout(10000);

      // 再次尝试点击
      try {
        const retryBtn = page.locator('text=近30天').first();
        await retryBtn.click({ timeout: 10000 });
        console.log('重新点击了"近30天"按钮');
        await page.waitForTimeout(3000);
      } catch (e) {
        console.log('重新点击失败:', e.message);
      }

      if (navAttempt < MAX_NAV_RETRIES) {
        console.log('等待后重试整个流程...');
        await page.waitForTimeout(10000);
      }
    }

    if (!thirtyDayClicked) {
      throw new Error('点击"近30天"按钮失败（已重试' + MAX_NAV_RETRIES + '次），停止执行以避免获取错误的7天数据');
    }

    // 等待30天数据加载
    console.log('等待30天数据加载...');
    await page.waitForTimeout(60000);

    // 验证是否成功切换到30天数据
    console.log('验证是否已切换到30天数据...');
    const currentUrl = page.url();
    const urlHas30Days = currentUrl.includes('30') || currentUrl.includes('range=30') || currentUrl.includes('dateType=30');
    let btnIsActive = false;
    try {
      const thirtyDayBtn = page.locator('text=近30天').first();
      btnIsActive = await thirtyDayBtn.evaluate(el => {
        // 检查按钮是否处于激活/选中状态
        const classes = el.className || '';
        const parentClasses = el.parentElement?.className || '';
        return classes.includes('active') || classes.includes('selected') || classes.includes('checked') ||
               parentClasses.includes('active') || parentClasses.includes('selected') || parentClasses.includes('checked') ||
               el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-pressed') === 'true' ||
               getComputedStyle(el).fontWeight >= 600 || // 激活按钮通常更粗
               getComputedStyle(el).backgroundColor !== 'transparent'; // 激活按钮可能有背景色
      });
    } catch (e) {
      console.log('检查按钮状态失败:', e.message);
    }
    if (!urlHas30Days && !btnIsActive) {
      // 截图保存以便调试
      await page.screenshot({ path: path.join(__dirname, 'debug-30day-verify-failed.png') }).catch(() => {});
      throw new Error('验证失败：未能确认已切换到30天数据视图。URL不含30天参数，且"近30天"按钮未处于激活状态。停止执行以避免采集错误的7天数据。');
    }
    console.log('验证通过：已确认切换到30天数据视图');

    const allProducts = [];
    let pageNum = 1;

    while (true) {
      console.log(`\n正在采集第 ${pageNum} 页数据...`);

      // 等待表格加载
      await page.waitForSelector('.ecom-table-row', { timeout: 15000 });
      await page.waitForTimeout(2000);

      // 滚动到底部以触发虚拟滚动加载所有行
      console.log('滚动加载所有行...');
      let lastRowCount = 0;
      let stableCount = 0;
      for (let scrollAttempt = 0; scrollAttempt < 50; scrollAttempt++) {
        const currentRowCount = await page.evaluate(() => document.querySelectorAll('.ecom-table-row').length);

        if (currentRowCount === lastRowCount) {
          stableCount++;
          if (stableCount >= 3) break; // 连续3次行数不变，认为已加载完毕
        } else {
          stableCount = 0;
        }
        lastRowCount = currentRowCount;

        await page.evaluate(() => {
          const container = document.querySelector('.ecom-table-body') || document.querySelector('[class*="table-body"]') || document.querySelector('.arco-table-body');
          if (container) container.scrollTop = container.scrollHeight;
          else window.scrollTo(0, document.body.scrollHeight);
        });
        await page.waitForTimeout(1500);
      }
      console.log(`滚动完成，当前共 ${lastRowCount} 行`);

      // 动态检测列索引并提取当前页数据
      const pageData = await page.evaluate(() => {
        const results = [];

        // 扫描表头，动态获取列索引
        const headerCells = document.querySelectorAll('.ecom-table-header .ecom-table-cell, .ecom-table thead th, [class*="table-header"] [class*="cell"]');
        let nameIdx = -1;
        let refundIdx = -1;
        let adIdx = -1;

        for (let i = 0; i < headerCells.length; i++) {
          const headerText = headerCells[i]?.innerText?.trim() || '';
          if (headerText.includes('商品名称') || headerText.includes('商品')) {
            nameIdx = i;
          }
          if (headerText.includes('发货后退款率') || headerText.includes('退款率')) {
            refundIdx = i;
          }
          if (headerText.includes('投放消耗') || headerText.includes('投放')) {
            adIdx = i;
          }
        }

        // 记录未找到的列
        const warnings = [];
        if (nameIdx === -1) warnings.push('未找到"商品名称"列');
        if (refundIdx === -1) warnings.push('未找到"发货后退款率"列');
        if (adIdx === -1) warnings.push('未找到"投放消耗"列');
        if (warnings.length > 0) {
          console.warn('列检测警告:', warnings.join(', '));
        }

        const rows = document.querySelectorAll('.ecom-table-row');
        for (const row of rows) {
          const cells = row.querySelectorAll('.ecom-table-cell');
          if (cells.length === 0) continue;

          const nameCell = nameIdx >= 0 ? (cells[nameIdx]?.innerText?.trim() || '') : '';

          // 发货后退款率（值如 '24.38%10.47%'，第一个数字是退款率）
          let refundRate = '';
          if (refundIdx >= 0 && cells[refundIdx]) {
            const refundRaw = cells[refundIdx]?.innerText?.trim() || '';
            const refundMatch = refundRaw.match(/([\d.]+)%/);
            refundRate = refundMatch ? refundMatch[1] + '%' : refundRaw;
          }

          // 投放消耗（值如 '¥8.90171.34%'，第一个数字是消耗金额）
          let adSpend = '';
          if (adIdx >= 0 && cells[adIdx]) {
            const adRaw = cells[adIdx]?.innerText?.trim() || '';
            const adMatch = adRaw.match(/[¥￥]?([\d.]+)/);
            adSpend = adMatch ? '¥' + adMatch[1] : adRaw;
          }

          if (nameCell) {
            results.push({
              商品名称: nameCell,
              发货后退款率: refundRate,
              投放: adSpend
            });
          }
        }

        return { warnings, results };
      });

      // 输出列检测警告
      if (pageData.warnings && pageData.warnings.length > 0) {
        console.warn(`第 ${pageNum} 页列检测警告:`, pageData.warnings.join(', '));
      }

      const pageResults = pageData.results;

      console.log(`第 ${pageNum} 页采集到 ${pageResults.length} 条数据`);
      pageResults.forEach((r, i) => {
        console.log(`  ${i + 1}. ${r.商品名称} | 退款率: ${r.发货后退款率} | 投放: ${r.投放}`);
      });

      allProducts.push(...pageResults);

      // 检查是否有下一页
      const hasNext = await page.evaluate(() => {
        // 查找翻页按钮
        const nextBtn = document.querySelector('.arco-pagination-next:not([disabled]), [class*="pagination"] [class*="next"]:not([disabled]), button[aria-label="next"]:not([disabled])');
        if (nextBtn && !nextBtn.disabled) {
          // 检查是否被禁用
          const isDisabled = nextBtn.classList.contains('disabled') ||
                            nextBtn.getAttribute('aria-disabled') === 'true' ||
                            nextBtn.closest('[class*="disabled"]') !== null;
          return !isDisabled;
        }
        return false;
      });

      if (!hasNext) {
        console.log('\n已到达最后一页，采集完成');
        break;
      }

      // 点击下一页
      console.log('翻到下一页...');
      await page.click('.arco-pagination-next, [class*="pagination"] [class*="next"], button[aria-label="next"]');
      await sleep(3000);
      pageNum++;
    }

    console.log(`\n========== 采集完成 ==========`);
    console.log(`共采集 ${allProducts.length} 条商品数据`);
    console.log(JSON.stringify(allProducts, null, 2));

    // 保存结果到文件
    const outputPath = path.join(__dirname, 'scrape-metrics-result.json');
    fs.writeFileSync(outputPath, JSON.stringify(allProducts, null, 2));
    console.log('结果已保存到:', outputPath);

    return allProducts;

  } catch (error) {
    console.error('采集失败:', error.message);
    // 截图保存以便调试
    await page.screenshot({ path: path.join(__dirname, 'debug-scrape-metrics.png') }).catch(() => {});
    throw error;
  } finally {
    await browser.close();
  }
}

// 运行脚本
scrapeProductMetrics().catch(error => {
  console.error('脚本执行失败:', error);
  process.exit(1);
});

module.exports = { scrapeProductMetrics };
