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

// 收集需要扫描的 frame 列表：主页面 + 所有 iframe（递归）
function collectFrames(page) {
  const frames = [page.mainFrame()];
  for (const f of page.frames()) {
    if (!frames.includes(f)) frames.push(f);
  }
  return frames;
}

// 点击"成交件数"表头进行排序（降序）
// 拼多多表头有 checkbox，点表头文字 = 切换勾选，不是排序
// 排序需要点击表头右侧的排序箭头/图标
async function clickSalesSort(page) {
  const mainFrame = page.mainFrame();

  // 最多重试3次（页面可能还没渲染好表头）
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // 第一步：找到包含"成交件数"文字的表头 th，点击右侧（避开checkbox）
      const sortResult = await mainFrame.evaluate(() => {
        const ths = [...document.querySelectorAll('table thead th')];
        for (const th of ths) {
          const text = (th.innerText || '').trim();
          if (!text.includes('成交件数')) continue;

          const rect = th.getBoundingClientRect();

          // 策略1：找表头内的排序图标（SVG、箭头、排序相关 class）
          const sortIcons = th.querySelectorAll('svg, [class*="sort"], [class*="arrow"], [class*="icon"], i, em');
          if (sortIcons.length > 0) {
            sortIcons[sortIcons.length - 1].click();
            return { method: 'icon', count: sortIcons.length };
          }

          // 策略2：点击表头文字区域的右侧（避开左侧的 checkbox）
          const textEls = [...th.querySelectorAll('span, label, a, div')];
          for (const el of textEls) {
            const elText = (el.innerText || '').trim();
            if (elText === '成交件数') {
              const elRect = el.getBoundingClientRect();
              const clickX = elRect.left + elRect.width * 0.8;
              const clickY = elRect.top + elRect.height / 2;
              const target = document.elementFromPoint(clickX, clickY);
              if (target) { target.click(); return { method: 'text-right', x: Math.round(clickX) }; }
            }
          }

          // 策略3：点击表头 th 的右半部分
          const clickX = rect.left + rect.width * 0.8;
          const clickY = rect.top + rect.height / 2;
          const target = document.elementFromPoint(clickX, clickY);
          if (target) { target.click(); return { method: 'th-right', x: Math.round(clickX) }; }

          return { method: 'none' };
        }
        return { method: 'not_found' };
      }).catch((e) => ({ method: 'error', msg: e.message }));

      console.log(`[主页面] 成交件数排序结果(第${attempt}次): ${JSON.stringify(sortResult)}`);

      if (sortResult.method !== 'not_found' && sortResult.method !== 'error' && sortResult.method !== 'none') {
        await sleep(2000);
        // 再次点击确保降序
        await mainFrame.evaluate(() => {
          const ths = [...document.querySelectorAll('table thead th')];
          for (const th of ths) {
            if (!(th.innerText || '').includes('成交件数')) continue;
            const rect = th.getBoundingClientRect();
            const clickX = rect.left + rect.width * 0.8;
            const clickY = rect.top + rect.height / 2;
            const target = document.elementFromPoint(clickX, clickY);
            if (target) { target.click(); return true; }
          }
          return false;
        }).catch(() => {});
        console.log('[主页面] 再次点击成交件数排序(确保降序)');
        return; // 成功则退出
      }

      if (sortResult.method === 'error') {
        console.log(`[主页面] 排序失败，重试... (${attempt}/3)`);
        await sleep(2000);
        continue;
      }
      // not_found 或 none：不再重试
      break;
    } catch (e) {
      console.log(`[主页面] 排序异常(第${attempt}次): ${e.message}`);
      await sleep(2000);
    }
  }
  console.log('未成功点击"成交件数"排序');
}

