/**
 * 抖店电商罗盘数据采集脚本
 * 功能：登录抖店 -> 采集商品数据 -> 获取成交订单数 -> 进入详情页获取真实退货率 -> 写入飞书表格
 * 支持Cookie持久化，避免重复扫码
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const COOKIES_DIR = path.join(__dirname, 'cookies');

// 费用配置（从UI传入）
let SHIPPING_FEE = 2.1;
let INSURANCE = 4.01;

// 计算建议毛利（达到3%利润目标）
// 推导：令平均单利润 >= 售价×3%，求最小毛利
// 毛利 × (0.994×(1-退款率) - 0.03) >= 成本×0.03 + 成本×0.006×(1-退款率) + 固定成本
function calcMinGross(cost, returnRate) {
    const rd = returnRate / 100;
    const fixedCost = SHIPPING_FEE + INSURANCE;
    const num = cost * 0.03 + cost * 0.006 * (1 - rd) + fixedCost;
    const den = 0.994 * (1 - rd) - 0.03;
    if (den <= 0) return Infinity; // 退款率太高，无法达到3%利润
    return num / den;
}

const CONFIG = {
  feishu: {
    app_id: 'cli_a91ad5ae63385bc9',
    app_secret: 'ga7Gn6pBJgUkftKY2JEpFe3TJFpB2Mun',
    table_id: 'tbl7PuVUnnFJJeBM',
    app_token: 'CfAXbSrUFaBLv3stSRrcuUVon1b'
  },
  douyin: {
    loginUrl: 'https://fxg.jinritemai.com/ffa/mshop/homepage/index',
    productListUrl: 'https://compass.jinritemai.com/shop/commodity/product-list',
    productManageUrl: 'https://fxg.jinritemai.com/ffa/g/list',
    orderListUrl: 'https://fxg.jinritemai.com/ffa/morder/order/list'
  },
  cookiePath: path.join(__dirname, 'douyin-cookies.json'),
  // Date range: 40 days ago to 10 days ago
  dateRange: {
    get startDate() {
      const d = new Date();
      d.setDate(d.getDate() - 40);
      return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
    },
    get endDate() {
      const d = new Date();
      d.setDate(d.getDate() - 10);
      return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
    }
  }
};

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function saveCookiesToPath(context, cookiePath) {
  const cookies = await context.cookies();
  fs.writeFileSync(cookiePath, JSON.stringify(cookies, null, 2));
  console.log('Cookie已保存到:', cookiePath);
}

async function loadCookiesFromPath(context, cookiePath) {
  if (fs.existsSync(cookiePath)) {
    try {
      const cookies = JSON.parse(fs.readFileSync(cookiePath, 'utf-8'));
      await context.addCookies(cookies);
      return true;
    } catch (e) {
      return false;
    }
  }
  return false;
}

async function getFeishuToken() {
  const response = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: CONFIG.feishu.app_id,
      app_secret: CONFIG.feishu.app_secret
    })
  });
  const data = await response.json();
  if (data.code !== 0) {
    throw new Error(`飞书Token获取失败: ${JSON.stringify(data)}`);
  }
  return data.tenant_access_token;
}

// 上传图片到飞书并获取file_token
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
    const fileName = `product_${Date.now()}${extension}`;

    // 使用drive API上传到飞书云盘
    // 关键：使用 parent_type=bitable_file 和 parent_node=app_token
    const uploadUrl = 'https://open.feishu.cn/open-apis/drive/v1/files/upload_all';
    const boundary = '----FormBoundary7MA4YWxkTrZu0gW';

    const parts = [
      `--${boundary}\r\nContent-Disposition: form-data; name="file_name"\r\n\r\n${fileName}`,
      `--${boundary}\r\nContent-Disposition: form-data; name="parent_type"\r\n\r\nbitable_file`,
      `--${boundary}\r\nContent-Disposition: form-data; name="parent_node"\r\n\r\nCfAXbSrUFaBLv3stSRrcuUVon1b`,
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
    console.log(`上传结果: ${JSON.stringify(uploadResult)}`);

    if (uploadResult.code === 0) {
      // drive API返回的是file_token
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

// 从4号表格查询成本
async function getCostFrom4thTable(accessToken, merchantCode) {
  if (!merchantCode) {
    console.log('商家编码为空，跳过查询成本');
    return null;
  }

  console.log(`从4号表格查询款号 ${merchantCode} 的成本...`);

  // 4号表格: tblpEOUDXbdCMPPH
  const baseUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.feishu.app_token}/tables/tblpEOUDXbdCMPPH/records`;

  try {
    // 精确搜索款号
    const searchUrl = `${baseUrl}?page_size=100&filter=AND(CurrentValue.[款号]="${merchantCode}")`;
    const response = await fetch(searchUrl, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });

    const data = await response.json();

    if (data.data && data.data.items && data.data.items.length > 0) {
      const record = data.data.items[0];
      const cost = record.fields['成本'];
      if (cost !== undefined && cost !== null) {
        console.log(`找到成本: ${cost}`);
        return cost;
      }
    }

    // 如果精确搜索没找到，遍历所有记录查找
    console.log('精确搜索未找到，遍历所有记录...');
    let pageToken = '';
    do {
      const listUrl = pageToken ? `${baseUrl}?page_size=100&page_token=${pageToken}` : baseUrl;
      const listResponse = await fetch(listUrl, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      const listData = await listResponse.json();

      if (listData.data && listData.data.items) {
        for (const record of listData.data.items) {
          const code = record.fields['款号'];
          if (code && String(code).trim() === String(merchantCode).trim()) {
            const cost = record.fields['成本'];
            if (cost !== undefined && cost !== null) {
              console.log(`找到成本: ${cost}`);
              return cost;
            }
          }
        }
        pageToken = listData.data.page_token || '';
      } else {
        break;
      }
    } while (pageToken);

    // 精确匹配没找到，尝试模糊匹配：款号尾部有中文或数字后缀且备注为空
    console.log('精确匹配未找到，尝试模糊匹配...');
    pageToken = '';
    do {
      const listUrl = pageToken ? `${baseUrl}?page_size=100&page_token=${pageToken}` : baseUrl;
      const listResponse = await fetch(listUrl, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      const listData = await listResponse.json();

      if (listData.data && listData.data.items) {
        for (const record of listData.data.items) {
          const code = record.fields['款号'];
          const remark = record.fields['备注'];
          // 检查备注是否为空
          const isRemarkEmpty = !remark || String(remark).trim() === '';
          if (code && isRemarkEmpty && String(code).startsWith(merchantCode)) {
            const codeStr = String(code);
            const merchantLen = merchantCode.length;
            if (codeStr.length > merchantLen) {
              const suffix = codeStr.substring(merchantLen);
              // 情况1：尾部有中文（如 HBJJ218黑色）
              const hasChineseSuffix = /[一-龥]/.test(suffix);
              // 情况2：尾部是 -数字 格式（如 HBJJ218-1, HBJJ218-2）
              const hasDashNumberSuffix = /^-\d+$/.test(suffix);
              if (hasChineseSuffix || hasDashNumberSuffix) {
                const cost = record.fields['成本'];
                if (cost !== undefined && cost !== null) {
                  console.log(`模糊匹配成功: 款号=${code}, 成本=${cost}`);
                  return cost;
                }
              }
            }
          }
        }
        pageToken = listData.data.page_token || '';
      } else {
        break;
      }
    } while (pageToken);

    console.log(`未找到款号 ${merchantCode} 的成本`);
    return null;
  } catch (e) {
    console.log(`查询成本失败: ${e.message}`);
    return null;
  }
}
// 检查飞书表格中是否有需要跳过的记录
// 规则：修正退货率为空则6小时内不更新；订单数>=10则24小时；5-9则48小时；<5则72小时
async function checkRecentRecord(accessToken, productId) {
  const baseUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.feishu.app_token}/tables/${CONFIG.feishu.table_id}`;
  const now = Date.now();
  console.log(`[checkRecentRecord] 开始检查商品 ${productId}，当前时间: ${new Date(now).toISOString()}`);

  let pageToken = '';
  let pageNum = 0;
  do {
    pageNum++;
    const listUrl = pageToken
      ? `${baseUrl}/records?page_size=100&page_token=${pageToken}`
      : `${baseUrl}/records?page_size=100`;

    try {
      const response = await fetch(listUrl, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      const data = await response.json();

      if (data.data && data.data.items) {
        console.log(`[checkRecentRecord] 第${pageNum}页，共${data.data.items.length}条记录`);
        for (const record of data.data.items) {
          const recordTime = record.fields['记录时间'];
          const recordId = record.fields['商品id'];
          const correctedRate = record.fields['修正退款率'];
          const orderCount = record.fields['30天成交订单数'];
          const pureProfit5 = record.fields['纯利5%'];

          if (recordId && String(recordId) === String(productId)) {
            console.log(`[checkRecentRecord] 找到匹配的记录! 商品id=${recordId}, 记录时间=${recordTime}, 修正退款率=${correctedRate}, 订单数=${orderCount}, 纯利5%=${pureProfit5}`);
            // 检查记录时间
            let recordTimeMs = 0;
            if (typeof recordTime === 'number') {
              recordTimeMs = recordTime;
            } else if (typeof recordTime === 'string') {
              recordTimeMs = new Date(recordTime).getTime();
            }

            // 判断时间间隔（小时）
            const hoursDiff = (now - recordTimeMs) / (1000 * 60 * 60);
            console.log(`  [记录时间检查] 记录时间=${new Date(recordTimeMs).toISOString()}, 差=${hoursDiff.toFixed(1)}小时`);

            // 规则按时间从短到长检查，条件满足则跳过，时间窗口已过则直接抓取

            // 1. 修正退货率为空
            if (correctedRate === null || correctedRate === undefined || correctedRate === '') {
              if (hoursDiff < 6) {
                console.log(`  跳过：修正退货率为空，差${hoursDiff.toFixed(1)}小时<6小时`);
                return true;
              }
              console.log(`  抓取：修正退货率为空，已超过6小时(${hoursDiff.toFixed(1)}小时)`);
              return false;
            }

            // 2. 纯利5%为空
            if (pureProfit5 === null || pureProfit5 === undefined || pureProfit5 === '' || pureProfit5 === 0) {
              if (hoursDiff < 6) {
                console.log(`  跳过：纯利5%为空，差${hoursDiff.toFixed(1)}小时<6小时`);
                return true;
              }
              console.log(`  抓取：纯利5%为空，已超过6小时(${hoursDiff.toFixed(1)}小时)`);
              return false;
            }

            // 3. 订单数>=10
            const orderNum = typeof orderCount === 'number' ? orderCount : parseInt(orderCount) || 0;
            if (orderNum >= 10) {
              if (hoursDiff < 24) {
                console.log(`  跳过：订单数${orderNum}>=10，差${hoursDiff.toFixed(1)}小时<24小时`);
                return true;
              }
              console.log(`  抓取：订单数${orderNum}>=10，已超过24小时(${hoursDiff.toFixed(1)}小时)`);
              return false;
            }

            // 4. 订单数5-9
            if (orderNum >= 5) {
              if (hoursDiff < 48) {
                console.log(`  跳过：订单数${orderNum}>=5，差${hoursDiff.toFixed(1)}小时<48小时`);
                return true;
              }
              console.log(`  抓取：订单数${orderNum}>=5，已超过48小时(${hoursDiff.toFixed(1)}小时)`);
              return false;
            }

            // 5. 订单数<5
            if (hoursDiff < 72) {
              console.log(`  跳过：订单数${orderNum}<5，差${hoursDiff.toFixed(1)}小时<72小时`);
              return true;
            }

            // 6. 已下架
            const intervention = record.fields['已经干预'];
            const interventionStr = String(intervention || '');
            if (interventionStr.includes('已下架')) {
              if (hoursDiff < 168) {
                console.log(`  跳过：已下架，差${hoursDiff.toFixed(1)}小时<168小时`);
                return true;
              }
              console.log(`  抓取：已下架，已超过168小时(${hoursDiff.toFixed(1)}小时)`);
              return false;
            }

            console.log(`  不跳过：所有规则均不满足`);
          }
        }
        if (!data.data.has_more) {
          console.log(`[checkRecentRecord] 第${pageNum}页没有更多记录`);
          break;
        }
        pageToken = data.data.page_token;
      } else {
        break;
      }
    } catch (e) {
      console.log(`  检查记录失败: ${e.message}`);
      break;
    }
  } while (pageToken);

  console.log(`[checkRecentRecord] 商品 ${productId} 未找到匹配记录或不符合跳过条件，返回false`);
  return false;
}

// 从订单列表页面获取商品数据（商家编码、售价、图片）
async function getOrderData(page, orderListUrl) {
  try {
    // 等待页面加载
    await page.waitForTimeout(5000);
    const orderData = await page.evaluate(() => {
      const rows = document.querySelectorAll('tbody tr');
      if (rows.length === 0) return { found: false, reason: 'no_rows' };

      for (const row of rows) {
        const rowText = row.innerText || '';
        if (rowText.includes('暂无数据')) return { found: false, reason: 'no_data' };

        let merchantCode = '';
        let merchantIncome = '';
        const img = row.querySelector('img');

        // 查找商家编码
        const codeMatch = rowText.match(/商家编码[：:]\s*(\S+)/);
        if (codeMatch) merchantCode = codeMatch[1];

        // 查找商家收入
        const incomeMatch = rowText.match(/¥\s*([\d,]+\.?\d*)/g);
        if (incomeMatch && incomeMatch.length >= 2) {
          merchantIncome = incomeMatch[1].replace(/[¥,\s]/g, '');
        } else if (incomeMatch && incomeMatch.length === 1) {
          merchantIncome = incomeMatch[0].replace(/[¥,\s]/g, '');
        }

        if (merchantCode || merchantIncome) {
          return {
            found: true,
            imageUrl: img ? img.src : '',
            merchantCode: merchantCode,
            merchantIncome: merchantIncome
          };
        }
      }
      return { found: false, reason: 'not_found' };
    });
    return orderData;
  } catch (e) {
    console.log(`  getOrderData error: ${e.message}`);
    return { found: false, reason: e.message };
  }
}

// 清理旧记录：删除记录时间超过10天且30天成交订单数>=最小订单数的记录
async function cleanOldRecords(accessToken, shopName, minOrderCount) {
  const baseUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.feishu.app_token}/tables/${CONFIG.feishu.table_id}`;
  const now = Date.now();

  console.log(`\n========== [清理旧记录] ==========`);
  console.log(`店铺: ${shopName}`);
  console.log(`最小订单数阈值: ${minOrderCount}`);
  console.log(`删除条件: 记录时间超过10天 且 30天成交订单数 >= ${minOrderCount}`);

  let pageToken = '';
  let deletedCount = 0;
  let checkedCount = 0;
  let skippedCount = 0;

  do {
    const listUrl = pageToken
      ? `${baseUrl}/records?page_size=100&page_token=${pageToken}`
      : `${baseUrl}/records?page_size=100`;

    try {
      const response = await fetch(listUrl, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      const data = await response.json();

      if (data.data && data.data.items) {
        for (const item of data.data.items) {
          const recordShop = item.fields['店铺'];
          const recordTime = item.fields['记录时间'];
          const orderCount = item.fields['30天成交订单数'];

          // 只处理当前店铺的记录
          if (!recordShop || String(recordShop).trim() !== shopName.trim()) continue;
          checkedCount++;

          // 解析记录时间
          let recordTimeMs = 0;
          if (typeof recordTime === 'number') {
            recordTimeMs = recordTime;
          } else if (typeof recordTime === 'string') {
            recordTimeMs = new Date(recordTime).getTime();
          }
          if (!recordTimeMs) continue;

          // 解析订单数
          const orderNum = typeof orderCount === 'number' ? orderCount : parseInt(orderCount) || 0;

          // 检查是否需要删除：记录时间超过10天 且 订单数>=最小订单数
          const daysDiff = (now - recordTimeMs) / (1000 * 60 * 60 * 24);
          if (daysDiff > 10 && orderNum >= minOrderCount) {
            const dateStr = new Date(recordTimeMs).toISOString().split('T')[0];
            console.log(`  [删除] 商品ID: ${item.fields['商品id']}, 订单数: ${orderNum}, 记录日期: ${dateStr}, ${daysDiff.toFixed(1)}天前`);

            // 删除记录
            try {
              const deleteUrl = `${baseUrl}/records/${item.record_id}`;
              const deleteResponse = await fetch(deleteUrl, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${accessToken}` }
              });
              const deleteResult = await deleteResponse.json();
              if (deleteResult.code === 0) {
                deletedCount++;
                console.log(`    ✓ 删除成功`);
              } else {
                console.log(`    ✗ 删除失败: ${deleteResult.msg}`);
              }
            } catch (e) {
              console.log(`    ✗ 删除异常: ${e.message}`);
            }

            await sleep(500); // 限速
          } else {
            skippedCount++;
          }
        }
        pageToken = data.data.page_token || '';
      } else {
        break;
      }
    } catch (e) {
      console.log(`  查询记录失败: ${e.message}`);
      break;
    }
  } while (pageToken);

  console.log(`\n========== [清理完成] ==========`);
  console.log(`检查记录数: ${checkedCount}`);
  console.log(`删除记录数: ${deletedCount}`);
  console.log(`跳过记录数: ${skippedCount}`);
  console.log(`================================`);
}

async function writeToFeishu(accessToken, products, shopName) {
  const baseUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.feishu.app_token}/tables/${CONFIG.feishu.table_id}`;

  // 先获取所有现有记录，构建商品id -> record_id 和 record_id -> 备注/已经干预/订单数/成本 映射
  console.log('获取现有记录...');
  const existingRecords = new Map();  // productId -> recordId
  const recordRemarks = new Map();    // recordId -> 备注值（用于append）
  const recordIntervention = new Map(); // recordId -> 已经干预值（更新时保留）
  const recordOrderCounts = new Map(); // recordId -> 原30天成交订单数（用于下滑检测）
  const recordCosts = new Map();       // recordId -> 成本（更新时保留）
  let pageToken = '';

  do {
    const listUrl = pageToken
      ? `${baseUrl}/records?page_size=100&page_token=${pageToken}`
      : `${baseUrl}/records?page_size=100`;

    const response = await fetch(listUrl, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    const data = await response.json();

    if (data.data && data.data.items) {
      for (const item of data.data.items) {
        const productId = item.fields['商品id'];
        if (productId) {
          existingRecords.set(String(productId), item.record_id);
          // 保存现有备注值（用于append）
          const existingRemark = item.fields['备注'];
          if (existingRemark) {
            recordRemarks.set(item.record_id, String(existingRemark));
          }
          // 保存现有已经干预值（更新时保留）
          const existingIntervention = item.fields['已经干预'];
          if (existingIntervention) {
            recordIntervention.set(item.record_id, existingIntervention);
          }
          // 保存原成交订单数（用于销量下滑检测）
          const existingOrderCount = item.fields['30天成交订单数'];
          if (existingOrderCount !== undefined && existingOrderCount !== null) {
            recordOrderCounts.set(item.record_id, Number(existingOrderCount));
          }
          // 保存现有成本（用于更新时保留）
          const existingCost = item.fields['成本'];
          if (existingCost !== undefined && existingCost !== null) {
            recordCosts.set(item.record_id, Number(existingCost));
          }
        }
      }
    }

    pageToken = data.data?.page_token || '';
  } while (pageToken);

  console.log(`找到 ${existingRecords.size} 条现有记录`);

  // 先上传所有图片，获取file_token
  console.log('开始上传商品图片...');
  for (const product of products) {
    if (product.imageUrl) {
      console.log(`上传图片: ${product.id}`);
      const fileToken = await uploadImageToFeishu(accessToken, product.imageUrl);
      if (fileToken) {
        product.imageFileToken = fileToken;
        console.log(`图片上传成功: ${fileToken}`);
      } else {
        console.log(`图片上传失败: ${product.imageUrl}`);
      }
      await sleep(1000); // 避免请求过快
    }
  }

  // 写入/更新每条商品记录
  let allSuccess = true;
  for (const product of products) {
    const productIdStr = String(product.id);

    // 构建字段数据
    const fields = {
      '商品id': productIdStr,
      '平台': '抖店',
      '店铺': shopName || '瑾漂亮高定私服',
      '记录时间': Date.now(),
      '30天成交订单数': Number(product.orderCount),
      '近30天退款率': product.listReturnRate ? product.listReturnRate / 100 : 0,
      '修正退款率': product.returnRate ? product.returnRate / 100 : null,
      '商品编码': product.merchantCode || '',
      '最新售价': product.merchantIncome || 0
    };

    // 纯利3% = 最新售价 × 3%
    if (product.merchantIncome) {
      fields['纯利3%'] = Number((product.merchantIncome * 0.03).toFixed(2));
    }
    // 纯利5% = 最新售价 × 5%
    if (product.merchantIncome) {
      fields['纯利5%'] = Number((product.merchantIncome * 0.05).toFixed(2));
    }
    console.log(`  [writeToFeishu] merchantIncome=${product.merchantIncome}, 纯利3%=${fields['纯利3%']}, 纯利5%=${fields['纯利5%']}`);

    // 处理备注字段：只追加，不覆盖
    const remarkParts = [];
    const today = new Date().toISOString().split('T')[0];

    // 如果有成本，添加到字段中（成本字段是数字类型，不能为null）
    if (product.cost !== undefined && product.cost !== null) {
      fields['成本'] = Number(product.cost);
    }

    // 100%退货率：亏损 = 邮费+运费险（不需要成本）
    const orderNumForLoss = product.orderCount || 0;
    const listRateForLoss = product.listReturnRate || 0;
    const correctedRateForLoss = product.returnRate || 0;
    const maxRateForLoss = Math.max(listRateForLoss, correctedRateForLoss);
    if (orderNumForLoss > 0 && maxRateForLoss >= 100) {
      const lossPerOrder = -(SHIPPING_FEE + INSURANCE);
      fields['平均每单利润'] = Number(lossPerOrder.toFixed(2));
      console.log(`  平均每单利润: ${fields['平均每单利润']}元 (退货率${maxRateForLoss}%, 每单亏邮费+运费险)`);
    }

    // 计算毛利 = 最新售价 - 成本（如果成本存在）
    if (product.merchantIncome !== undefined && product.merchantIncome !== null &&
        product.cost !== undefined && product.cost !== null) {
      const grossProfit = product.merchantIncome - product.cost;
      fields['毛利'] = Number(grossProfit.toFixed(2));
      console.log(`  毛利: ${product.merchantIncome} - ${product.cost} = ${fields['毛利']}`);

      // 计算平均每单利润（用连续值，不用Math.round）
      const orderNum = product.orderCount || 0;
      const listRate = product.listReturnRate || 0;
      const correctedRate = product.returnRate || 0;
      const maxRate = Math.max(listRate, correctedRate);
      let avgProfitPerOrder = 0;
      if (orderNum > 0) {
        const price = product.merchantIncome;
        const cost = product.cost;
        const returnRateDecimal = maxRate / 100;
        // 不用Math.round，用连续值计算，避免向上取整导致利润高估
        const successOrders = orderNum * (1 - returnRateDecimal);
        const refundOrders = orderNum * returnRateDecimal;
        const commission = price * 0.006;
        // 成功订单利润
        const profitPerSuccess = price - cost - commission - SHIPPING_FEE - INSURANCE;
        // 退货订单成本（无商品成本）
        const costPerRefund = SHIPPING_FEE + INSURANCE;
        // 总利润
        const totalProfit = (profitPerSuccess * successOrders) - (costPerRefund * refundOrders);
        avgProfitPerOrder = totalProfit / orderNum;
        fields['平均每单利润'] = Number(avgProfitPerOrder.toFixed(2));
        console.log(`  平均每单利润: ${fields['平均每单利润']}元 (订单${orderNum}单, 退货率${maxRate}%, 成功${successOrders.toFixed(1)}单, 退货${refundOrders.toFixed(1)}单)`);
      }

      // 获取现有干预内容，用于跳过已有人工标记的建议
      const recordIdForInter = existingRecords.get(productIdStr);
      const existingIntervention = recordIdForInter ? recordIntervention.get(recordIdForInter) : null;
      const interventionStr = existingIntervention ? String(existingIntervention) : '';

      // 高退货率强制毛利至少80元：订单>10 且 近30天退款率>70% 且 修正退款率>75%
      // 但如果平均每单利润已高于纯利3%，说明当前毛利已足够，不需要建议
      const pureProfit3High = (product.merchantIncome || 0) * 0.03;
      if (orderNum > 10 && listRate > 0.70 && correctedRate > 0.75 && avgProfitPerOrder <= pureProfit3High) {
        if (product.cost !== undefined && product.cost !== null && product.merchantIncome) {
          const currentGross = product.merchantIncome - product.cost;
          // 按正常公式计算建议毛利
          const rd = maxRate / 100;
          const minGross = calcMinGross(product.cost, maxRate);
          const sg = Math.max(Math.ceil(minGross), 80); // 至少80元
          if (sg > currentGross) {
            fields['等待人工操作'] = `建议毛利${sg}元`;
            console.log(`  高退货率建议毛利: 订单${orderNum}, 退货率${maxRate}%, 需毛利${sg}, 当前毛利${currentGross.toFixed(0)}元`);
          }
        }
        // 没有成本或计算不出时，兜底80元
        if (!fields['等待人工操作']) {
          fields['等待人工操作'] = '建议毛利80元';
          console.log(`  高退货率兜底毛利80元: 订单${orderNum}, 近30天退款率${listRate}%, 修正退款率${correctedRate}%`);
        }
      } else if (orderNum > 10 && listRate > 0.70 && correctedRate > 0.75) {
        console.log(`  跳过高退货率建议: 平均每单利润${avgProfitPerOrder.toFixed(2)} > 纯利3%${pureProfit3High.toFixed(2)}，当前毛利已足够`);
      } else {
      function shouldSkipIntervention(suggestionText) {
        if (!interventionStr) return false;
        // 已有建议毛利则跳过新的建议毛利（不管金额是否相同）
        if (suggestionText.startsWith('建议毛利') && interventionStr.includes('建议毛利')) return true;
        const numMatch = suggestionText.match(/\d+/);
        if (numMatch && suggestionText.includes('毛利')) {
          const num = numMatch[0];
          const patterns = [`毛利${num}`, `毛利达到${num}`, `毛利需要增长到${num}`];
          return patterns.some(p => interventionStr.includes(p)) || interventionStr.includes(suggestionText);
        }
        return interventionStr.includes(suggestionText);
      }

      // 判断是否需要建议毛利增长或下架
      let suggestionText = '';
      let suggestedGrossText = '';
      if (interventionStr.includes('已下架')) {
        console.log(`  不建议下架：已经干预包含已下架`);
      } else if (orderNum >= 5 && maxRate > 0.90) {
        // 销量>=5且退货率>90%，建议下架
        suggestionText = '建议下架';
        // 同时计算建议毛利
        if (product.cost !== undefined && product.cost !== null && product.merchantIncome) {
          const minGross = calcMinGross(product.cost, maxRate);
          const currentGross = product.merchantIncome - product.cost;
          if (minGross > currentGross) {
            const sg = Math.ceil(minGross);
            suggestedGrossText = `建议毛利${sg}元`;
            console.log(`  动态涨价建议: 成本${product.cost}, 退货率${maxRate}%, 需毛利${sg}, 当前毛利${currentGross.toFixed(0)}`);
          }
        }
      } else if (orderNum >= 4 && maxRate >= 1.0) {
        // 销量>=4且退货率=100%，建议下架
        suggestionText = '建议下架';
        // 同时计算建议毛利
        if (product.cost !== undefined && product.cost !== null && product.merchantIncome) {
          const minGross = calcMinGross(product.cost, maxRate);
          const currentGross = product.merchantIncome - product.cost;
          if (minGross > currentGross) {
            const sg = Math.ceil(minGross);
            suggestedGrossText = `建议毛利${sg}元`;
            console.log(`  动态涨价建议: 成本${product.cost}, 退货率${maxRate}%, 需毛利${sg}, 当前毛利${currentGross.toFixed(0)}`);
          }
        }
      } else if (orderNum >= 5 && product.cost !== undefined && product.cost !== null && product.merchantIncome) {
        // 5单以上，动态计算建议售价
        // 但如果平均每单利润已高于纯利3%，说明当前毛利已足够，不需要建议
        const pureProfit3 = product.merchantIncome * 0.03;
        if (avgProfitPerOrder > pureProfit3) {
          console.log(`  跳过建议毛利: 平均每单利润${avgProfitPerOrder.toFixed(2)} > 纯利3%${pureProfit3.toFixed(2)}，当前毛利已足够`);
        } else {
          const minGross = calcMinGross(product.cost, maxRate);
          const currentGross = product.merchantIncome - product.cost;
          if (minGross > currentGross) {
            const sg = Math.ceil(minGross);
            suggestionText = `建议毛利${sg}元`;
            console.log(`  动态涨价建议: 成本${product.cost}, 退货率${maxRate}%, 需毛利${sg}, 当前毛利${currentGross.toFixed(0)}`);
          }
        }
      }

      if (suggestionText) {
        if (shouldSkipIntervention(suggestionText)) {
          console.log(`  不写入等待人工操作：已经干预包含(${existingIntervention})`);
        } else {
          // 如果有建议毛利，追加到建议下架后面
          if (suggestedGrossText) {
            fields['等待人工操作'] = suggestionText + '；' + suggestedGrossText;
          } else {
            fields['等待人工操作'] = suggestionText;
          }
          console.log(`  等待人工操作: ${fields['等待人工操作']} (订单数${orderNum}, 退货率${maxRate}%)`);
        }
      }

      // 原有毛利低于40的逻辑（只在没有更高优先级建议时生效）
      if (!fields['等待人工操作'] && grossProfit < 40) {
        if (shouldSkipIntervention('毛利低于40') || interventionStr.includes('已下架')) {
          console.log(`  不写入等待人工操作：已经干预包含排除项(${existingIntervention})`);
        } else {
          fields['等待人工操作'] = '毛利低于40';
          console.log(`  等待人工操作: 毛利低于40 (${grossProfit})`);
        }
      }

      // 判断是否写入"推荐复制到其它店铺"
      const skipRecommend = existingIntervention && (String(existingIntervention).includes('过季了') || String(existingIntervention).includes('已经复制到其它店铺'));
      if (skipRecommend) {
        console.log(`  不写入推荐复制：已经干预包含(${existingIntervention})`);
      }

      const bothNot100 = listRate !== 100 && correctedRate !== 100;
      let recommendText = '';
      if (!skipRecommend && orderNum >= 3 && orderNum <= 5 && bothNot100) {
        // 订单数3-5且两个退款率都不是100%
        recommendText = '推荐复制到其它店铺';
        console.log(`  等待人工操作追加: 推荐复制到其它店铺 (订单数${orderNum}, 列表退款率${listRate}%, 修正退款率${correctedRate}%)`);
      } else if (!skipRecommend && orderNum >= 6 && orderNum <= 10 && maxRate < 0.85) {
        // 订单数6-10且最大退款率低于85%
        recommendText = '推荐复制到其它店铺';
        console.log(`  等待人工操作追加: 推荐复制到其它店铺 (订单数${orderNum}, 最大退款率${maxRate}%)`);
      } else if (!skipRecommend && orderNum > 10 && maxRate < 0.70) {
        // 订单数>10且最大退款率低于70%
        recommendText = '推荐复制到其它店铺';
        console.log(`  等待人工操作追加: 推荐复制到其它店铺 (订单数${orderNum}, 最大退款率${maxRate}%)`);
      }

      // 将推荐内容追加到等待人工操作（不覆盖之前的内容）
      if (recommendText) {
        if (fields['等待人工操作']) {
          fields['等待人工操作'] = fields['等待人工操作'] + '；' + recommendText;
        } else {
          fields['等待人工操作'] = recommendText;
        }
      }

      // 订单数>15且满足"推荐复制到其它店铺"条件时，追加"建议裂变此商品"（不受skipRecommend影响）
      if (orderNum > 15 && maxRate < 0.70) {
        const append = '建议裂变此商品';
        if (fields['等待人工操作']) {
          fields['等待人工操作'] = fields['等待人工操作'] + '；' + append;
        } else {
          fields['等待人工操作'] = append;
        }
        console.log(`  等待人工操作追加: 建议裂变此商品 (订单数${orderNum} > 15, 退货率${maxRate}% < 70%)`);
      }

      /*
      // 如果当前平均每单利润高于6元，在备注写入毛利标准
      // 平均每单利润 = (1-退货率) × (毛利 - 扣点5% - 邮费 - 运费险) - (邮费 + 运费险) × 退货率
      const commission = (product.merchantIncome || 0) * 0.05;
      const fixedCostPerRefund = SHIPPING_FEE + INSURANCE; // 6.11
      const r = maxRate / 100;
      // 平均每单利润 = (1-r) × (毛利 - commission - fixedCostPerRefund) - fixedCostPerRefund × r
      const avgProfitPerOrder = (1 - r) * (grossProfit - commission - fixedCostPerRefund) - fixedCostPerRefund * r;
      // 毛利标准 = 平均每单利润5元时需要的毛利
      // 5 = (1-r) × (GP - commission - 6.11) - 6.11 × r
      // GP = (5 + 6.11×r) / (1-r) + commission + 6.11
      const requiredGPFor5Profit = (5 + fixedCostPerRefund * r) / (1 - r) + commission + fixedCostPerRefund;
      console.log(`  [毛利标准计算] 售价=${product.merchantIncome}, 毛利=${grossProfit}, 退货率=${maxRate}%`);
      console.log(`  [毛利标准计算] 毛利标准(5元/单)=${requiredGPFor5Profit.toFixed(1)}, 实际平均每单利润=${avgProfitPerOrder.toFixed(2)}, 阈值=6`);
      if (avgProfitPerOrder > 6) {
        remarkParts.push(`当前退货率${maxRate.toFixed(1)}%，毛利标准${Math.ceil(requiredGPFor5Profit)}`);
        console.log(`  备注追加: 当前退货率${maxRate.toFixed(1)}%，毛利标准${Math.ceil(requiredGPFor5Profit)}`);
      }
      */
    }
    }

    // 如果成本未找到，添加备注
    if (product.cost === undefined || product.cost === null) {
      remarkParts.push('成本获取失败');
      console.log(`  备注追加: 成本获取失败`);
    }

    // 如果近30天退款率 > 修正退款率 超过5%，添加备注
    if (product.listReturnRate !== undefined && product.returnRate !== undefined &&
        product.listReturnRate !== null && product.returnRate !== null) {
      const diff = product.listReturnRate - product.returnRate;
      if (diff > 5) {
        remarkParts.push(`注意退货率正在增长${today}`);
        console.log(`  备注追加: 注意退货率正在增长${today} (差值: ${diff.toFixed(2)}%)`);
      }
    }

    // 检测销量下滑：新订单数比原订单数少5以上
    const recordId = existingRecords.get(productIdStr);
    if (recordId && product.orderCount !== undefined && product.orderCount !== null) {
      const oldOrderCount = recordOrderCounts.get(recordId);
      if (oldOrderCount !== undefined) {
        const change = Number(product.orderCount) - oldOrderCount;
        if (change >= 5) {
          remarkParts.push(`销量上涨中，${oldOrderCount}→${product.orderCount}`);
          console.log(`  备注追加: 销量上涨中，${oldOrderCount}→${product.orderCount} (增加${change})`);
        } else if (change <= -5) {
          remarkParts.push(`销量正在下滑，${oldOrderCount}→${product.orderCount}`);
          console.log(`  备注追加: 销量正在下滑，${oldOrderCount}→${product.orderCount} (减少${-change})`);
        }
      }
    }

    // 如果有备注内容，合并现有备注后写入
    if (remarkParts.length > 0) {
      const newRemark = remarkParts.join('；');
      let existingRemark = recordId ? recordRemarks.get(recordId) : null;

      // 如果获取了成本，清除现有备注中的"成本获取失败"
      if (existingRemark && product.cost !== undefined && product.cost !== null) {
        if (existingRemark.includes('成本获取失败')) {
          existingRemark = existingRemark.replace(/成本获取失败[；;]?/g, '').replace(/^[；;]+|[；;]+$/g, '').trim();
          console.log(`  备注清理: 删除"成本获取失败"`);
        }
      }

      if (existingRemark) {
        // 过滤掉已存在的备注项，避免重复
        const existingParts = existingRemark.split(/[；;]/).map(s => s.trim()).filter(s => s);
        const newParts = remarkParts.filter(p => !existingParts.includes(p));
        if (newParts.length > 0) {
          fields['备注'] = existingRemark + '；' + newParts.join('；');
          console.log(`  备注追加到现有: "${existingRemark}" + "${newParts.join('；')}"`);
        } else {
          // 所有新备注已存在，不更新
          console.log(`  备注跳过: 所有内容已存在`);
        }
      } else {
        fields['备注'] = newRemark;
        console.log(`  备注写入: "${newRemark}"`);
      }
    } else if (recordId) {
      // 即使没有新备注，如果获取了成本也要清除"成本获取失败"
      const existingRemark = recordRemarks.get(recordId);
      if (existingRemark && product.cost !== undefined && product.cost !== null) {
        if (existingRemark.includes('成本获取失败')) {
          const cleanedRemark = existingRemark.replace(/成本获取失败[；;]?/g, '').replace(/^[；;]+|[；;]+$/g, '').trim();
          if (cleanedRemark) {
            fields['备注'] = cleanedRemark;
            console.log(`  备注清理: 删除"成本获取失败", 保留: "${cleanedRemark}"`);
          } else {
            fields['备注'] = '';
            console.log(`  备注清理: 删除"成本获取失败", 备注已清空`);
          }
        }
      }
    }

    // 如果有图片token，添加图片字段
    if (product.imageFileToken) {
      fields['商品图片'] = [{ 'file_token': product.imageFileToken }];
    }

    // 不添加商品名称字段，因为表中可能没有该字段

    if (existingRecords.has(productIdStr)) {
      // 更新现有记录
      const recordId = existingRecords.get(productIdStr);
      console.log(`更新 [${product.id}] 成交订单数:${product.orderCount} 退货率:${product.returnRate}...`);

      // 获取现有记录的成本（如果新成本未获取到则使用旧成本）
      const existingCost = recordCosts.get(recordId);
      if ((product.cost === undefined || product.cost === null) && existingCost !== undefined && existingCost !== null) {
        product.cost = existingCost;
        fields['成本'] = Number(existingCost);
        console.log(`  使用现有成本: ${existingCost}`);
      }

      // 保留现有"已经干预"字段的值
      const existingIntervention = recordIntervention.get(recordId);
      if (existingIntervention) {
        fields['已经干预'] = existingIntervention;
        console.log(`  保留已经干预字段: ${existingIntervention}`);
      }

      let writeSuccess = false;
      for (let attempt = 1; attempt <= 3 && !writeSuccess; attempt++) {
        try {
          const updateUrl = `${baseUrl}/records/${recordId}`;
          const response = await fetch(updateUrl, {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${accessToken}`
            },
            body: JSON.stringify({ fields })
          });
          const result = await response.json();
          if (result.code === 0) {
            console.log(`更新成功 [${product.id}]`);
            writeSuccess = true;
            allSuccess = true;
          } else {
            console.error(`更新失败 [${product.id}]: ${JSON.stringify(result)}`);
          }
        } catch (e) {
          console.error(`更新网络错误 [${product.id}]: ${e.message}`);
          if (attempt < 3) await sleep(2000);
        }
      }
      if (!writeSuccess) {
        allSuccess = false;
      }
    } else {
      // 创建新记录
      console.log(`创建 [${product.id}] 成交订单数:${product.orderCount} 退货率:${product.returnRate}...`);

      let writeSuccess = false;
      for (let attempt = 1; attempt <= 3 && !writeSuccess; attempt++) {
        try {
          const createUrl = `${baseUrl}/records`;
          const response = await fetch(createUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${accessToken}`
            },
            body: JSON.stringify({ fields })
          });
          const result = await response.json();
          if (result.code === 0) {
            console.log(`创建成功 [${product.id}]`);
            existingRecords.set(productIdStr, result.data.record.record_id);
            writeSuccess = true;
            allSuccess = true;
          } else {
            console.error(`创建失败 [${product.id}]: ${JSON.stringify(result)}`);
          }
        } catch (e) {
          console.error(`创建网络错误 [${product.id}]: ${e.message}`);
          if (attempt < 3) await sleep(2000);
        }
      }
      if (!writeSuccess) {
        allSuccess = false;
      }
    }
  }

  return allSuccess;
}

