/**
 * 拼多多商品数据采集脚本
 * 功能：登录拼多多商家后台 -> 进入商品数据页面 -> 筛选30日数据 -> 按成交件数排序 -> 提取商品信息
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const COOKIES_DIR = path.join(__dirname, 'pdd-cookies');

// ===== 调试开关 =====
// 调试期间设为 true：脚本执行完后浏览器保持打开，便于人工检查最后的页面状态
// 调试完成后改回 false
const DEBUG = true;

// 飞书API配置
const FEISHU_CONFIG = {
  app_id: 'cli_a91ad5ae63385bc9',
  app_secret: 'ga7Gn6pBJgUkftKY2JEpFe3TJFpB2Mun',
  app_token: 'CfAXbSrUFaBLv3stSRrcuUVon1b',
  table_id: 'tbl7PuVUnnFJJeBM'  // 5号表格：网店商品列表
};

let _feishuToken = null;
let _feishuTokenTime = 0;

// 获取飞书Token
async function getFeishuToken() {
  const now = Date.now();
  if (_feishuToken && (now - _feishuTokenTime) < 7000 * 1000) {
    return _feishuToken;
  }
  const response = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: FEISHU_CONFIG.app_id, app_secret: FEISHU_CONFIG.app_secret })
  });
  const data = await response.json();
  if (data.tenant_access_token) {
    _feishuToken = data.tenant_access_token;
    _feishuTokenTime = now;
    return _feishuToken;
  }
  throw new Error('获取飞书Token失败');
}

// 上传图片到飞书
async function uploadImageToFeishu(accessToken, imageUrl) {
  try {
    // 下载图片
    const imageResponse = await fetch(imageUrl);
    if (!imageResponse.ok) {
      console.log(`下载图片失败: ${imageResponse.status}`);
      return null;
    }

    // 检测图片类型
    const buffer = await imageResponse.arrayBuffer();
    const uint8Array = new Uint8Array(buffer);
    let imageType = 'image/jpeg';

    // Check for PNG signature
    if (uint8Array[0] === 0x89 && uint8Array[1] === 0x50 && uint8Array[2] === 0x4E && uint8Array[3] === 0x47) {
      imageType = 'image/png';
    }

    const extension = imageType === 'image/png' ? '.png' : '.jpg';
    const fileName = `pdd_product_${Date.now()}${extension}`;

    // 使用drive API上传到飞书云盘
    const uploadUrl = 'https://open.feishu.cn/open-apis/drive/v1/files/upload_all';
    const boundary = '----FormBoundary7MA4YWxkTrZu0gW';

    const parts = [
      `--${boundary}\r\nContent-Disposition: form-data; name="file_name"\r\n\r\n${fileName}`,
      `--${boundary}\r\nContent-Disposition: form-data; name="parent_type"\r\n\r\nbitable_file`,
      `--${boundary}\r\nContent-Disposition: form-data; name="parent_node"\r\n\r\n${FEISHU_CONFIG.app_token}`,
      `--${boundary}\r\nContent-Disposition: form-data; name="size"\r\n\r\n${buffer.byteLength}`,
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${imageType}`
    ];

    const body = Buffer.concat([
      Buffer.from(parts.join('\r\n') + '\r\n\r\n'),
      Buffer.from(buffer),
      Buffer.from(`\r\n--${boundary}--`)
    ]);

    const uploadResponse = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`
      },
      body: body
    });

    const uploadResult = await uploadResponse.json();

    if (uploadResult.code === 0) {
      return uploadResult.data.file_token;
    } else {
      console.log(`上传图片失败: ${JSON.stringify(uploadResult)}`);
      return null;
    }
  } catch (e) {
    console.log(`上传图片异常: ${e.message}`);
    return null;
  }
}

// 写入单条商品到飞书表格
async function writeProductToFeishu(accessToken, product, shopName) {
  const baseUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${FEISHU_CONFIG.app_token}/tables/${FEISHU_CONFIG.table_id}/records`;

  const fields = {
    '商品id': String(product.id),
    '平台': '拼多多',
    '店铺': shopName || '',
    '记录时间': Date.now(),
    '30天成交订单数': Number(product.salesCount) || 0
  };

  // 上传商品图片
  if (product.imageUrl) {
    console.log(`  上传图片: ${product.imageUrl.substring(0, 50)}...`);
    const fileToken = await uploadImageToFeishu(accessToken, product.imageUrl);
    if (fileToken) {
      fields['商品图片'] = [{ file_token: fileToken }];
      console.log(`  图片上传成功`);
    } else {
      console.log(`  图片上传失败`);
    }
  }

  // 先检查是否已存在该商品
  const listUrl = `${baseUrl}?page_size=100&filter=CurrentValue.[商品id]="${product.id}"`;
  const listResponse = await fetch(listUrl, {
    headers: { 'Authorization': `Bearer ${accessToken}` }
  });
  const listData = await listResponse.json();

  if (listData.data && listData.data.items && listData.data.items.length > 0) {
    // 更新现有记录
    const recordId = listData.data.items[0].record_id;
    const updateUrl = `${baseUrl}/${recordId}`;
    const updateResponse = await fetch(updateUrl, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ fields })
    });
    const updateData = await updateResponse.json();
    return updateData.code === 0;
  } else {
    // 创建新记录
    const createResponse = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ fields })
    });
    const createData = await createResponse.json();
    return createData.code === 0;
  }
}

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
            const lastIcon = sortIcons[sortIcons.length - 1];
            // 兼容SVG等没有click方法的元素
            if (typeof lastIcon.click === 'function') {
              lastIcon.click();
            } else {
              lastIcon.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            }
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
        // 只点一次排序（拼多多默认点一次=降序），不要多点
        await sleep(2000);
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

// 取消勾选指定列的 checkbox（控制列显示/隐藏）
// 拼多多表头每个 th 里有 checkbox，勾选=显示该列，取消勾选=隐藏该列
// 用 playwright 真实点击（page.locator + click），而非 el.click()，兼容 React
async function uncheckColumns(page, columnNames) {
  const frames = collectFrames(page);
  for (const frame of frames) {
    try {
      if (!frame.url() && frame !== page.mainFrame()) continue;
    } catch (e) { continue; }
    const scope = frame === page.mainFrame() ? '主页面' : 'iframe';

    for (const colName of columnNames) {
      try {
        // 在该 frame 内定位目标表头 th
        // 用 frame.locator（playwright 真实点击，触发 React 事件）
        const thLocator = frame.locator('table thead th', { hasText: colName }).first();
        if (!(await thLocator.count())) {
          console.log(`[${scope}] 未找到含"${colName}"的表头`);
          continue;
        }

        // 在该 th 内找 checkbox 元素（兼容标准 input 和自定义 DIV checkbox）
        // 优先级：标准 input > PDD 自定义 class > role=checkbox
        const cbSelectors = [
          'input[type="checkbox"]',
          '[class*="prevCheckSquare"]',
          '[class*="CBX"]',
          '[class*="checkbox"]',
          '[role="checkbox"]'
        ];
        let cbLocator = null;
        for (const sel of cbSelectors) {
          const cand = thLocator.locator(sel).first();
          if (await cand.count()) {
            // 检查是否可见
            if (await cand.isVisible().catch(() => false)) {
              cbLocator = cand;
              break;
            }
          }
        }

        if (!cbLocator) {
          // 诊断：dump 出目标表头的内部 HTML，看真实 checkbox 结构
          const thHtml = await thLocator.evaluate((el) => (el.innerHTML || '').substring(0, 300)).catch(() => '(无法读取)');
          console.log(`[${scope}] "${colName}"表头内未找到可点击的 checkbox`);
          console.log(`[${scope}] "${colName}"表头内部HTML片段: ${thHtml}`);
          continue;
        }

        // 判断当前勾选状态：PDD 的勾选框通常有 checked 选中 class
        // 用 aria-checked 或 class 含 checked/selected 判断
        const stateInfo = await cbLocator.evaluate((el) => {
          const aria = el.getAttribute('aria-checked');
          const cls = el.className || '';
          const clsStr = typeof cls === 'string' ? cls : '';
          // 向上找父级判断（自定义 checkbox 状态常在父容器）
          const parent = el.closest('[class*="check"], [class*="CBX"], [role="checkbox"]') || el;
          const parentCls = typeof parent.className === 'string' ? parent.className : '';
          const isChecked =
            aria === 'true' ||
            /checked|selected|active/i.test(clsStr) ||
            /checked|selected|active/i.test(parentCls);
          return { isChecked, aria, cls: clsStr.substring(0, 60), parentCls: parentCls.substring(0, 60) };
        }).catch(() => ({ isChecked: null }));

        // 已取消勾选的，跳过
        if (stateInfo.isChecked === false) {
          console.log(`[${scope}] "${colName}"已是未勾选(隐藏)状态，跳过`);
          continue;
        }

        // 真实点击（playwright 会做命中测试，比 el.click() 可靠）
        await cbLocator.click({ timeout: 5000, force: false }).catch(async (e) => {
          // force=false 失败时再用 force 重试一次
          await cbLocator.click({ timeout: 5000, force: true }).catch(() => {});
        });
        console.log(`[${scope}] 已点击"${colName}"表头 checkbox (点击前状态: ${JSON.stringify(stateInfo)})`);
        await sleep(800);
      } catch (e) {
        console.log(`[${scope}] 取消"${colName}"勾选异常: ${e.message}`);
      }
    }

    console.log(`[${scope}] 取消勾选流程结束，共处理 ${columnNames.length} 列`);
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

      // 用列索引定位：找"成交件数"是第几列，每行直接按索引取td，不靠坐标猜
      let salesColIndex = -1;
      for (let i = 0; i < headerTexts.length; i++) {
        if (headerTexts[i].includes('成交件数')) { salesColIndex = i; break; }
      }

      // 调试：记录每行的原始信息（无论是否成功提取），便于排查为何某些行抓不到
      const rowDebug = [];

      for (const row of rows) {
        if (out.length >= limit) break;
        const rowText = (row.innerText || '').trim();
        if (!rowText || rowText.length < 5) continue;

        // 收集行的全部 td（不过滤，保留所有列以支持索引对齐）
        const allTds = [...row.querySelectorAll('td')];
        // 过滤后的 td 列表（排除窄cell，用于图片等查找）
        const tds = allTds.filter(c => {
          const r = c.getBoundingClientRect();
          return r.width > 60 && r.height > 0;
        });
        if (tds.length === 0) continue;

        // ---- 成交件数：按列索引直接取 td ----
        // PDD数值单元格格式是"较前30日245"——"较前30日"是环比说明，最后一个数字才是真实值
        let salesCount = 0;
        if (salesColIndex >= 0 && salesColIndex < allTds.length) {
          const salesTd = allTds[salesColIndex];
          const text = (salesTd.innerText || '').replace(/,/g, '');
          // 取所有数字，取最后一个（跳过"较前30日"里的30）
          const nums = text.match(/\d+/g);
          if (nums && nums.length > 0) salesCount = parseInt(nums[nums.length - 1]);
        }

        // ---- 商品ID：多策略提取 ----
        // 策略1：从行内 a 标签的 href / data-* 属性提取（最可靠）
        // 策略2：从行内任意元素的 data-goods-id / data-id 等属性提取
        // 策略3：从行文本提取 "ID:xxx" 或纯数字（兼容旧逻辑）
        let productId = '';
        let idSource = '';

        // 策略1&2：DOM 属性
        const idAttrs = ['data-goods-id', 'data-goodsid', 'data-id', 'data-product-id', 'goodsid', 'goods-id'];
        const allEls = [...row.querySelectorAll('a, [data-goods-id], [data-goodsid], [data-id], [data-product-id]')];
        for (const el of allEls) {
          // 检查 href
          const href = el.getAttribute('href') || '';
          let hrefId = '';
          const hrefPatterns = [
            /goods_id=(\d+)/i,
            /goodsId=(\d+)/i,
            /goods\/(\d+)/i,
            /product[_-]?id=(\d+)/i,
            /\/(\d{6,20})(?:[/?#]|$)/
          ];
          for (const pat of hrefPatterns) {
            const hm = href.match(pat);
            if (hm) { hrefId = hm[1]; break; }
          }
          if (hrefId) { productId = hrefId; idSource = 'href'; break; }
          // 检查 data 属性
          for (const attr of idAttrs) {
            const v = el.getAttribute(attr);
            if (v && /^\d{6,20}$/.test(v)) { productId = v; idSource = attr; break; }
          }
          if (productId) break;
        }

        // 策略3：行文本兜底
        if (!productId) {
          const m = rowText.match(/ID[\s:：]*(\d{6,20})/) || rowText.match(/货号[\s:：]*([A-Za-z0-9]{4,20})/);
          if (m) { productId = m[1]; idSource = 'text-ID'; }
        }
        if (!productId) {
          // 最后兜底：行内最长的纯数字串（>=6位）
          const nums = rowText.match(/\d{6,20}/g);
          if (nums && nums.length > 0) {
            nums.sort((a, b) => b.length - a.length);
            productId = nums[0];
            idSource = 'text-longest-num';
          }
        }

        // 记录该行调试信息
        if (rowDebug.length < 12) {
          rowDebug.push({
            textHead: rowText.substring(0, 40).replace(/\n/g, ' '),
            salesCount,
            productId,
            idSource,
            linkCount: row.querySelectorAll('a[href]').length,
            sampleHrefs: [...row.querySelectorAll('a[href]')].slice(0, 2).map(a => (a.getAttribute('href') || '').substring(0, 60))
          });
        }

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
          salesColIndex,
          rowDebug
        }
      };
    }, maxCount).catch((e) => {
      console.log(`[${scope}] 提取异常: ${e.message}`);
      return { products: [], meta: {} };
    });

    console.log(`[${scope}] 行数=${data.meta.rowCount || 0} 表头列数=${data.meta.headerCount || 0} 行cell数=${data.meta.cellCount || 0}`);
    console.log(`[${scope}] 表头=${JSON.stringify(data.meta.headerTexts || [])}`);
    console.log(`[${scope}] 成交件数列索引=${data.meta.salesColIndex ?? '?'}`);
    if (data.meta.rowDebug && data.meta.rowDebug.length > 0) {
      console.log(`[${scope}] 每行提取过程(rowDebug):`);
      for (const rd of data.meta.rowDebug) {
        console.log(`  id=${rd.productId || '(空)'} src=${rd.idSource} sales=${rd.salesCount} links=${rd.linkCount} text="${rd.textHead}"`);
        if (rd.sampleHrefs && rd.sampleHrefs.length > 0) {
          console.log(`    href样例: ${rd.sampleHrefs.join(' | ')}`);
        }
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

    // 点击成交件数排序（降序）
    // 拼多多后台内容可能在主页面，也可能在 iframe 内，需要遍历所有 frame
    console.log('点击成交件数排序...');
    await clickSalesSort(page);
    await sleep(3000);

    // 取消勾选"商品访客数"、"商品浏览量"列（隐藏这些不关心的列）
    console.log('取消勾选不关心的列(商品访客数、商品浏览量)...');
    await uncheckColumns(page, ['商品访客数', '商品浏览量']);
    await sleep(2000);

    // 截图保存当前页面状态（容错：截图失败不阻塞主流程）
    try {
      await page.screenshot({ path: path.join(__dirname, 'pdd-product-data.png'), fullPage: true, timeout: 10000 });
      console.log('已截图: pdd-product-data.png');
    } catch (e) {
      console.log('全页截图失败，改用普通截图:', e.message);
      try {
        await page.screenshot({ path: path.join(__dirname, 'pdd-product-data.png'), timeout: 10000 });
        console.log('已截图(非全页): pdd-product-data.png');
      } catch (e2) {
        console.log('截图全部失败，跳过截图，继续提取数据');
      }
    }

    // 提取商品数据（遍历主页面 + 所有 iframe，支持翻页）
    console.log('提取商品数据...');
    let allProducts = [];
    let pageNum = 1;
    let maxPages = 50; // 安全上限，防止死循环
    let writeCount = 0; // 成功写入飞书的数量

    // 获取飞书Token
    let feishuToken = null;
    try {
      feishuToken = await getFeishuToken();
      console.log('飞书Token获取成功');
    } catch (e) {
      console.log('飞书Token获取失败:', e.message);
    }

    // 读取店铺名
    let shopName = '';
    const shopNameFile = path.join(__dirname, 'current_shop.txt');
    if (fs.existsSync(shopNameFile)) {
      shopName = fs.readFileSync(shopNameFile, 'utf-8').trim();
    }

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
        // 去重合并并实时写入飞书
        const seenIds = new Set(allProducts.map(p => p.id));
        for (const p of products) {
          if (!seenIds.has(p.id) && allProducts.length < targetCount) {
            seenIds.add(p.id);
            allProducts.push(p);

            // 实时写入飞书表格
            if (feishuToken) {
              try {
                console.log(`>> 写入飞书: ${p.id} (成交${p.salesCount}件)...`);
                const success = await writeProductToFeishu(feishuToken, p, shopName);
                if (success) {
                  console.log(`>> 写入成功`);
                  writeCount++;
                } else {
                  console.log(`>> 写入失败`);
                }
                await sleep(500); // 避免请求过快
              } catch (e) {
                console.log(`>> 写入出错: ${e.message}`);
              }
            }
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
    console.log(`\n成功写入飞书: ${writeCount} 个商品`);

    // 保存结果到文件
    const resultFile = path.join(__dirname, 'pdd_products.json');
    fs.writeFileSync(resultFile, JSON.stringify(allProducts, null, 2), 'utf-8');
    console.log(`\n结果已保存到: ${resultFile}`);

  } catch (e) {
    console.error('执行出错:', e.message);
    if (!DEBUG) process.exit(1);
  } finally {
    if (DEBUG) {
      console.log('\n[DEBUG] 调试模式已开启，浏览器保持打开，按 Ctrl+C 退出脚本。');
      await new Promise(() => {});
    } else {
      await browser.close();
    }
  }
}

main();