// 取消勾选指定列的 checkbox
// 拼多多表头每个 th 里有 checkbox 控制列显示/隐藏
async function uncheckColumns(page, columnNames) {
  const frames = collectFrames(page);
  for (const frame of frames) {
    try {
      if (!frame.url() && frame !== page.mainFrame()) continue;
    } catch (e) { continue; }
    const scope = frame === page.mainFrame() ? '主页面' : 'iframe';

    const result = await frame.evaluate((names) => {
      const unchecked = [];
      const ths = [...document.querySelectorAll('table thead th')];
      if (ths.length === 0) return { unchecked, thCount: 0, reason: 'no_th' };

      for (const th of ths) {
        const text = (th.innerText || '').trim();
        for (const name of names) {
          if (text.includes(name) && !unchecked.includes(name)) {
            // PDD 用自定义 DIV checkbox，class 含 CBX/textWrapper/prevCheckSquare
            // 按可靠性顺序尝试多种选择器
            const selectors = [
              'input[type="checkbox"]',     // 标准 checkbox
              '[class*="CBX"]',             // PDD 自定义 checkbox 容器
              '[class*="textWrapper"]',     // PDD 文字包装器（带勾选功能）
              '[class*="prevCheckSquare"]', // PDD 勾选方块
              '[class*="checkbox"]',        // 通用 checkbox class
              '[role="checkbox"]'           // ARIA 角色
            ];
            let clicked = false;
            for (const sel of selectors) {
              const cb = th.querySelector(sel);
              if (cb) {
                const rect = cb.getBoundingClientRect();
                if (rect.width > 0) {
                  cb.click();
                  unchecked.push(name + '(' + sel + ')');
                  clicked = true;
                  break;
                }
              }
            }
            if (!clicked) {
              // 最后兜底：点击 th 本身（PDD 表头整列可点击切换）
              th.click();
              unchecked.push(name + '(th点击)');
            }
            break;
          }
        }
      }
      return { unchecked, thCount: ths.length };
    }, columnNames).catch(() => ({ unchecked: [], thCount: 0, reason: 'error' }));

    console.log(`[${scope}] 取消勾选结果: th总数=${result.thCount}, 结果=${JSON.stringify(result.unchecked)}`);
    return; // 只处理第一个有表头的 frame
  }
}