async function waitForQRCodeLogin(page) {
  process.stdout.write('请使用抖音App扫码登录...\n');
  process.stdout.write('等待扫码完成（超时10分钟）...\n');

  try {
    await page.waitForFunction(() => {
      return window.location.href.includes('fxg.jinritemai.com/ffa/mshop/homepage');
    }, { timeout: 600000 });
    const currentUrl = page.url();
    process.stdout.write('登录成功！当前URL: ' + currentUrl + '\n');
    return true;
  } catch (e) {
    const currentUrl = page.url();
    process.stdout.write('等待超时或页面跳转，当前URL: ' + currentUrl + '\n');
    return false;
  }
}

// 打开详情页获取真实退货率
async function getRefundRateFromDetailPage(context, page, productId) {
  console.log(`\n获取商品 ${productId} 的详情页退货率...`);

  // 点击"查看详情"按钮
  const clicked = await page.evaluate((pid) => {
    const rows = document.querySelectorAll('table tbody tr:not(.ecom-table-measure-row)');
    for (const row of rows) {
      const text = row.innerText;
      if (text.includes(pid)) {
        const buttons = row.querySelectorAll('button, a');
        for (const btn of buttons) {
          if (btn.innerText?.includes('查看详情')) {
            btn.click();
            return true;
          }
        }
      }
    }
    return false;
  }, productId);

  if (!clicked) {
    console.log('未找到查看详情按钮');
    return null;
  }

  // 等待新页面出现
  await sleep(10000);

  // 找到详情页
  let detailPage = null;
  const currentPages = context.pages();
  for (const p of currentPages) {
    if (p.url().includes('product-detail') && p.url().includes(productId)) {
      detailPage = p;
      break;
    }
  }

  if (!detailPage) {
    for (const p of currentPages) {
      if (p.url().includes('product-detail')) {
        detailPage = p;
        break;
      }
    }
  }

  if (!detailPage) {
    console.log('未找到详情页');
    return null;
  }

  // 确保详情页在前台（不调用bringToFront，避免页面不稳定）
  console.log('找到详情页，等待30秒让页面稳定...');

  // 直接等待30秒，不分段检查
  await sleep(30000);

  // 点击"退款及体验" - 使用鼠标点击（坐标更可靠）
  console.log('点击退款及体验...');
  try {
    if (detailPage.isClosed()) {
      console.log('详情页已关闭');
      return null;
    }
    // 使用鼠标点击"退款及体验"标签位置（大约在 left=280, top=260）
    await detailPage.mouse.click(280, 260);
    console.log('点击成功，等待30秒让数据加载...');
    await sleep(30000);
  } catch (e) {
    console.log('点击退款及体验失败:', e.message);
  }

  // 点击"自定义" - 使用JavaScript
  console.log('点击自定义日期...');
  try {
    if (detailPage.isClosed()) {
      console.log('详情页已关闭');
      return null;
    }
    await detailPage.evaluate(() => {
      const btns = document.querySelectorAll('button');
      for (const btn of btns) {
        if (btn.innerText && btn.innerText.includes('自定义') && btn.offsetParent !== null) {
          btn.click();
          return;
        }
      }
    });
    console.log('点击成功，等待3秒...');
    await sleep(3000);
  } catch (e) {
    console.log('点击自定义失败:', e.message);
  }

  // 设置日期 - 使用更可靠的方法
  const startDateStr = CONFIG.dateRange.startDate;
  const endDateStr = CONFIG.dateRange.endDate;
  console.log(`设置日期范围: ${startDateStr} 到 ${endDateStr}`);

  try {
    // 找到日期输入框并使用click+fill方法
    const startInput = detailPage.locator('input[placeholder="开始日期"]').first();
    const endInput = detailPage.locator('input[placeholder="结束日期"]').first();

    // 点击并等待一下
    await startInput.click({ timeout: 5000 });
    await sleep(500);

    // 全选并输入新值
    await startInput.selectText();
    await startInput.fill(startDateStr);
    await startInput.press('Tab');

    await endInput.click({ timeout: 5000 });
    await endInput.selectText();
    await endInput.fill(endDateStr);
    await endInput.press('Enter');

    console.log('日期已设置，等待15秒...');
    await sleep(15000);
  } catch (e) {
    console.log('填充日期失败:', e.message);
  }

  // 提取退货率和退款人数
  let refundRate = null;
  let refundCount = null;
  try {
    if (detailPage.isClosed()) {
      console.log('详情页已关闭');
      return null;
    }
    const pageText = await detailPage.evaluate(() => document.body.innerText);

    // 先找"退款率"后面的百分比
    const idx = pageText.indexOf('退款率');
    if (idx !== -1) {
      const chunk = pageText.substring(idx, idx + 200);
      const rateMatch = chunk.match(/(\d+\.?\d*)%/);
      if (rateMatch) {
        refundRate = rateMatch[1];
      }
    }

    // 如果没找到，尝试搜索页面中所有的百分比（排除"同行标杆"之类的）
    if (!refundRate) {
      const allRates = pageText.match(/\d+\.?\d*%/g);
      if (allRates && allRates.length > 0) {
        // 过滤掉"同行标杆"等非退款率数据
        for (const rate of allRates) {
          const numPart = rate.replace('%', '');
          const num = parseFloat(numPart);
          // 退款率通常是0-100%的数字
          if (num >= 0 && num <= 100 && !pageText.includes('同行标杆' + rate)) {
            // 确认这是退款率（前面有"退款"字）
            const rateIdx = pageText.indexOf(rate);
            const beforeText = pageText.substring(Math.max(0, rateIdx - 20), rateIdx);
            if (beforeText.includes('退款') || beforeText.includes('退')) {
              refundRate = numPart;
              break;
            }
          }
        }
      }
    }

    // 提取退款人数（第一个"退款人数"后面的数字）
    const countIdx = pageText.indexOf('退款人数');
    if (countIdx !== -1) {
      const countChunk = pageText.substring(countIdx, countIdx + 50);
      const countMatch = countChunk.match(/退款人数\s*(\d+)/);
      if (countMatch) {
        refundCount = parseInt(countMatch[1]);
      }
    }

    console.log(`提取到退货率: ${refundRate}%, 退款人数: ${refundCount}`);
    console.log(`详情页URL: ${detailPage.url()}`);

    // 退款人数少于3人，数据不准确，跳过修正退货率（保持为空）
    if (refundCount !== null && refundCount < 3) {
      console.log(`退款人数(${refundCount})少于3人，数据不准确，跳过修正退货率`);
      refundRate = null;
    }
  } catch (e) {
    console.log('提取页面内容失败:', e.message);
  }

  // 关闭详情页
  try {
    if (!detailPage.isClosed()) {
      await detailPage.close();
    }
  } catch (e) {
    console.log('关闭详情页失败:', e.message);
  }

  return refundRate;
}