// 提取商品数据：遍历主页面 + 所有 iframe，兼容 table / div-table
async function extractPddProducts(page, maxCount) {
  const frames = collectFrames(page);
  const results = [];
  const seenIds = new Set();

  for (const frame of frames) {
    if (results.length >= maxCount) break;
    try {
      if (!frame.url() && frame !== page.mainFrame()) continue;
    } catch (e) { continue; }

    const scope = frame === page.mainFrame() ? '主页面' : 'iframe';

    const data = await frame.evaluate((limit) => {
      const out = [];

      // 收集表头单元格（table 优先，其次 div-table）
      let headerCells = [...document.querySelectorAll('table thead th, table thead td')];
      let rowType = 'table';
      let rows = [...document.querySelectorAll('table tbody tr')];
      if (headerCells.length === 0 || rows.length === 0) {
        headerCells = [...document.querySelectorAll('[class*="table"] [class*="head"] [class*="cell"], [class*="thead"] [class*="cell"], [class*="header-row"] [class*="col"]')];
        rows = [...document.querySelectorAll('[class*="table"] [class*="body"] [class*="row"], [class*="tbody"] [class*="row"]')];
        rowType = 'div-table';
      }

      const headerTexts = headerCells.map(h => (h.innerText || '').trim());

      // 按列名找到表头 th 的水平中心X
      function headerCenterX(keyword) {
        for (const h of headerCells) {
          if ((h.innerText || '').trim().includes(keyword)) {
            const r = h.getBoundingClientRect();
            return r.left + r.width / 2;
          }
        }
        return null;
      }

      const salesHeaderX = headerCenterX('成交件数');

      // 给定行的一个 td，算它离表头目标列中心的水平距离
      function distToHeaderX(td, targetX) {
        const r = td.getBoundingClientRect();
        return Math.abs((r.left + r.width / 2) - targetX);
      }

      // 从行的 td 列表中找离目标表头列最近的那个 td
      function findCellForHeader(tds, targetX) {
        let best = null, bestDist = Infinity;
        for (const td of tds) {
          const r = td.getBoundingClientRect();
          if (r.width <= 0) continue;
          const d = distToHeaderX(td, targetX);
          if (d < bestDist) { bestDist = d; best = td; }
        }
        return best;
      }

      for (const row of rows) {
        if (out.length >= limit) break;
        const rowText = (row.innerText || '').trim();
        if (!rowText || rowText.length < 5) continue;

        // 收集行的数据 cell（td，排除 measure-row 占位行和窄cell如勾选框）
        const tds = [...row.querySelectorAll('td')].filter(c => {
          const r = c.getBoundingClientRect();
          // 宽度>60 排除勾选框/序号等窄cell，这些cell的centerX会错误匹配到"成交件数"
          return r.width > 60 && r.height > 0;
        });
        if (tds.length === 0) continue;

        // ---- 成交件数：找离"成交件数"表头列最近的 td ----
        // PDD数值单元格格式是"较前30日245"——"较前30日"是环比说明，最后一个数字才是真实值
        let salesCount = 0;
        if (salesHeaderX !== null) {
          const salesTd = findCellForHeader(tds, salesHeaderX);
          if (salesTd) {
            const text = (salesTd.innerText || '').replace(/,/g, '');
            // 取所有数字，取最后一个（跳过"较前30日"里的30）
            const nums = text.match(/\d+/g);
            if (nums && nums.length > 0) salesCount = parseInt(nums[nums.length - 1]);
          }
        }

        // ---- 商品ID：从行文本提取 ----
        let productId = '';
        const m = rowText.match(/ID[\s:：]*(\d{10,20})/) || rowText.match(/\b(\d{10,20})\b/);
        if (m) productId = m[1];

        // ---- 商品图片：行内第一张有效图 ----
        let imageUrl = '';
        for (const td of tds) {
          const img = td.querySelector('img');
          if (img) {
            const src = img.src || img.getAttribute('data-src') || '';
            const w = img.getBoundingClientRect().width;
            if (src && !src.startsWith('data:') && w >= 20) { imageUrl = src; break; }
          }
        }

        if (productId && salesCount > 0) {
          out.push({ id: productId, salesCount: salesCount, imageUrl: imageUrl, rowType: rowType });
        }
      }

      return {
        products: out,
        meta: {
          rowType,
          rowCount: rows.length,
          headerCount: headerCells.length,
          cellCount: rows.length > 0 ? rows[0].querySelectorAll('td').length : 0,
          headerTexts,
          salesHeaderX: salesHeaderX ? Math.round(salesHeaderX) : null,
          // 调试：第一行每个td到"成交件数"表头的距离（含宽度，用于核对过滤）
          firstRowDebug: (function () {
            const first = rows[0];
            if (!first || salesHeaderX === null) return [];
            const allTds = [...first.querySelectorAll('td')].filter(c => {
              const r = c.getBoundingClientRect();
              return r.width > 0 && r.height > 0;
            });
            return allTds.map(td => {
              const r = td.getBoundingClientRect();
              const cx = Math.round(r.left + r.width / 2);
              const dist = Math.abs(cx - Math.round(salesHeaderX));
              const used = r.width > 60 ? 'Y' : 'N';
              return { text: (td.innerText || '').trim().substring(0, 15), w: Math.round(r.width), cx, distToSales: dist, used };
            });
          })()
        }
      };
    }, maxCount).catch((e) => {
      console.log(`[${scope}] 提取异常: ${e.message}`);
      return { products: [], meta: {} };
    });

    console.log(`[${scope}] 行数=${data.meta.rowCount || 0} 表头列数=${data.meta.headerCount || 0} 行cell数=${data.meta.cellCount || 0}`);
    console.log(`[${scope}] 表头=${JSON.stringify(data.meta.headerTexts || [])}`);
    console.log(`[${scope}] 成交件数表头X=${data.meta.salesHeaderX || '?'}`);
    if (data.meta.firstRowDebug && data.meta.firstRowDebug.length > 0) {
      console.log(`[${scope}] 第一行所有td(Y=用于匹配, N=被过滤):`);
      for (const td of data.meta.firstRowDebug) {
        console.log(`  [${td.used}] w=${td.w} cx=${td.cx} dist=${td.distToSales} "${td.text}"`);
      }
    }

    for (const p of data.products) {
      if (results.length >= maxCount) break;
      if (!seenIds.has(p.id)) {
        seenIds.add(p.id);
        results.push(p);
      }
    }
  }

  return results;
}

// 翻页：点击"下一页"按钮，返回是否成功翻页
async function clickNextPage(page) {
  const mainFrame = page.mainFrame();

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const clicked = await mainFrame.evaluate(() => {
        // 策略1：找包含"下一页"文字的按钮/a/span
        const elements = [...document.querySelectorAll('a, button, span, div')];
        for (const el of elements) {
          const text = (el.innerText || '').trim();
          if (text === '下一页') {
            // 检查是否可点击（没有 disabled 样式）
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            const isDisabled = style.pointerEvents === 'none' ||
                               style.opacity === '0' ||
                               el.classList.contains('disabled') ||
                               el.hasAttribute('disabled');
            if (rect.width > 0 && rect.height > 0 && !isDisabled) {
              el.click();
              return { method: 'text', disabled: false };
            }
            return { method: 'text', disabled: true };
          }
        }

        // 策略2：找分页组件中的"下一页"图标（通常在分页器末尾的箭头/chevron）
        const paginations = [...document.querySelectorAll('[class*="pagination"], [class*="pager"], [class*="Pagination"], [class*="Pager"]')];
        for (const pg of paginations) {
          // 找分页器中的最后一个可点击项
          const items = [...pg.querySelectorAll('a, button, span, li')];
          for (let i = items.length - 1; i >= Math.max(0, items.length - 3); i--) {
            const el = items[i];
            const text = (el.innerText || '').trim();
            // 跳过页码数字，只找箭头类
            if (/^\d+$/.test(text)) continue;
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              const style = window.getComputedStyle(el);
              const isDisabled = style.pointerEvents === 'none' ||
                                 style.opacity === '0' ||
                                 el.classList.contains('disabled');
              if (!isDisabled) {
                el.click();
                return { method: 'pagination-icon' };
              }
              return { method: 'pagination-icon', disabled: true };
            }
          }
        }

        // 策略3：找 ant-design / 普通分页组件的 next 按钮
        const nextBtn = document.querySelector('.ant-pagination-next:not(.ant-pagination-disabled), [aria-label="Next"], [aria-label="下一页"]');
        if (nextBtn) {
          nextBtn.click();
          return { method: 'aria' };
        }

        return { method: 'not_found' };
      }).catch((e) => ({ method: 'error', msg: e.message }));

      if (clicked.disabled) {
        console.log(`[翻页] "下一页"按钮已禁用，说明是最后一页`);
        return false;
      }
      if (clicked.method !== 'not_found' && clicked.method !== 'error') {
        console.log(`[翻页] 点击下一页成功 (策略: ${clicked.method})`);
        await sleep(3000);
        return true;
      }
      if (clicked.method === 'error') {
        console.log(`[翻页] 翻页异常，重试... (${attempt}/3)`);
        await sleep(2000);
        continue;
      }
      // not_found
      break;
    } catch (e) {
      console.log(`[翻页] 翻页异常(${attempt}/3): ${e.message}`);
      await sleep(2000);
    }
  }
  console.log('[翻页] 未找到"下一页"按钮');
  return false;
}