// 从商品管理页面获取商品图片URL
async function getProductImageUrl(page, productId) {
  console.log(`\n获取商品 ${productId} 的图片...`);

  // 先尝试直接导航到商品管理页面
  try {
    await page.goto(CONFIG.douyin.productManageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);
  } catch (e) {
    console.log('导航到商品管理页面失败:', e.message);
    return null;
  }

  // 关闭弹窗
  try {
    const popupBtn = page.locator('text=知道了');
    if (await popupBtn.count() > 0) {
      await popupBtn.click();
      console.log('关闭弹窗');
      await page.waitForTimeout(2000);

      // 保存cookie
      const cookies = await page.context().cookies();
      fs.writeFileSync(CONFIG.cookiePath, JSON.stringify(cookies, null, 2));
      console.log('Cookie已保存');
    }
  } catch (e) {
    // 弹窗可能不存在，继续
  }

  // 搜索商品ID
  console.log(`搜索商品ID: ${productId}`);
  try {
    await page.evaluate((pid) => {
      const inputs = document.querySelectorAll('input');
      for (const inp of inputs) {
        if (inp.placeholder === '请输入商品名称/商品ID/商家编码，多条可用逗号隔开') {
          inp.focus();
          inp.value = pid;
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          return;
        }
      }
    }, productId);

    await page.waitForTimeout(5000);

    // 从商品行提取图片URL
    const imageData = await page.evaluate((pid) => {
      const rows = document.querySelectorAll('tbody tr');
      for (const row of rows) {
        if (row.innerText.includes(pid)) {
          const img = row.querySelector('img');
          if (img) {
            return {
              found: true,
              imageUrl: img.src,
              productName: row.innerText.split('\n')[0]?.trim()
            };
          }
        }
      }
      return { found: false };
    }, productId);

    if (imageData.found) {
      console.log(`找到商品图片: ${imageData.imageUrl}`);
      return imageData.imageUrl;
    } else {
      console.log('未找到商品图片');
      return null;
    }
  } catch (e) {
    console.log('搜索或提取图片失败:', e.message);
    return null;
  }
}

async function extractProductsOnPage(page) {
  // 从已加载的页面快速提取商品数据（无额外等待）
  return await page.evaluate(() => {
    const tables = document.querySelectorAll('table');
    let productTable = null;

    // 找到商品列表表格（包含"商品信息"表头）
    for (const t of tables) {
      // 检查 thead
      const thead = t.querySelector('thead');
      if (thead && thead.rows.length > 0) {
        const firstRow = thead.rows[0];
        if (firstRow && firstRow.innerText.includes('商品信息')) {
          productTable = t;
          break;
        }
      }
      // 检查 tbody
      const tbody = t.querySelector('tbody');
      if (tbody && tbody.rows.length > 0) {
        const firstRow = tbody.rows[0];
        if (firstRow && firstRow.innerText.includes('商品信息')) {
          productTable = t;
          break;
        }
      }
    }

    // 如果没找到商品表格，尝试找到最大的数据表格
    if (!productTable) {
      console.log('未找到"商品信息"表格，尝试查找最大数据表格...');
      let maxRows = 0;
      for (const t of tables) {
        const tbody = t.querySelector('tbody');
        if (tbody) {
          const rows = tbody.querySelectorAll('tr:not(.ecom-table-measure-row)');
          if (rows.length > maxRows) {
            // 检查是否包含ID或商品相关信息
            const hasProducts = rows.some(row =>
              row.innerText.includes('ID') ||
              row.innerText.match(/\d{15,20}/) ||
              row.innerText.includes('订单')
            );
            if (hasProducts) {
              maxRows = rows.length;
              productTable = t;
            }
          }
        }
      }
    }

    if (!productTable) {
      console.log('未找到合适的商品表格');
      return { error: 'no_table', tablesFound: tables.length, products: [] };
    }

    const results = [];
    const seenIds = new Set();
    const tbody = productTable.querySelector('tbody');
    if (!tbody) {
      return { error: 'no_tbody', products: [] };
    }
    const rows = tbody.querySelectorAll('tr:not(.ecom-table-measure-row)');

    // 动态检测列位置 - 从表头精确匹配
    let ID_COL = 1;
    let ORDER_COL = 3;
    let RATE_COL = 4;

    // 从 thead 获取表头信息
    const thead = productTable.querySelector('thead');
    if (thead && thead.rows.length > 0) {
      const headerCells = thead.rows[0].querySelectorAll('th');
      console.log(`表头有 ${headerCells.length} 列`);

      for (let i = 0; i < headerCells.length; i++) {
        const headerText = (headerCells[i].innerText || '').trim();
        console.log(`  列${i}: "${headerText}"`);

        // 匹配商品ID列
        if (headerText.includes('商品ID') || headerText === 'ID') {
          ID_COL = i;
        }
        // 匹配成交订单数列
        if (headerText.includes('成交') || headerText.includes('订单数')) {
          ORDER_COL = i;
        }
        // 匹配退款率列
        if (headerText.includes('退款率') || headerText.includes('退货率')) {
          RATE_COL = i;
        }
      }
      console.log(`动态检测列位置: ID=${ID_COL}, 订单数=${ORDER_COL}, 退货率=${RATE_COL}`);
    } else {
      console.log('未找到表头，使用默认列位置');
    }

    rows.forEach((row, idx) => {
      const rowText = row.innerText;
      // 支持多种ID格式：ID:数字、ID 数字、纯数字ID等
      const idMatch = rowText.match(/ID[\s:：]*(\d{10,20})/) || rowText.match(/\b(\d{15,20})\b/);

      if (idMatch && !seenIds.has(idMatch[1])) {
        const id = idMatch[1];
        seenIds.add(id);

        const cells = row.querySelectorAll('td');

        // 商品名称：从ID列和订单列之外的列提取
        let productName = '';
        for (let i = 0; i < cells.length; i++) {
          if (i !== ID_COL && i !== ORDER_COL && cells[i].innerText && !cells[i].innerText.includes('ID')) {
            const text = cells[i].innerText.trim();
            if (text && text.length > 1 && text.length < 100) {
              productName = text.split('\n')[0].substring(0, 50);
              break;
            }
          }
        }

        // 成交订单数：从检测到的订单列精确提取
        let orderCount = 0;
        if (cells[ORDER_COL]) {
          const cellText = (cells[ORDER_COL].innerText || '').replace(/,/g, '');
          const match = cellText.match(/(\d+)/);
          if (match) {
            orderCount = parseInt(match[1]);
          }
        }
        // 如果订单列没提取到，回退到搜索包含"单"的单元格
        if (orderCount === 0) {
          for (let i = 0; i < cells.length; i++) {
            if (cells[i] && cells[i].innerText) {
              const cellText = (cells[i].innerText || '').replace(/,/g, '');
              const match = cellText.match(/(\d+)单/);
              if (match) {
                orderCount = parseInt(match[1]);
                break;
              }
            }
          }
        }

        // 退款率：从检测到的退货率列精确提取
        let returnRate = -1;
        if (cells[RATE_COL]) {
          const cellText = (cells[RATE_COL].innerText || '').trim();
          const match = cellText.match(/(\d+\.?\d*)%/);
          if (match) {
            returnRate = parseFloat(match[1]);
          }
        }
        // 如果退货率列没提取到，回退到搜索百分数
        if (returnRate === -1) {
          for (let i = 0; i < cells.length; i++) {
            if (cells[i] && cells[i].innerText) {
              const cellText = (cells[i].innerText || '').trim();
              const match = cellText.match(/(\d+\.?\d*)%/);
              if (match) {
                returnRate = parseFloat(match[1]);
                break;
              }
            }
          }
        }

        results.push({
          id: id,
          name: productName || '商品',
          link: '',
          orderCount: orderCount,
          listReturnRate: returnRate,
          returnRate: returnRate
        });

        console.log(`提取商品: ${id} - ${productName}, 订单数: ${orderCount}, 退款率: ${returnRate}%`);
      }
    });

    return { products: results, rowCount: rows.length };
  });
}