// 落盘诊断信息：记录所有 frame、表格结构、表头，便于提取为空时排查
async function dumpPddDebug(page, foundCount) {
  const frames = collectFrames(page);
  const debug = { timestamp: new Date().toISOString(), foundCount: foundCount || 0, frames: [] };

  for (const frame of frames) {
    let url = '';
    try { url = frame.url(); } catch (e) { url = '[无法获取URL]'; }
    const entry = { isMain: frame === page.mainFrame(), url, tables: 0, iframes: 0, sampleText: '' };
    try {
      const info = await frame.evaluate(() => ({
        tableCount: document.querySelectorAll('table').length,
        tbodyRowCount: document.querySelectorAll('table tbody tr').length,
        divRowCount: document.querySelectorAll('[class*="table"] [class*="body"] [class*="row"], [class*="tbody"] [class*="row"]').length,
        iframeCount: document.querySelectorAll('iframe').length,
        headerTexts: [...document.querySelectorAll('table thead th, table thead td')].map(t => (t.innerText || '').trim()),
        bodyTextSnippet: (document.body.innerText || '').substring(0, 300)
      }));
      Object.assign(entry, info);
    } catch (e) {
      entry.error = e.message;
    }
    debug.frames.push(entry);
  }

  try {
    fs.writeFileSync(path.join(__dirname, 'pdd-debug.json'), JSON.stringify(debug, null, 2), 'utf-8');
    console.log('诊断信息已保存: pdd-debug.json');
  } catch (e) {
    console.log('保存诊断信息失败:', e.message);
  }
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
      // 输出统一过期标记，供前端自动化检测（与抖店脚本一致）
      if (shopNameArg) {
        console.log(`COOKIE_EXPIRED:${shopNameArg}`);
        try {
          const markerFile = path.join(__dirname, 'cookie_expired.txt');
          fs.writeFileSync(markerFile, shopNameArg);
          console.log('已写入cookie过期标记文件');
        } catch (e) {}
      }
      process.exit(1);
    }
    console.log('已登录，当前URL:', page.url());

    // 通过左侧菜单点击进入商品数据页面
    console.log('点击左侧菜单"商品数据"...');
    try {
      // 等待菜单加载
      await sleep(3000);
      // 点击"商品数据"菜单项
      const menuItem = page.locator('text=商品数据').first();
      await menuItem.waitFor({ timeout: 10000 });
      await menuItem.click();
      console.log('已点击"商品数据"菜单');
      await sleep(5000);
      console.log('当前URL:', page.url());
    } catch (e) {
      console.log('点击菜单失败，尝试直接访问URL:', e.message);
      await page.goto('https://mms.pinduoduo.com/data-center/product-data', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(5000);
      console.log('当前URL:', page.url());
    }

    // 点击30日筛选（页面有两个，要点下面那个）
    console.log('点击30日筛选...');
    try {
      // 使用JavaScript找到所有30日按钮并点击下面那个
      const clicked = await page.evaluate(() => {
        const elements = [...document.querySelectorAll('*')];
        const btns = elements.filter(el => {
          const text = el.textContent?.trim();
          return text === '30日' && el.children.length === 0; // 只找叶子节点
        });
        console.log('找到30日按钮:', btns.length);
        if (btns.length >= 2) {
          // 点击第二个（下面那个）
          btns[1].click();
          return true;
        } else if (btns.length === 1) {
          btns[0].click();
          return true;
        }
        return false;
      });
      if (clicked) {
        console.log('已点击30日筛选');
        await sleep(3000);
      } else {
        console.log('未找到30日按钮');
      }
    } catch (e) {
      console.log('点击30日失败:', e.message);
    }

    // 取消勾选"商品访客数"和"商品浏览量"列（缩小表格宽度，减少干扰列）
    console.log('取消勾选"商品访客数"和"商品浏览量"...');
    await uncheckColumns(page, ['商品访客数', '商品浏览量']);
    await sleep(2000);

    // 点击成交件数排序（降序）
    // 拼多多后台内容可能在主页面，也可能在 iframe 内，需要遍历所有 frame
    console.log('点击成交件数排序...');
    await clickSalesSort(page);
    await sleep(3000);

    // 截图保存当前页面状态
    await page.screenshot({ path: path.join(__dirname, 'pdd-product-data.png'), fullPage: true });
    console.log('已截图: pdd-product-data.png');

    // 提取商品数据（遍历主页面 + 所有 iframe，支持翻页）
    console.log('提取商品数据...');
    let allProducts = [];
    let pageNum = 1;
    let maxPages = 50; // 安全上限，防止死循环

    while (allProducts.length < targetCount && pageNum <= maxPages) {
      console.log(`\n--- 第 ${pageNum} 页 (已收集 ${allProducts.length}/${targetCount}) ---`);
      let products = await extractPddProducts(page, targetCount - allProducts.length);

      // 如果当前页没提取到数据，先落盘诊断信息，再多等几秒重试一次
      if (products.length === 0) {
        console.log(`第${pageNum}页首次提取为空，等待5秒后重试...`);
        await dumpPddDebug(page);
        await sleep(5000);
        products = await extractPddProducts(page, targetCount - allProducts.length);
      }

      if (products.length > 0) {
        // 去重合并
        const seenIds = new Set(allProducts.map(p => p.id));
        for (const p of products) {
          if (!seenIds.has(p.id) && allProducts.length < targetCount) {
            seenIds.add(p.id);
            allProducts.push(p);
          }
        }
        console.log(`第${pageNum}页提取 ${products.length} 个商品，累计 ${allProducts.length} 个`);
      } else {
        console.log(`第${pageNum}页无商品数据，停止翻页`);
        break;
      }

      // 如果还没达到目标数量，尝试翻页
      if (allProducts.length < targetCount) {
        const hasMore = await clickNextPage(page);
        if (!hasMore) {
          console.log('没有更多页面，停止翻页');
          break;
        }
      }

      pageNum++;
    }

    // 落盘诊断信息（含本次提取到的数量，便于排查）
    await dumpPddDebug(page, allProducts.length);

    console.log(`\n提取到 ${allProducts.length} 个商品:`);
    allProducts.forEach((p, i) => {
      const imgFlag = p.imageUrl ? '有图' : '无图';
      console.log(`  ${i+1}. ID: ${p.id}, 成交件数: ${p.salesCount}, ${imgFlag}`);
    });

    // 保存结果到文件
    const resultFile = path.join(__dirname, 'pdd_products.json');
    fs.writeFileSync(resultFile, JSON.stringify(allProducts, null, 2), 'utf-8');
    console.log(`\n结果已保存到: ${resultFile}`);

  } catch (e) {
    console.error('执行出错:', e.message);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main();