// 检查是否有下一页
async function hasNextPage(page) {
  const result = await page.evaluate(() => {
    // 查找"共xxx条"元素
    let totalElement = null;
    const allElements = document.querySelectorAll('*');
    for (const el of allElements) {
      const text = el.innerText || '';
      if (text.includes('共') && text.includes('条') && text.match(/共\d+条/)) {
        totalElement = el;
        break;
      }
    }

    if (!totalElement) return { hasNext: false, reason: 'no_total_element' };

    // 收集页面底部区域的按钮（top > 1100）
    const bottomBtns = [];
    const allBtns = document.querySelectorAll('button');
    allBtns.forEach(b => {
      const rect = b.getBoundingClientRect();
      if (rect.top > 1100) { // 在页面底部
        bottomBtns.push({
          text: (b.innerText || '').trim(),
          html: b.innerHTML,
          ariaLabel: b.getAttribute('aria-label') || '',
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          top: Math.round(rect.top),
          disabled: b.disabled
        });
      }
    });

    // 查找"右箭头"按钮（下一页） - 排除"左箭头"（上一页）
    for (const btn of bottomBtns) {
      // 检查aria-label是否为right
      if (btn.ariaLabel === 'right') {
        if (!btn.disabled) {
          return { hasNext: true, reason: 'found_right_aria', btn };
        }
      }
      // 检查SVG是否包含right（不是left）
      if (btn.html.includes('right') && !btn.html.includes('left') && btn.html.includes('<svg')) {
        if (!btn.disabled) {
          return { hasNext: true, reason: 'found_right_svg', btn };
        }
      }
      // 检查文字是"›"且不是disabled
      if (btn.text === '›' && !btn.disabled) {
        return { hasNext: true, reason: 'found_arrow', btn };
      }
    }

    return { hasNext: false, reason: 'no_right_arrow', bottomBtns };
  });
  console.log(`  [hasNextPage] result=${JSON.stringify(result)}`);
  return result.hasNext;
}

// 点击下一页
async function goToNextPage(page) {
  const result = await page.evaluate(() => {
    // 收集页面底部区域的按钮（top > 1100）
    const allBtns = document.querySelectorAll('button');

    // 1. 查找"右箭头"按钮（aria-label="right"）
    for (const btn of allBtns) {
      const ariaLabel = btn.getAttribute('aria-label') || '';
      const rect = btn.getBoundingClientRect();
      if (ariaLabel === 'right' && rect.top > 1100 && !btn.disabled) {
        btn.click();
        return { clicked: true, method: 'aria-right', top: Math.round(rect.top) };
      }
    }

    // 2. 查找包含right SVG的按钮（不是left）
    for (const btn of allBtns) {
      const html = btn.innerHTML || '';
      const rect = btn.getBoundingClientRect();
      if (html.includes('right') && !html.includes('left') && html.includes('<svg') && rect.top > 1100 && !btn.disabled) {
        btn.click();
        return { clicked: true, method: 'svg-right', top: Math.round(rect.top) };
      }
    }

    // 3. 查找›符号按钮
    for (const btn of allBtns) {
      const text = btn.innerText?.trim();
      const rect = btn.getBoundingClientRect();
      if (text === '›' && rect.top > 1100 && !btn.disabled) {
        btn.click();
        return { clicked: true, method: 'arrow', top: Math.round(rect.top) };
      }
    }

    // 列出所有底部按钮用于调试
    const bottomBtns = [];
    allBtns.forEach(b => {
      const rect = b.getBoundingClientRect();
      if (rect.top > 1000) {
        bottomBtns.push({
          text: (b.innerText || '').trim().substring(0, 20),
          aria: b.getAttribute('aria-label') || '',
          html: (b.innerHTML || '').substring(0, 100),
          top: Math.round(rect.top),
          disabled: b.disabled
        });
      }
    });
    return { clicked: false, bottomBtns };
  });
  console.log(`  [goToNextPage] ${JSON.stringify(result)}`);
  return result.clicked;
}

async function extractProductData(page) {
  console.log('正在提取商品数据...');
  await page.waitForTimeout(3000);

  // 直接从表格提取商品数据
  const tableData = await page.evaluate(() => {
    const results = [];

    // 找到商品列表表格
    const tables = document.querySelectorAll('table');
    let productTable = null;

    for (const t of tables) {
      const tbody = t.querySelector('tbody');
      if (tbody && tbody.rows.length > 2) {
        const firstRow = tbody.rows[0];
        if (firstRow && firstRow.innerText.includes('商品信息')) {
          productTable = t;
          break;
        }
      }
    }

    if (!productTable) {
      for (const t of tables) {
        const tbody = t.querySelector('tbody');
        if (tbody && tbody.rows.length > 2) {
          productTable = t;
          break;
        }
      }
    }

    if (!productTable) {
      return { error: '未找到商品表格', tablesFound: tables.length };
    }

    const tbody = productTable.querySelector('tbody');
    const rows = tbody.querySelectorAll('tr:not(.ecom-table-measure-row)');

    rows.forEach((row) => {
      const cells = row.querySelectorAll('td');
      const rowText = row.innerText;

      const idMatch = rowText.match(/ID[\s:]*(\d{15,20})/);
      if (idMatch) {
        const productId = idMatch[1];

        let productName = '';
        if (cells.length > 1) {
          const firstCell = cells[1];
          if (firstCell) {
            const cellText = firstCell.innerText;
            productName = cellText.split('\n')[0].trim().substring(0, 50);
          }
        }

        // cells[2]=成交订单数, cells[3]=退款率(支付时间)
        let orderCount = 0;
        let returnRate = 0;

        if (cells.length > 4) {
          const cell2Text = (cells[2]?.innerText || '').replace(/,/g, '');
          const cell3Text = (cells[3]?.innerText || '').trim();

          const orderMatch = cell2Text.match(/(\d+)/);
          orderCount = orderMatch ? parseInt(orderMatch[1]) : 0;

          // 退款率必须是百分数格式（如 "82.53%"）
          const rateMatch = cell3Text.match(/(\d+\.?\d*)%/);
          returnRate = rateMatch ? parseFloat(rateMatch[1]) : -1;
        }

        results.push({
          id: productId,
          name: productName || '商品',
          link: '',
          orderCount: orderCount,
          listReturnRate: returnRate,  // 商品列表页的初步退款率
          returnRate: returnRate  // 详情页校验后的退款率（后续会被覆盖）
        });
      }
    });

    return {
      rowsFound: rows.length,
      productsFound: results.length,
      sampleRows: results.slice(0, 3)
    };
  });

  console.log('表格数据提取结果:', JSON.stringify(tableData, null, 2));

  if (tableData.error || tableData.productsFound === 0) {
    console.log('从未处理表格提取商品...');
  }

  // 返回从表格提取的结果
  const products = await page.evaluate(() => {
    const tables = document.querySelectorAll('table');
    let productTable = null;

    for (const t of tables) {
      const tbody = t.querySelector('tbody');
      if (tbody) {
        const firstRow = tbody.rows[0];
        if (firstRow && firstRow.innerText.includes('商品信息')) {
          productTable = t;
          break;
        }
      }
    }

    if (!productTable) {
      for (const t of tables) {
        const tbody = t.querySelector('tbody');
        if (tbody && tbody.rows.length > 2) {
          productTable = t;
          break;
        }
      }
    }

    if (!productTable) return [];

    const results = [];
    const seenIds = new Set();
    const tbody = productTable.querySelector('tbody');
    const rows = tbody.querySelectorAll('tr:not(.ecom-table-measure-row)');

    rows.forEach(row => {
      const rowText = row.innerText;
      const idMatch = rowText.match(/ID[\s:]*(\d{15,20})/);

      if (idMatch && !seenIds.has(idMatch[1])) {
        const id = idMatch[1];
        seenIds.add(id);

        const cells = row.querySelectorAll('td');
        let productName = '';
        let orderCount = 0;
        let returnRate = 0;

        if (cells.length > 1) {
          productName = cells[1].innerText.split('\n')[0].trim().substring(0, 50);
        }

        // cells[2]=成交订单数, cells[3]=退款率
        if (cells.length > 4) {
          const cell2Text = (cells[2]?.innerText || '').replace(/,/g, '');
          const cell3Text = (cells[3]?.innerText || '').trim();

          const orderMatch = cell2Text.match(/(\d+)/);
          orderCount = orderMatch ? parseInt(orderMatch[1]) : 0;

          // 退款率必须是百分数格式（如 "82.53%"）
          const rateMatch = cell3Text.match(/(\d+\.?\d*)%/);
          returnRate = rateMatch ? parseFloat(rateMatch[1]) : -1;
        }

        results.push({
          id: id,
          name: productName || '商品',
          link: '',
          orderCount: orderCount,
          listReturnRate: returnRate,  // 近30天退款率 - 来自列表页
          returnRate: returnRate  // 修正退款率 - 后续会被详情页覆盖
        });
      }
    });

    return results;
  });

  console.log('\n从列表提取到:', products.length, '个商品');
  return products;
}

async function processProductRound(page, context, targetCount, accessToken, shopName, intervalMinutes = 30) {
  let processedCount = 0;
  let writeCount = 0; // 实际写入数量
  let currentPage = 1;
  let hitZeroOrder = false;
  const processedProducts = []; // 收集本轮处理的商品数据

  // 每轮开始时刷新accessToken（避免过期）
  let freshToken = accessToken;
  try {
    freshToken = await getFeishuToken();
    console.log('AccessToken已刷新');
  } catch (e) {
    console.log('刷新AccessToken失败，使用旧token:', e.message);
  }

  // Step 3: 直接进入商品列表页面
  console.log('\nStep 3: 进入商品列表页面...');
  await page.goto('https://compass.jinritemai.com/shop/commodity/product-list', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await sleep(15000);
  console.log('当前URL:', page.url());

  // Step 4: 点击"近30天"按钮
  console.log('\nStep 4: 点击"近30天"...');

  // 增加页面稳定时间
  console.log('等待页面完全稳定...');
  await page.waitForLoadState('domcontentloaded', { timeout: 30000 });
  await sleep(5000);

  // 尝试点击"近30天"按钮，使用多种策略
  let clicked = false;
  try {
    // 策略1: 尝试更长的超时时间
    console.log('尝试点击"近30天"按钮（策略1）...');
    const thirtyDayBtn = page.locator('text=近30天').first();
    await thirtyDayBtn.waitFor({ timeout: 20000 });
    await thirtyDayBtn.click({ timeout: 20000 });
    clicked = true;
    console.log('点击了"近30天"按钮');
  } catch (e1) {
    console.log('策略1失败:', e1.message);
    try {
      // 策略2: 尝试不同的选择器
      console.log('尝试点击"近30天"按钮（策略2）...');
      const thirtyDayBtn2 = page.locator('button:has-text("近30天")').first();
      await thirtyDayBtn2.waitFor({ timeout: 20000 });
      await thirtyDayBtn2.click({ timeout: 20000 });
      clicked = true;
      console.log('策略2成功点击了"近30天"按钮');
    } catch (e2) {
      console.log('策略2也失败:', e2.message);
      try {
        // 策略3: 尝试点击下拉框或菜单项
        console.log('尝试点击"近30天"按钮（策略3）...');
        const thirtyDayBtn3 = page.locator('text=近30天').nth(1);
        await thirtyDayBtn3.waitFor({ timeout: 20000 });
        await thirtyDayBtn3.click({ timeout: 20000 });
        clicked = true;
        console.log('策略3成功点击了"近30天"按钮');
      } catch (e3) {
        console.log('策略3也失败:', e3.message);
        console.log('点击"近30天"失败，将尝试直接提取数据...');
      }
    }
  }

  // 等待数据加载
  if (clicked) {
    console.log('等待数据加载...');
    await sleep(60000); // 增加等待时间到60秒
  } else {
    // 如果点击失败，等待一段时间再尝试提取
    console.log('等待页面稳定后尝试提取数据...');
    await sleep(30000);
  }

  try {
    await page.screenshot({ path: 'step4-data.png', timeout: 10000 });
  } catch (e) {
    console.log('截图跳过:', e.message);
  }

  // Step 5: 提取商品数据并处理（支持翻页）
  console.log('\nStep 5: 提取并处理商品数据...');

  // 主循环：提取 -> 处理 -> 翻页，直到遇到订单数为0或无下一页
  while (true) {
    console.log(`\n--- 第 ${currentPage} 页 ---`);

    // 提取当前页商品
    let extractResult = await extractProductsOnPage(page);
    let products = extractResult.products || extractResult || [];
    if (extractResult.error) {
      console.log('提取失败:', extractResult.error, '表格数:', extractResult.tablesFound);
    } else {
      console.log(`表格总行数: ${extractResult.rowCount}, 提取到商品: ${products.length}`);
    }
    console.log(`提取到 ${products.length} 个商品`);

    // 打印商品列表
    if (products.length > 0) {
      console.log('商品列表:');
      products.forEach((p, i) => {
        console.log(`  ${i + 1}. ID: ${p.id}, 成交: ${p.orderCount}, 列表退货率: ${p.listReturnRate}%`);
      });
    }

    // 过滤出有订单的商品
    const productsWithOrders = products.filter(p => p.orderCount > 0);
    const zeroOrderCount = products.length - productsWithOrders.length;

    // 如果全部商品都是0单，停止翻页
    if (productsWithOrders.length === 0) {
      console.log(`所有 ${zeroOrderCount} 个商品订单数都是0，停止翻页`);
      hitZeroOrder = true;
      break;
    }

    // 如果有无订单的商品，记录一下但继续处理有订单的
    if (zeroOrderCount > 0) {
      console.log(`跳过 ${zeroOrderCount} 个0单商品`);
    }

    if (products.length === 0) {
      console.log('当前页无商品，尝试翻页...');
      const hasNext = await hasNextPage(page);
      if (!hasNext) {
        console.log('无下一页，停止');
        break;
      }
      await goToNextPage(page);
      await sleep(10000);
      currentPage++;
      continue;
    }

    // 处理商品 - 跳过已有记录的商品，尝试写入targetCount个商品
    console.log(`[循环开始] targetCount=${targetCount}, writeCount=${writeCount}, 当前页商品数=${productsWithOrders.length}`);

    // 创建一个共享的订单页面，所有商品复用
    let orderPage = null;
    try {
      orderPage = await context.newPage();
      await orderPage.goto(CONFIG.douyin.orderListUrl, { waitUntil: 'networkidle', timeout: 120000 });
      await orderPage.waitForTimeout(15000);
      try {
        await orderPage.locator('input[placeholder="请输入"]').first().waitFor({ state: 'visible', timeout: 10000 });
        console.log('订单列表页面加载完成');
      } catch (e) {
        console.log('等待输入框超时:', e.message);
      }
    } catch (e) {
      console.log('创建订单页面失败:', e.message);
    }

    for (const product of productsWithOrders) {
      // 已达目标数量，停止处理
      if (writeCount >= targetCount) {
        console.log(`已写入 ${writeCount}/${targetCount}，停止处理`);
        break;
      }
      console.log(`\n\n########## [商品ID: ${product.id}] ########## (已写入${writeCount}/${targetCount})`);

      // 检查前刷新token
      try {
        freshToken = await getFeishuToken();
      } catch (e) {}

      // 先检查飞书表格中是否有近期记录
      const existingRecord = await checkRecentRecord(freshToken, product.id);
      if (existingRecord) {
        // 即使跳过抓取，也要检查成本是否更新
        console.log(`  跳过抓取：近期已有记录，检查成本是否更新...`);
        // 使用共享的订单页面查询成本
        if (!orderPage || orderPage.isClosed()) {
          console.log('  订单页面不可用，跳过成本检查');
          continue;
        }
        try {
          // 清空搜索框并填入商品ID - 第二个输入框是"商品名称/ID"
          const input = orderPage.locator('input[placeholder="请输入"]').nth(1);
          await input.click();
          await input.fill(String(product.id));
          await input.press('Enter');
          await orderPage.waitForTimeout(10000);
          // 获取商家编码
          const costOrderData = await getOrderData(orderPage, CONFIG.douyin.orderListUrl);
          if (costOrderData && costOrderData.merchantCode) {
            const merchantCode = costOrderData.merchantCode;
            console.log(`  商家编码: ${merchantCode}`);
            // 查询成本
            let newCost = null;
            if (merchantCode.includes('+')) {
              const parts = merchantCode.split('+');
              const firstPrefix = parts[0].match(/^([a-zA-Z]+)/)[1];
              let totalCost = 0;
              let allFound = true;
              for (const part of parts) {
                const fullCode = /^[a-zA-Z]/.test(part) ? part : firstPrefix + part;
                const partCost = await getCostFrom4thTable(freshToken, fullCode);
                if (partCost !== null) totalCost += Number(partCost);
                else allFound = false;
              }
              if (allFound) newCost = Number(totalCost.toFixed(2));
            } else {
              newCost = await getCostFrom4thTable(freshToken, merchantCode);
            }
            if (newCost !== null && newCost !== undefined) {
              // 检查现有记录的成本是否需要更新
              const baseUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.feishu.app_token}/tables/${CONFIG.feishu.table_id}`;
              const recUrl = `${baseUrl}/records?page_size=100&filter=CurrentValue.[商品id]="${product.id}"`;
              const recRes = await fetch(recUrl, { headers: { 'Authorization': `Bearer ${freshToken}` } });
              const recData = await recRes.json();
              if (recData.data && recData.data.items && recData.data.items.length > 0) {
                const rec = recData.data.items[0];
                const oldCost = rec.fields['成本'];
                if (oldCost !== newCost) {
                  console.log(`  成本变化: ${oldCost} -> ${newCost}，更新记录`);
                  await fetch(`${baseUrl}/records/${rec.id}`, {
                    method: 'PUT',
                    headers: { 'Authorization': `Bearer ${freshToken}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ fields: { '成本': Number(newCost) } })
                  });
                } else {
                  console.log(`  成本无变化: ${newCost}`);
                }
              }
            }
          }
        } catch (e) {
          console.log(`  成本检查失败: ${e.message}`);
        }
        continue;
      }

      console.log(`  开始处理...`);
      console.log(`  开始处理，当前writeCount=${writeCount}`);

      // 获取详情页退货率
      const realReturnRate = await getRefundRateFromDetailPage(context, page, product.id);

      if (realReturnRate) {
        product.returnRate = realReturnRate;
        console.log(`>> 修正退货率: ${realReturnRate}%`);
      } else {
        // 修正退货率获取失败或退款人数不足，留空
        product.returnRate = null;
        console.log('>> 修正退货率为空');
      }

      // 使用共享的订单页面获取商家编码、最新售价、商品图片
      console.log('>> 从订单列表获取数据...');
      if (!orderPage || orderPage.isClosed()) {
        console.log('  订单页面不可用，跳过');
        continue;
      }
      try {
        // 列出所有输入框和它们附近的文字
        const pageInfo = await orderPage.evaluate(() => {
          const result = { inputs: [], labels: [] };

          // 获取所有input
          const inputs = document.querySelectorAll('input');
          inputs.forEach((inp, i) => {
            const rect = inp.getBoundingClientRect();
            if (rect.top >= 500 && rect.top <= 700) {
              // 找到这个input附近label
              const labels = [];
              const allLabels = document.querySelectorAll('label');
              allLabels.forEach(lbl => {
                const lblRect = lbl.getBoundingClientRect();
                if (Math.abs(lblRect.top - rect.top) < 20 && Math.abs(lblRect.left - rect.left) < 200) {
                  labels.push(lbl.innerText);
                }
              });

              result.inputs.push({
                index: i,
                placeholder: inp.placeholder,
                type: inp.type,
                top: rect.top,
                left: rect.left,
                width: rect.width,
                labels: labels
              });
            }
          });

          // 获取页面上的文字标签
          const allText = document.body.innerText;
          const searchLabels = ['商品名称', '订单编号', '收件人', '物流'];
          searchLabels.forEach(label => {
            if (allText.includes(label)) {
              result.labels.push(label);
            }
          });

          return result;
        });
        console.log(`  找到 ${pageInfo.inputs.length} 个输入框`);

        // 使用JavaScript定位"商品名称/ID"标签旁的输入框
        // 调试发现正确的输入框在y=593.5附近
        const inputResult = await orderPage.evaluate((pid) => {
          // 方法1: 尝试找"商品名称/ID"标签
          const allElements = document.querySelectorAll('*');
          let labelRect = null;
          for (const el of allElements) {
            const text = el.innerText || el.textContent || '';
            if (text.trim() === '商品名称/ID') {
              labelRect = el.getBoundingClientRect();
              break;
            }
          }

          if (!labelRect) {
            // 如果找不到"商品名称/ID"，尝试找"商品名称"
            for (const el of allElements) {
              const text = el.innerText || el.textContent || '';
              if (text.trim() === '商品名称') {
                labelRect = el.getBoundingClientRect();
                break;
              }
            }
          }

          // 方法2: 直接找y=590-600位置的输入框（根据调试结果）
          const inputs = document.querySelectorAll('input');
          let targetInput = null;

          // 首先尝试用标签位置来找
          if (labelRect) {
            for (const inp of inputs) {
              const rect = inp.getBoundingClientRect();
              // 在标签下方15-100像素，同一列附近
              if (rect.top > labelRect.top + 15 && rect.top < labelRect.top + 100 && Math.abs(rect.left - labelRect.left) < 250) {
                targetInput = inp;
                break;
              }
            }
          }

          // 如果没找到，使用y位置直接定位
          if (!targetInput) {
            for (const inp of inputs) {
              const rect = inp.getBoundingClientRect();
              // y=545-560, left>=800 是商品名称/ID输入框的位置
              if (rect.top >= 545 && rect.top <= 560 && rect.left >= 800) {
                targetInput = inp;
                break;
              }
            }
          }

          if (targetInput) {
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            nativeInputValueSetter.call(targetInput, pid);
            targetInput.dispatchEvent(new Event('input', { bubbles: true }));
            targetInput.dispatchEvent(new Event('change', { bubbles: true }));
            return { found: true, top: targetInput.getBoundingClientRect().top, left: targetInput.getBoundingClientRect().left, value: targetInput.value };
          }
          return { found: false, reason: labelRect ? '未找到输入框' : '未找到商品名称/ID标签' };
        }, product.id);
        // 使用可靠的方式搜索商品 - 第二个输入框是"商品名称/ID"
        const input = orderPage.locator('input[placeholder="请输入"]').nth(1);
        await input.click();
        await input.fill(String(product.id));
        await input.press('Enter');
        console.log('  使用fill+Enter搜索商品ID:', product.id);

        // 等待搜索结果
        await orderPage.waitForTimeout(8000);

        // 提取订单列表中的信息
        const orderData = await orderPage.evaluate((data) => {
          const { pid, pname } = data;
          const rows = document.querySelectorAll('tbody tr');

          // 收集调试信息
          const debugInfo = { rowCount: rows.length, pid, pname: pname?.substring(0, 20) };

          if (rows.length === 1 && rows[0].innerText.includes('暂无数据')) {
            return { found: false, reason: 'no_data', debug: debugInfo };
          }

          // 收集前3行的文本用于调试
          const sampleRows = [];
          for (let i = 0; i < Math.min(3, rows.length); i++) {
            sampleRows.push(rows[i].innerText.substring(0, 200));
          }
          debugInfo.sampleRows = sampleRows;

          // 遍历所有行，提取第一个有效订单的信息
          for (const row of rows) {
            const rowText = row.innerText || '';

            // 跳过空行或"暂无数据"
            if (!rowText || rowText.includes('暂无数据')) continue;

            // 只要行里有¥符号就认为是有效订单行
            if (!rowText.includes('¥')) continue;

            const img = row.querySelector('img');

            let merchantCode = '';
            const codeMatch = rowText.match(/商家编码[：:]\s*(\S+)/);
            if (codeMatch) merchantCode = codeMatch[1];

            let merchantIncome = '';
            const incomeMatch = rowText.match(/¥\s*([\d,]+\.?\d*)/g);
            if (incomeMatch && incomeMatch.length >= 2) {
              merchantIncome = incomeMatch[1].replace(/[¥,\s]/g, '');
            } else if (incomeMatch && incomeMatch.length === 1) {
              merchantIncome = incomeMatch[0].replace(/[¥,\s]/g, '');
            }

            // 找到第一个有金额的行就返回
            if (merchantIncome || merchantCode) {
              return {
                found: true,
                imageUrl: img ? img.src : '',
                merchantCode: merchantCode,
                merchantIncome: merchantIncome,
                debug: debugInfo
              };
            }
          }
          return { found: false, reason: 'not_found', debug: debugInfo };
        }, { pid: product.id, pname: product.name });
        console.log(`  订单数据: ${JSON.stringify(orderData)}`);

        if (orderData.found) {
          product.imageUrl = orderData.imageUrl || product.imageUrl;
          // 处理商家编码：去掉中文描述，保留字母、数字、+
          let processedCode = orderData.merchantCode;
          // 去掉连字符或下划线及其后面的所有内容（如 -XL, _XL, -浅蓝26 等）
          processedCode = processedCode.replace(/[-_].*$/, '');
          // 去掉中文字符（保留数字和字母）
          processedCode = processedCode.replace(/[一-龥]+/g, '');
          // 去掉所有剩余符号（保留字母、数字、+）
          processedCode = processedCode.replace(/[^a-zA-Z0-9+]/g, '');
          // 处理省略前缀的情况：+732 → 前缀+732（使用第一个编码的前缀）
          const firstCodeMatch = processedCode.match(/^([a-zA-Z]+)\d+/);
          if (firstCodeMatch) {
            const prefix = firstCodeMatch[1];
            // 把+数字的格式补全为前缀+数字
            processedCode = processedCode.replace(/\+(\d+)/g, '+' + prefix + '$1');
          }
          // 拆分多个编码（如XLFE756XLFE758 → [XLFE756, XLFE758]，XLFE756+XLFE758 → [XLFE756, XLFE758]）
          const allCodes = processedCode.match(/[a-zA-Z]+\d+/g);
          if (allCodes && allCodes.length >= 2) {
            const first = allCodes[0];
            const firstPrefix = first.match(/^([a-zA-Z]+)/)[1];
            const restParts = [];
            for (let i = 1; i < allCodes.length; i++) {
              const code = allCodes[i];
              const codePrefix = code.match(/^([a-zA-Z]+)/)[1];
              const codeNumber = code.match(/[a-zA-Z]+(\d+)/)[1];
              if (firstPrefix === codePrefix) {
                // 同档口缩写，省略前缀：XLFE756+758
                restParts.push(codeNumber);
              } else {
                // 不同档口缩写，保留全称：XLFE756+BCYZ123
                restParts.push(code);
              }
            }
            processedCode = first + '+' + restParts.join('+');
          } else if (allCodes && allCodes.length === 1) {
            processedCode = allCodes[0];
          }
          product.merchantCode = processedCode;
          product.merchantIncome = parseFloat(orderData.merchantIncome) || 0;
          console.log(`>> 图片:${orderData.imageUrl ? '有' : '无'} 商家编码:${product.merchantCode} 售价:${product.merchantIncome}`);

          // 查询成本（含+的编码拆分后分别查询再求和）
          console.log('>> 查询成本...');
          if (product.merchantCode.includes('+')) {
            const parts = product.merchantCode.split('+');
            const firstPrefix = parts[0].match(/^([a-zA-Z]+)/)[1];
            let totalCost = 0;
            let allFound = true;
            for (const part of parts) {
              // 还原省略前缀的编码（如758 → XLFE758）
              const fullCode = /^[a-zA-Z]/.test(part) ? part : firstPrefix + part;
              const partCost = await getCostFrom4thTable(freshToken, fullCode);
              if (partCost !== null) {
                totalCost += Number(partCost);
                console.log(`>> ${fullCode} 成本: ${partCost}`);
              } else {
                console.log(`>> ${fullCode} 成本: 未找到`);
                allFound = false;
              }
            }
            if (allFound) {
              product.cost = Number(totalCost.toFixed(2));
              console.log(`>> 合计成本: ${product.cost}`);
            } else {
              console.log('>> 部分编码成本未找到，跳过合计');
            }
          } else {
            const cost = await getCostFrom4thTable(freshToken, product.merchantCode);
            if (cost !== null) {
              product.cost = cost;
              console.log(`>> 成本: ${cost}`);
            } else {
              console.log('>> 成本: 未找到');
            }
          }

          // 数据校验：跳过明显异常的数据避免污染
          const listRate = product.listReturnRate;
          const correctedRate = product.returnRate;
          const isInvalidRate = (r) => r === null || r === undefined || r === -1 || isNaN(r) || r < 0 || r > 100;
          if (isInvalidRate(listRate) || (correctedRate !== null && correctedRate !== undefined && isInvalidRate(correctedRate))) {
            console.log(`>> 跳过：数据异常 (列表退货率=${listRate}%, 修正退货率=${correctedRate}%)，不写入飞书`);
            continue;
          }

          // 写入飞书前刷新token（避免过期）
          try {
            freshToken = await getFeishuToken();
          } catch (e) {
            console.log(`>> 刷新token失败: ${e.message}`);
          }

          // 立即写入飞书
          console.log('>> 写入飞书...');
          let writeSuccess = false;
          try {
            writeSuccess = await writeToFeishu(freshToken, [product], shopName);
          } catch (e) {
            console.log(`>> 写入飞书出错: ${e.message}`);
          }
          if (writeSuccess) {
            console.log('>> 写入完成');
            writeCount++;
            // 收集商品数据用于清理旧记录
            processedProducts.push({
              id: product.id,
              orderCount: product.orderCount
            });
          } else {
            console.log('>> 写入失败');
          }
        } else {
          console.log(`  未找到订单记录`);
        }
      } catch (e) {
        console.log(`  查询失败: ${e.message}`);
      }
      await sleep(2000);
    }

    // 关闭共享的订单页面
    if (orderPage && !orderPage.isClosed()) {
      try { await orderPage.close(); } catch {}
    }

    // 当前页处理完毕，检查是否需要翻页
    // 如果没有找到有订单的商品，停止翻页
    if (productsWithOrders.length === 0) {
      console.log('当前页没有有订单的商品，停止翻页');
      break;
    }

    // 检查是否已写入够目标数量
    if (writeCount >= targetCount) {
      console.log(`已写入 ${writeCount}/${targetCount} 个商品，完成本轮`);
      break;
    }

    // 未够目标数量，尝试翻到下一页
    console.log(`未写入够 ${writeCount}/${targetCount}，尝试翻到下一页...`);
    const clicked = await goToNextPage(page);
    if (!clicked) {
      // 如果点击失败，再检查是否有下一页
      const hasNext = await hasNextPage(page);
      if (!hasNext) {
        console.log('无下一页按钮，停止');
        break;
      }
      console.log('翻页失败但检测到有下一页，重试...');
      await sleep(2000);
      const retryClicked = await goToNextPage(page);
      if (!retryClicked) {
        console.log('重试翻页也失败，停止');
        break;
      }
    }

    await sleep(10000); // 等待新页面加载
    currentPage++;
  }

  console.log(`\n本轮处理完成：写入${writeCount}个商品`);

  return { processedCount, writeCount, hitZeroOrder, processedProducts };
}

async function main() {
  console.log('===========================================');
  console.log('抖店商品数据采集脚本');
  console.log('===========================================\n');

  // 参数解析: argv[2]=targetCount, argv[3]=intervalMinutes, argv[4]='multi'
  // shopName通过临时文件传递
  const targetCount = parseInt(process.argv[2]) || 1;
  const intervalMinutes = parseInt(process.argv[3]) || 30;
  const isMultiMode = process.argv[4] === 'multi';

  // 从临时文件读取店铺名
  let shopNameArg = '';
  const shopNameFile = path.join(__dirname, 'current_shop.txt');
  try {
    if (fs.existsSync(shopNameFile)) {
      shopNameArg = fs.readFileSync(shopNameFile, 'utf-8').trim();
    }
  } catch (e) {}
  process.stdout.write('shopName from file: ' + shopNameArg + '\n');

  // 从临时文件读取费用配置
  let shippingFee = 2.1;
  let insurance = 4.01;
  const feeConfigFile = path.join(__dirname, 'fee_config.json');
  try {
    if (fs.existsSync(feeConfigFile)) {
      const feeConfig = JSON.parse(fs.readFileSync(feeConfigFile, 'utf-8'));
      shippingFee = feeConfig.shippingFee || 2.1;
      insurance = feeConfig.insurance || 4.01;
    }
  } catch (e) {}
  process.stdout.write('Fee config: shipping=' + shippingFee + ', insurance=' + insurance + '\n');
  SHIPPING_FEE = shippingFee;
  INSURANCE = insurance;

  // 构建cookie路径
  let cookiePath = path.join(COOKIES_DIR, 'default.json');
  if (shopNameArg) {
    const safeName = shopNameArg.replace(/[\\/:*?"<>|]/g, '_');
    cookiePath = path.join(COOKIES_DIR, safeName + '.json');
    process.stdout.write('Cookie路径: ' + cookiePath + '\n');
  }

  console.log(`目标处理商品数: ${targetCount}`);
  if (isMultiMode) {
    console.log(`多次执行模式，间隔: ${intervalMinutes} 分钟`);
  }

  const browser = await chromium.launch({
    headless: false,
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    args: [
      '--start-maximized',
      '--window-size=1920,1080',
      '--disable-web-security'
    ]
  });

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1
  });

  const page = await context.newPage();

  // 最大化窗口
  await page.bringToFront();
  await page.evaluate(() => {
    if (window.screen) {
      window.moveTo(0, 0);
      window.resizeTo(window.screen.availWidth, window.screen.availHeight);
    }
  });

  let loginSuccess = false;

  try {
    // 尝试加载保存的Cookie
    const cookieLoaded = await loadCookiesFromPath(context, cookiePath);
    if (!cookieLoaded) {
      console.log('未找到保存的Cookie或Cookie加载失败');
    }

    // Step 1: 访问抖店登录页/首页
    process.stdout.write('\nStep 1: 访问抖店首页...\n');
    process.stdout.write('正在加载页面，请稍候...\n');
    await page.goto(CONFIG.douyin.loginUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
    process.stdout.write('页面加载完成，等待5秒稳定...\n');
    await sleep(5000);
    await page.screenshot({ path: 'step1-homepage.png' });

    const isLoggedIn = await page.evaluate(() => {
      return window.location.href.includes('fxg.jinritemai.com/ffa/mshop/homepage');
    });

    if (!isLoggedIn) {
      process.stdout.write('需要扫码登录...\n');
      loginSuccess = await waitForQRCodeLogin(page);
      if (loginSuccess) {
        await saveCookiesToPath(context, cookiePath);
        process.stdout.write('登录成功！\n');
      } else {
        process.stdout.write('登录失败！\n');
      }
    } else {
      process.stdout.write('已检测到登录状态（Cookie有效）\n');
      loginSuccess = true;
    }

    if (!loginSuccess) {
      console.log('登录未成功，退出');
      if (shopNameArg) {
        console.log(`COOKIE_EXPIRED:${shopNameArg}`);
        // 写标记文件，让服务器检测
        try {
          const markerFile = path.join(__dirname, 'cookie_expired.txt');
          fs.writeFileSync(markerFile, shopNameArg);
          console.log('已写入cookie过期标记文件');
        } catch (e) {}
      }
      return;
    }

    // 等待页面稳定
    await sleep(5000);
    await page.screenshot({ path: 'step1-after-login.png' });

    // Step 2: 进入电商罗盘
    process.stdout.write('\nStep 2: 进入电商罗盘...\n');
    process.stdout.write('正在加载页面...\n');
    await page.goto('https://compass.jinritemai.com/shop', { waitUntil: 'domcontentloaded', timeout: 60000 });
    process.stdout.write('页面加载完成，等待30秒稳定...\n');
    await sleep(30000);
    process.stdout.write('当前URL: ' + page.url() + '\n');

    // 获取店铺名称（页面右上角）
    console.log('\n获取店铺名称...');
    let shopName = await page.evaluate(() => {
      // 找右上角包含"瑾"的元素 (left > 1500, top < 200)
      const allElements = document.querySelectorAll('*');
      for (const el of allElements) {
        const text = el.innerText?.trim();
        const rect = el.getBoundingClientRect();
        if (text && text.includes('瑾') && text.length > 2 && text.length < 15 &&
            rect.left > 1500 && rect.top > 150 && rect.top < 200 && rect.width > 0 && rect.height > 0) {
          return text.split('\n')[0].trim(); // 只取第一行
        }
      }
      return '';
    });
    if (!shopName) {
      // 如果获取失败，尝试从首页获取
      console.log('从首页重新获取店铺名称...');
      await page.goto('https://fxg.jinritemai.com/ffa/mshop/homepage/index', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(8000);
      shopName = await page.evaluate(() => {
        const allElements = document.querySelectorAll('*');
        for (const el of allElements) {
          const text = el.innerText?.trim();
          const rect = el.getBoundingClientRect();
          if (text && text.includes('瑾') && text.length > 2 && text.length < 15 &&
              rect.left > 1500 && rect.top > 150 && rect.top < 200) {
            return text.split('\n')[0].trim();
          }
        }
        return '';
      });
    }
    if (!shopName && shopNameArg) {
      shopName = shopNameArg;
    }
    console.log(`店铺名称: ${shopName}`);

    const accessToken = await getFeishuToken();

    if (isMultiMode) {
      // 多次执行模式：循环直到遇到0单商品
      let roundCount = 1;
      while (true) {
        console.log(`\n========== 第 ${roundCount} 轮执行 ==========`);
        const result = await processProductRound(page, context, targetCount, accessToken, shopName, intervalMinutes);

        if (result.hitZeroOrder) {
          console.log('\n遇到0单商品，多次执行停止');
          break;
        }

        if (result.writeCount === 0) {
          console.log('\n本轮未写入任何商品，停止多次执行');
          break;
        }

        // 清理旧记录
        if (result.processedProducts && result.processedProducts.length > 0) {
          const minOrderCount = Math.min(...result.processedProducts.map(p => p.orderCount));
          console.log(`\n[清理] 本轮处理了 ${result.processedProducts.length} 个商品，最小订单数: ${minOrderCount}`);
          await cleanOldRecords(accessToken, shopName, minOrderCount);
        }

        console.log(`\n等待 ${intervalMinutes} 分钟后继续第 ${roundCount + 1} 轮...`);
        await sleep(intervalMinutes * 60 * 1000);
        roundCount++;
      }
    } else {
      // 单次执行模式
      const result = await processProductRound(page, context, targetCount, accessToken, shopName, intervalMinutes);

      // 清理旧记录
      if (result.processedProducts && result.processedProducts.length > 0) {
        const minOrderCount = Math.min(...result.processedProducts.map(p => p.orderCount));
        console.log(`\n[清理] 本轮处理了 ${result.processedProducts.length} 个商品，最小订单数: ${minOrderCount}`);
        await cleanOldRecords(accessToken, shopName, minOrderCount);
      }
    }

    // Step 7: 截图保存商品列表（调试用，失败不影响流程）
    console.log('\nStep 7: 截图保存商品列表...');
    try {
      await page.screenshot({
        path: `product-list-final-${Date.now()}.png`,
        fullPage: false,
        timeout: 10000
      });
    } catch (e) {
      console.log('截图跳过:', e.message);
    }

  } catch (error) {
    console.error('执行出错:', error.message);
    if (!loginSuccess && shopNameArg) {
      console.log(`COOKIE_EXPIRED:${shopNameArg}`);
      try {
        fs.writeFileSync(path.join(__dirname, 'cookie_expired.txt'), shopNameArg);
      } catch (e) {}
    }
  } finally {
    if (!loginSuccess && shopNameArg) {
      console.log(`COOKIE_EXPIRED:${shopNameArg}`);
      try {
        fs.writeFileSync(path.join(__dirname, 'cookie_expired.txt'), shopNameArg);
      } catch (e) {}
    }
    await browser.close();
    console.log('\n脚本执行完毕');
  }
}

// 运行主程序
main();