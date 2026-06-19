/**
 * write_final.js - 写入飞书表格（修复版）
 * 修复：① VIDEO_DATE 从票据日期自动推断 ② 修复 path 未定义 ③ 视频重命名
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const APP_ID = 'cli_a91ad5ae63385bc9';
const APP_SECRET = 'ga7Gn6pBJgUkftKY2JEpFe3TJFpB2Mun';

const args = process.argv.slice(2);
const RESULT_JSON = args[0];
const APP_TOKEN = args[1] || 'CfAXbSrUFaBLv3stSRrcuUVon1b';
const TABLE_ID = args[2] || 'tblua6KaZ6PiWAp6';

// 将时间字符串转为毫秒时间戳
function parseTimeToMs(timeStr) {
    if (!timeStr) return null;
    // 已经是数字
    if (/^\d+$/.test(timeStr)) return parseInt(timeStr);
    // 尝试解析 "2026-04-17 13:10" 格式
    const match = timeStr.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
    if (match) {
        return new Date(match[1], match[2]-1, match[3], match[4], match[5]).getTime();
    }
    return null;
}

const RECORD_TIME_MS = parseTimeToMs(args[3] || new Date().toISOString().substring(0, 16).replace('T', ' '));
const VIDEO_PATH = args[4] || '';
const SEQ_NO = args[5] || '001';
const TOTAL_IMAGES = parseInt(args[6]) || 1;
const CURRENT_IMAGE = parseInt(args[7]) || 1;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function request(options, postData) {
    return new Promise((resolve) => {
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({ raw: data }); } });
        });
        req.on('error', e => resolve({ error: e.message }));
        req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
        req.setTimeout(30000);
        if (postData) req.write(postData);
        req.end();
    });
}

async function getToken() {
    const d = JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET });
    return request({
        hostname: 'open.feishu.cn',
        path: '/open-apis/auth/v3/tenant_access_token/internal',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) }
    }, d).then(r => r.tenant_access_token);
}

async function uploadFile(token, filePath, fileName) {
    const fileSize = fs.statSync(filePath).size;
    const fileBuffer = fs.readFileSync(filePath);
    const boundary = 'FeishuBoundary' + Date.now();
    const headerParts = [
        `--${boundary}\r\nContent-Disposition: form-data; name="file_name"\r\n\r\n${fileName}`,
        `--${boundary}\r\nContent-Disposition: form-data; name="parent_type"\r\n\r\nbitable_file`,
        `--${boundary}\r\nContent-Disposition: form-data; name="parent_node"\r\n\r\n${APP_TOKEN}`,
        `--${boundary}\r\nContent-Disposition: form-data; name="size"\r\n\r\n${fileSize}`,
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: image/jpeg\r\n\r\n`,
    ].join('\r\n');
    const body = Buffer.concat([Buffer.from(headerParts, 'utf8'), fileBuffer, Buffer.from(`\r\n--${boundary}--`)]);

    // 重试3次，每次间隔递增
    for (let attempt = 0; attempt < 4; attempt++) {
        if (attempt > 0) {
            await sleep(5000 * attempt);  // 0s → 5s → 10s → 15s
            console.warn(`  上传重试 ${attempt + 1}/3...`);
        }
        const result = await request({
            hostname: 'open.feishu.cn',
            path: '/open-apis/drive/v1/files/upload_all',
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': `multipart/form-data; boundary=${boundary}`,
                'Content-Length': body.length
            }
        }, body);
        if (result.code === 0) return result;
        if (result.code === 795) throw new Error('FEISHU_STORAGE_QUOTA_EXCEEDED');
        if (attempt === 3) return result;  // 最后一次也失败就放弃
    }
}

async function createRecord(token, fields) {
    const data = JSON.stringify({ fields });
    return request({
        hostname: 'open.feishu.cn',
        path: `/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/records`,
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data)
        }
    }, data);
}

// ========== 字段解析函数 ==========

function parsePrintTime(ocrText) {
    // 单据打印时间 = 票据结尾的时间戳，如 "2026-03-22 15:58:25"
    const tsMatch = ocrText.match(/(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/);
    if (tsMatch) return { full: tsMatch[1], date: tsMatch[1].split(' ')[0] };
    // 兼容 HH:MM（无秒）
    const tsMatch2 = ocrText.match(/(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})(?!\d)/);
    if (tsMatch2) return { full: tsMatch2[1], date: tsMatch2[1].split(' ')[0] };
    const dMatch = ocrText.match(/(\d{4}-\d{2}-\d{2})/);
    if (dMatch) return { full: dMatch[1], date: dMatch[1] };
    return null;
}

function parseBillDate(ocrText) {
    // 开单日期 = 票据中"日期:"或"时间:"后面的日期
    // 兼容四位年份和两位年份（如 26-04-23 → 2026-04-23）
    const m = ocrText.match(/(?:日期|时间)[:：]\s*(\d{2,4}-\d{2}-\d{2})/);
    if (m) {
        let date = m[1];
        if (/^\d{2}-\d{2}-\d{2}$/.test(date)) {
            const prefix = parseInt(date.substring(0, 2), 10) >= 50 ? '19' : '20';
            date = prefix + date;
        }
        return date;
    }
    return null;
}

function parseBatch(ocrText) {
    // 先尝试批次（行首或换行后，兼容"- "前缀），再尝试小票/单号/单据号
    const m = ocrText.match(/(?:^|\n)\s*(?:[-*]\s*)?(?:批次|小票|单号|单据号)[:：]\s*(\S+)/);
    let b = '';
    if (m) b = m[1].replace(/^[^0-9A-Za-z]+/, '').trim();
    // 兼容订单编号
    if (!b) {
        const m2 = ocrText.match(/订单编号[:：]\s*(\S+)/);
        if (m2) b = m2[1].replace(/^[^0-9A-Za-z]+/, '').trim();
    }
    // 批次号低于5位时补日期
    if (b && b.length < 5) {
        const now = new Date();
        const mm = String(now.getMonth() + 1).padStart(2, '0');
        const dd = String(now.getDate()).padStart(2, '0');
        b = b + '-' + mm + dd;
    }
    return b;
}

function isShopNameSuspicious(name) {
    if (!name || name.length < 2 || name.length > 12) return true;
    const bad = ['条形码', '区域', '销售明细', '退货明细', '销售/退货', '完整提取', '未付', '合计', '总计', '销售单', '退货单', '销售退货单', '收款单', '客户联', '存根联', '二维码', '微信', '支付宝'];
    if (bad.some(k => name.includes(k))) return true;
    if (/^\d+$/.test(name)) return true;
    return false;
}

function parseShopName(ocrText) {
    const allLines = ocrText.split('\n');
    const lines = allLines.slice(0, 8);  // 扩大扫描范围
    let firstContentLine = '';
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const stripped = line.trim().replace(/^```[a-zA-Z]*\n?/g, '');
        if (stripped === '客户联' || stripped === '存根联' || stripped === '客户版') continue;
        if (stripped === '销售明细' || stripped === '销售/退货明细') continue;
        if (stripped === '销售单' || stripped === '退货单' || stripped === '销售退货单') continue;
        // 跳过状态标记词
        if (['草稿', '打印', '复制', '作废', '已打印', '已作废'].includes(stripped)) continue;
        // 跳过单据类型行
        if (['批发单', '进货单', '采购单'].includes(stripped)) continue;
        // 跳过进销存软件名称和无关行
        if (['秦丝', '商陆花', '笑铺日记'].includes(stripped)) continue;
        if (/qinsilk\.com|shanluhua|一笑铺日记/.test(stripped)) continue;
        // 跳过UI元素和无关行
        if (/^[<🔔]/.test(stripped)) continue;
        if (/小票详情|切换样式|开通线上|一键邀请|复制$/.test(stripped)) continue;
        if (/^\d{11}$/.test(stripped)) continue;  // 纯手机号
        if (stripped && stripped !== '```') { firstContentLine = stripped; break; }
    }
    console.log('  [parseShopName] firstContentLine:', firstContentLine);

    let name = firstContentLine;
    if (!name) return '';

    // 第一步：去掉括号
    name = name.replace(/[（()）【】\[\]]+/g, '');
    // 第二步：去掉店名内部的分隔符（点号、斜杠、中横线等连接符）
    name = name.replace(/\s*[./·\-\u2013\u2014\u0300\u0301\u0304\u0306]+\s*/g, '');
    // 先去掉Markdown OCR常见后缀（必须在去掉销售单之前）
    name = name.replace(/\s*(?:单据完整信息|完整信息提取|信息提取)[：:]?\s*$/, '').trim();
    name = name.replace(/\s*(?:销售退货单|退货单|销售单|收款单)\s*$/, '').trim();
    // 去掉客户联/存根联后缀（OCR有时会把它们粘到同一行）
    name = name.replace(/\s*(?:客户联|存根联)\s*$/, '').trim();
    // 客户联去掉后，销售单可能暴露到末尾，再清一次
    name = name.replace(/\s*(?:销售退货单|退货单|销售单|收款单)\s*$/, '').trim();
    name = name.replace(/\s*(?:完整信息提取|信息提取)[：:]?\s*$/, '').trim();
    // 第三步：去掉地址（欧洲城、欧洲城店、国际面料城、万象汇、万象会、世贸、万达、广场、商城）
    name = name.replace(/(欧洲城店|欧洲城|国际面料城|万象汇|万象会|世贸|万达|广场|商城|合泰轻纺城|和泰轻纺城)/g, '');
    // 去掉服饰厂后缀
    name = name.replace(/服饰厂\s*$/, '').replace(/服饰\s*$/, '').trim();
    // 去掉女裤裤业等后缀
    name = name.replace(/(女裤|裤业|时尚女装)\s*$/, '').trim();
    // 去掉产品描述后缀
    name = name.replace(/(半身裙|连衣裙|T恤|衬衫|裤子|短裙|外套|上衣|套装)\s*$/, '').trim();
    // 去掉楼层房号（4楼-430或4楼-430号后面接商店名）
    // 前瞻改为允许中文字符，避免 OCR 返回"4楼2号销售单"时"号"后为"销"导致前瞻失败
    name = name.replace(/(?:富|负)?[一二三四五六七八九十\d]+楼-?[a-zA-Z]?\d*(?:号(?=[^0-9A-Za-z]|$))?/g, '').replace(/号\s*$/, '').trim();
    // 如果处理后为空，尝试原始行去掉这些后缀
    if (!name.trim() && firstContentLine) {
        name = firstContentLine;
        name = name.replace(/[（()）【】\[\]]+/g, '');
        name = name.replace(/\s*(?:销售退货单|退货单|销售单)\s*$/, '').trim();
        name = name.replace(/\s*(?:客户联|存根联)\s*$/, '').trim();
        name = name.replace(/\s*(?:销售退货单|退货单|销售单)\s*$/, '').trim();
        name = name.replace(/(欧洲城店|欧洲城|国际面料城|万象汇|万象会|世贸|万达|广场|商城|合泰轻纺城|和泰轻纺城)/g, '');
        name = name.replace(/服饰厂\s*$/, '').replace(/服饰\s*$/, '').trim();
        name = name.replace(/(女裤|裤业|时尚女装)\s*$/, '').trim();
        name = name.replace(/(?:富|负)?[一二三四五六七八九十\d]+楼-?[a-zA-Z]?\d*(?:号(?=[^0-9A-Za-z]|$))?/g, '').replace(/号\s*$/, '').trim();
    }
    // 去掉末尾的城市名后缀（如"株洲市" -> "予檬"）
    name = name.replace(/^[一-龥]{2,4}市/, '');
    // 如果仍然是空的，返回空字符串（不要返回原始未处理的字符串）
    if (!name.trim()) return '';
    // 去掉开头的#和空白符号，以及所有【】[]符号和横杠-
    name = name.replace(/^[#\s]+/, '').replace(/^[【】\[\]]+/, '').replace(/[【】\]]+$/, '').replace(/-/g, '');
    // 特例：婉星 -> 婉星儿（必须在去掉#前缀之后）
    if (name === '婉星') name = '婉星儿';
    // 特例：梦莎娜熙恒 -> 梦莎娜
    if (name === '梦莎娜熙恒') name = '梦莎娜';
    // 特例：喜梦露 -> 荷传
    if (name === '喜梦露') name = '荷传';
    // 去掉最左边的字母段（只去掉字母，不影响中文字符）
    name = name.replace(/^[^0-9a-zA-Z\u4e00-\u9fa5]*[a-zA-Z]+/, '');
    // \u6700\u7ec8\u6821\u9a8c\uff1a\u6e05\u6d17\u540e\u4ecd\u542b\u9500\u552e\u5355/\u9000\u8d27\u5355\u7b49\u5173\u952e\u5b57\uff0c\u8bf4\u660eOCR\u683c\u5f0f\u5f02\u5e38\uff0c\u8fd4\u56de\u7a7a
    if (/\u9500\u552e\u5355|\u9000\u8d27\u5355|\u9500\u552e\u9000\u8d27\u5355|\u5ba2\u6237\u8054|\u5b58\u6839\u8054/.test(name)) return '';
    console.log('  [parseShopName] final:', name);
    return name;
}

function parseCustomer(ocrText) {
    const m = ocrText.match(/(?:客户信息|客户)[:：]\s*(\S+)/);
    return m ? m[1].trim() : '';
}

function parseAddress(ocrText) {
    // 优先从 门店地址: 行提取（客户地址常为空，门店地址才有值）
    const storeAddrMatch = ocrText.match(/门店地址[:：]\s*(.+?)(?=\n|$)/);
    if (storeAddrMatch) {
        let addr = storeAddrMatch[1].trim().replace(/[，,]\s*.*店\s*$/, '').trim(); // 去掉末尾"，万象汇店"
        if (addr && addr.length >= 4) return addr.substring(0, 200);
    }
    // 其次从 客户地址:/地址:/店址: 行提取
    const addrMatch = ocrText.match(/(?:客户地址|地址|店址)[:：]\s*(.+?)(?=\n\s*(?:[-*]\s*)?(?:电话|账号|备注|经办|门店|提醒|$))/);
    if (addrMatch) {
        let addr = addrMatch[1].trim();
        if (addr && addr.length >= 4) return addr.substring(0, 200);
    }
    // fallback：从第一行提取（格式如"欧洲城同花向往2楼043销售单"）
    const lines = ocrText.split('\n');
    for (const line of lines.slice(0, 5)) {
        const areaMatch = line.match(/(欧洲城(?:国际面料城|世贸|万达|广场|商城)?)/);
        if (areaMatch) {
            const area = areaMatch[1];
            const rest = line.slice(area.length);
            const floorMatch = rest.match(/(\d+楼\d+)(?!.*\d+楼\d+)/);
            const addr = floorMatch ? area + floorMatch[1] : area;
            if (addr.length >= 4) return addr.substring(0, 200);
        }
    }
    // fallback2：匹配独立地址行（含市场名+楼号，如"株洲市欧洲城3楼888号"或"万象汇富一楼A68号"）
    for (const line of lines) {
        const m = line.match(/(?:欧洲城|万象汇|世贸|万达|广场|商城|市场)\S*?(?:富|负)?(?:[一二三四五六七八九十\d]+)楼\S+/);
        if (m) return m[0].substring(0, 200);
    }
    return '';
}

function parsePrevBalance(ocrText) {
    const m = ocrText.match(/(?:上次欠款|上次欠|上次余额|上次结余|上次余|上期余额)[:：\s]*[¥￥]?\s*(-?\d{1,10}(?:\.\d{1,2})?)/);
    if (!m) return 0;
    const val = parseFloat(m[1]);
    return /上次欠|上次欠款/.test(m[0]) ? val * -1 : val;
}

function parseCumulativeBalance(ocrText) {
    const m = ocrText.match(/(?:累计欠款|累计欠|累计结余|累计余|总计欠款|总欠款|累计余额)[:：\s]*[¥￥]?\s*(-?\d{1,10}(?:\.\d{1,2})?)/);
    if (!m) return 0;
    const val = parseFloat(m[1]);
    const matched = m[0];
    return /累计欠|累计欠款|总计欠款|总欠款/.test(matched) ? val * -1 : val;
}

function parseRealReceived(ocrText) {
    const m = ocrText.match(/实收(?:金额)?[:：\s]*[¥￥]?\s*(-?\d{1,10}(?:\.\d{1,2})?(?![0-9]))/);
    return m ? parseFloat(m[1]) : 0;
}

function parseTotal(ocrText) {
    // 将换行符替换为空格，处理OCR文本中关键词被换行分割的情况
    const text = ocrText.replace(/\n/g, ' ');

    // 优先匹配带"元"的金额（更可靠）
    const m0 = text.match(/扫\s*码\s*支\s*付[:：\s]*[¥￥]?\s*(-?\d{1,8}(?:\.\d{1,2})?)\s*元/);
    if (m0) return parseFloat(m0[1]);
    const m1 = text.match(/(?:实\s*付|已\s*付|付\s*款)[:：\s]*[¥￥]?\s*(-?\d{1,8}(?:\.\d{1,2})?)\s*元/);
    if (m1 && parseFloat(m1[1]) > 0) return parseFloat(m1[1]);
    const m2 = text.match(/微\s*信(?:账\s*户|支\s*付)?[:：\s]*[¥￥]?\s*(-?\d{1,8}(?:\.\d{1,2})?)\s*元/);
    if (m2 && parseFloat(m2[1]) > 0) return parseFloat(m2[1]);
    const m3 = text.match(/现\s*金\s*(?:账\s*户|支\s*付)?[:：\s]*[¥￥]?\s*(-?\d{1,8}(?:\.\d{1,2})?)\s*元/);
    if (m3 && parseFloat(m3[1]) > 0) return parseFloat(m3[1]);
    const m4 = text.match(/支\s*付\s*宝(?:付|支\s*付|账\s*户)?[:：\s]*[¥￥]?\s*(-?\d{1,8}(?:\.\d{1,2})?)\s*元/);
    if (m4 && parseFloat(m4[1]) > 0) return parseFloat(m4[1]);
    const m5 = text.match(/农\s*业\s*银\s*行[:：\s]*[¥￥]?\s*(-?\d{1,8}(?:\.\d{1,2})?)\s*元/);
    if (m5 && parseFloat(m5[1]) > 0) return parseFloat(m5[1]);
    const m6 = text.match(/刷\s*卡[:：\s]*[¥￥]?\s*(-?\d{1,8}(?:\.\d{1,2})?)\s*元/);
    if (m6 && parseFloat(m6[1]) > 0) return parseFloat(m6[1]);
    const m7 = text.match(/汇\s*款[:：\s]*[¥￥]?\s*(-?\d{1,8}(?:\.\d{1,2})?)\s*元/);
    if (m7 && parseFloat(m7[1]) > 0) return parseFloat(m7[1]);

    // 再匹配不带"元"的金额（限制更严格，最多8位避免匹配账号）
    const m10 = text.match(/扫\s*码\s*支\s*付[:：\s]*[¥￥]?\s*(-?\d{1,8}(?:\.\d{1,2})?)(?!\d)/);
    if (m10) return parseFloat(m10[1]);
    const m11 = text.match(/(?:实\s*付|已\s*付|付\s*款)[:：\s]*[¥￥]?\s*(-?\d{1,8}(?:\.\d{1,2})?)(?!\d)/);
    if (m11 && parseFloat(m11[1]) > 0) return parseFloat(m11[1]);
    const m12 = text.match(/微\s*信(?:账\s*户|支\s*付)?[:：\s]*[¥￥]?\s*(-?\d{1,8}(?:\.\d{1,2})?)(?!\d)/);
    if (m12 && parseFloat(m12[1]) > 0) return parseFloat(m12[1]);
    const m13 = text.match(/现\s*金\s*(?:账\s*户|支\s*付)?[:：\s]*[¥￥]?\s*(-?\d{1,8}(?:\.\d{1,2})?)(?!\d)/);
    if (m13 && parseFloat(m13[1]) > 0) return parseFloat(m13[1]);
    const m14 = text.match(/支\s*付\s*宝(?:付|支\s*付)?[:：\s]*[¥￥]?\s*(-?\d{1,8}(?:\.\d{1,2})?)(?!\d)/);
    if (m14 && parseFloat(m14[1]) > 0) return parseFloat(m14[1]);
    return 0;
}

// 解析拿货件数（销数/合计）
function parseSalesQuantity(ocrText) {
    // 优先匹配 销数（正数才是拿货）
    const m = ocrText.match(/销数[:：\s]*(\d{1,10})/);
    if (m) return parseInt(m[1]);
    // 匹配 退货:退X 格式（纯退货单，拿货为0）
    const m5 = ocrText.match(/退货[：:]\s*退\s*(\d{1,10})/);
    if (m5) return 0;
    // 匹配 数量: X 格式（独立行，非表格内）
    const mQty = ocrText.match(/^数量[:：\s]+(\d{1,10})\s*$/m);
    if (mQty) return parseInt(mQty[1]);
    // 从明细行计算正数数量（混合单据：拿货+退货）
    // 只在合计行之前的明细行中查找，避免匹配核销记录等其他表格
    let salesTotal = 0;
    let reachedSummary = false;
    let qtyColIndex = -1; // 数量列的索引
    const lines = ocrText.split('\n');
    for (const line of lines) {
        if (line.includes('合计') || line.includes('总计')) { reachedSummary = true; continue; }
        if (reachedSummary) continue;
        if (/^[-]+$/.test(line.trim())) continue;
        // 跳过分隔行（如 |----|----|----|）
        if (/^\|[-|]+\|$/.test(line.trim())) continue;
        // 匹配表格行
        if (line.includes('|')) {
            const parts = line.split('|').map(p => p.trim());
            while (parts.length > 0 && parts[0] === '') parts.shift();
            while (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
            // 检查是否是表头行，找到"数量"或"件数"列的位置
            if (line.includes('款号') || line.includes('名称') || line.includes('商品')) {
                // 优先精确匹配"数量"或"件数"，避免"颜色规格(数量)"误匹配
                let numIdx = parts.findIndex(p => p === '数量' || p === '件数');
                if (numIdx < 0) numIdx = parts.findIndex(p => p === '小计');
                if (numIdx < 0) numIdx = parts.findIndex(p => (p.includes('数量') || p.includes('件数')) && !p.includes('(') && !p.includes('（'));
                if (numIdx >= 0) qtyColIndex = numIdx;
                continue;
            }
            // 使用"数量"或"件数"列的索引，或默认第3列
            const idx = qtyColIndex >= 0 ? qtyColIndex : 2;
            if (parts.length > idx) {
                const qty = parseInt(parts[idx]);
                if (!isNaN(qty) && qty > 0 && qty < 10000) {
                    salesTotal += qty;
                    continue;
                }
            }
        }
        // 匹配普通格式: 款号 名称 数量 单价 金额
        const plainM = line.match(/^[^\s]+\s+[^\s]+\s+(\d{1,10})\s+\d/);
        if (plainM) { salesTotal += parseInt(plainM[1]); }
    }
    if (salesTotal > 0) return salesTotal;

    // 如果找到了件数列且合计，直接返回件数而不是金额
    if (qtyColIndex >= 0) {
        for (const line of lines) {
            if (line.includes('合计') || line.includes('总计')) {
                const parts = line.split('|').map(p => p.trim());
                while (parts.length > 0 && parts[0] === '') parts.shift();
                while (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
                if (parts.length > qtyColIndex) {
                    const qty = parseInt(parts[qtyColIndex]);
                    if (!isNaN(qty) && qty > 0 && qty < 10000) {
                        return qty;
                    }
                }
            }
        }
    }
    // 明细行没有正数，用合计作fallback
    const m2 = ocrText.match(/合计[：:]\s*数量\s*(\d{1,10})/);
    if (m2) return parseInt(m2[1]);
    const m3 = ocrText.match(/合计[：:]\s*总数[：:]\s*(\d{1,10})/);
    if (m3) return parseInt(m3[1]);
    for (const line of lines) {
        if (line.includes('合计')) {
            // 匹配正数（不带负号的数字），避免把-9的绝对值9当成拿货
            const nums = line.match(/(?<!-)\b(\d{1,10})\b/g);
            if (nums && nums.length >= 1) {
                const firstNum = parseInt(nums[0]);
                if (firstNum > 0 && firstNum < 10000) return firstNum;
            }
        }
    }
    return 0;
}

// 解析退货件数（退数）
function parseReturnQuantity(ocrText) {
    const m = ocrText.match(/退数[:：\s]*(\d{1,10})/);
    if (m) return parseInt(m[1]);
    // 匹配 退货:退X 格式
    const m2 = ocrText.match(/退货[：:]\s*退\s*(\d{1,10})/);
    if (m2) return parseInt(m2[1]);
    // 从明细行计算负数数量（混合单据：拿货+退货）
    // 只在合计行之前的明细行中查找，避免匹配核销记录等其他表格
    let returnTotal = 0;
    let reachedSummary = false;
    let qtyColIndex = -1;
    const lines = ocrText.split('\n');
    for (const line of lines) {
        if (line.includes('合计') || line.includes('总计')) { reachedSummary = true; continue; }
        if (reachedSummary) continue;
        if (/^[-]+$/.test(line.trim())) continue;
        // 跳过分隔行（如 |----|----|----|）
        if (/^\|[-|]+\|$/.test(line.trim())) continue;
        if (line.includes('|')) {
            const parts = line.split('|').map(p => p.trim());
            while (parts.length > 0 && parts[0] === '') parts.shift();
            while (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
            if (line.includes('款号') || line.includes('名称') || line.includes('商品')) {
                let numIdx = parts.findIndex(p => p === '数量' || p === '件数');
                if (numIdx < 0) numIdx = parts.findIndex(p => p === '小计');
                if (numIdx < 0) numIdx = parts.findIndex(p => (p.includes('数量') || p.includes('件数')) && !p.includes('(') && !p.includes('（'));
                if (numIdx >= 0) qtyColIndex = numIdx;
                continue;
            }
            const idx = qtyColIndex >= 0 ? qtyColIndex : 2;
            if (parts.length > idx) {
                const qty = parseInt(parts[idx]);
                if (!isNaN(qty) && qty < 0 && qty > -10000) {
                    returnTotal += Math.abs(qty);
                    continue;
                }
            }
        }
        const plainM = line.match(/^[^\s]+\s+[^\s]+\s+(-\d{1,10})\s+\d/);
        if (plainM) { returnTotal += Math.abs(parseInt(plainM[1])); }
    }
    if (returnTotal > 0) return returnTotal;
    // 明细行没有负数，用合计作fallback（只有负数合计才是退货）
    const m3 = ocrText.match(/合计[：:]\s*数量\s*(-\d{1,10})/);
    if (m3) return Math.abs(parseInt(m3[1]));
    const m4 = ocrText.match(/总数[:：\s]*(-\d{1,10})/);
    if (m4 && !ocrText.match(/销数[:：\s]*\d/) && !ocrText.match(/退数[:：\s]*\d/)) {
        return Math.abs(parseInt(m4[1]));
    }
    // 匹配 合计后跟负数
    for (const line of lines) {
        if (line.includes('合计')) {
            const nums = line.match(/-\d+/g);
            if (nums && nums.length >= 1) {
                const firstNum = parseInt(nums[0]);
                if (firstNum < 0 && firstNum > -10000) return Math.abs(firstNum);
            }
        }
    }
    return 0;
}

// 解析总数（用于验证，保留正负号）
function parseTotalQuantity(ocrText) {
    const m = ocrText.match(/总数[:：\s]*(-?\d{1,10})/);
    if (m) return parseInt(m[1]);
    // 匹配 合计：数量X 格式
    const m2 = ocrText.match(/合计[：:]\s*数量\s*(-?\d{1,10})/);
    if (m2) return parseInt(m2[1]);
    // 从合计行提取
    const lines = ocrText.split('\n');
    for (const line of lines) {
        if (line.includes('合计')) {
            const nums = line.match(/-?\d+/g);
            if (nums && nums.length >= 1) {
                const firstNum = parseInt(nums[0]);
                if (Math.abs(firstNum) > 0 && Math.abs(firstNum) < 10000) return firstNum;
            }
        }
    }
    return 0;
}

// 解析总额（用于验证）
function parseTotalAmount(ocrText) {
    const m = ocrText.match(/总额[:：\s]*[¥￥]?\s*(-?\d{1,10}(?:\.\d{1,2})?)/);
    return m ? parseFloat(m[1]) : 0;
}

// ========== 主流程 ==========

async function main() {
    if (!fs.existsSync(RESULT_JSON)) {
        console.error(`文件不存在: ${RESULT_JSON}`);
        process.exit(1);
    }

    const data = JSON.parse(fs.readFileSync(RESULT_JSON, 'utf-8'));
    const bills = data.bills;
    console.log(`共 ${bills.length} 条单据`);
    console.log(`记录时间: ${RECORD_TIME_MS}`);
    console.log(`写入目标: ${APP_TOKEN}/${TABLE_ID}`);

    // 自动推断视频日期：从所有票据中找出出现最多的日期
    const dateCount = {};
    for (const bill of bills) {
        const parsed = parsePrintTime(bill.ocr_text);
        if (parsed) {
            dateCount[parsed.date] = (dateCount[parsed.date] || 0) + 1;
        }
    }
    const videoDate = Object.entries(dateCount).sort((a, b) => b[1] - a[1])[0]?.[0] || new Date(RECORD_TIME_MS).toISOString().split('T')[0];
    console.log(`推断视频日期: ${videoDate}（出现 ${dateCount[videoDate] || 0} 次）`);

    const token = await getToken();
    if (!token) { console.error('获取 token 失败'); process.exit(1); }
    console.log('Token 获取成功');

    let successCount = 0;

    for (let i = 0; i < bills.length; i++) {
        const bill = bills[i];
        const { ocr_text: ocrText, screenshot: imgPath, segment_id: segId } = bill;

        const parsed = parsePrintTime(ocrText);
        const billDateStr = parseBillDate(ocrText);
        const billDateMs = billDateStr ? new Date(billDateStr + 'T00:00:00').getTime() : null;
        const batchNo = parseBatch(ocrText);
        const shopName = parseShopName(ocrText);
        const customer = parseCustomer(ocrText);
        const address = parseAddress(ocrText);
        const prevBalance = parsePrevBalance(ocrText);
        const cumBalance = parseCumulativeBalance(ocrText);
        const realReceived = parseRealReceived(ocrText);
        let paymentAmt = realReceived !== 0 ? realReceived : parseTotal(ocrText);
        // 负数表示退货，付款金额应为0
        if (paymentAmt < 0) paymentAmt = 0;

        // 解析件数
        let salesQty = parseSalesQuantity(ocrText);
        let returnQty = parseReturnQuantity(ocrText);
        const totalQty = parseTotalQuantity(ocrText);

        // 验证件数合理性
        if (totalQty !== 0) {
            // 总数 = 销数 - 退数
            const expectedTotal = salesQty - returnQty;
            if (expectedTotal !== totalQty) {
                if (returnQty === 0 && salesQty === 0) {
                    // 都没识别到，用总数作为拿货件数
                    salesQty = Math.abs(totalQty);
                }
            }
        }
        // totalQty=0 且 salesQty=0 且 returnQty>0：纯退货单，无需修正
        // 退数不能为负
        if (returnQty < 0) returnQty = Math.abs(returnQty);
        // 销数不能为负
        if (salesQty < 0) salesQty = Math.abs(salesQty);

        // 单据打印时间 = 票据结尾时间戳
        const billTimeMs = parsed ? new Date(parsed.full).getTime() : null;
        // 是否错误 = 与推断视频日期比较，不一致则标"日期无法识别"
        const isDateError = !parsed || parsed.date !== videoDate;
        const errors = [];
        if (!shopName) errors.push('档口名称无法识别');
        if (!batchNo) errors.push('批次无法识别');
        if (isDateError) errors.push('日期无法识别');
        if (!billDateMs) errors.push('开单日期无法识别');
        // 校验档口名称是否仍含地址信息（楼层房号等）
        if (shopName && /(?:富|负)?[一二三四五六七八九十\d]+楼-?[a-zA-Z]?\d*(?:号|$)/.test(shopName)) errors.push('档口名称错误');
        // 上次余额、累计结余、付款金额都为0，标记金额出错
        if (prevBalance === 0 && cumBalance === 0 && paymentAmt === 0) errors.push('金额出错');
        let errorNote = errors.join(' ');

        // 上传截图
        let fileToken = null;
        if (imgPath && fs.existsSync(imgPath)) {
            const fileName = `bill_seg${segId}.jpg`;
            try {
                const up = await uploadFile(token, imgPath, fileName);
                if (up.code === 0) fileToken = up.data.file_token;
                else console.warn(`  [${CURRENT_IMAGE}/${TOTAL_IMAGES}] 上传失败: ${up.msg}`);
            } catch (e) {
                if (e.message === 'FEISHU_STORAGE_QUOTA_EXCEEDED') {
                    console.error('\n!!! 飞书存储配额已达上限（免费2GB），请清理后重试 !!!');
                    process.exit(1);
                }
                console.warn(`  [${CURRENT_IMAGE}/${TOTAL_IMAGES}] 上传异常: ${e.message}`);
            }
        }

        const fields = {
            "单据内容": ocrText,
            "单据打印时间": billTimeMs,
            "记录时间": RECORD_TIME_MS,
            "批次号": batchNo,
            "是否错误": errorNote,
            "档口名称": shopName,
            "客户": customer,
            "地址": address,
            "上次结余": prevBalance,
            "累计结余": cumBalance,
            "付款金额": paymentAmt,
            "拿货件数": salesQty,
            "退货件数": returnQty
        };
        if (billDateMs) fields["开单日期"] = billDateMs;
        if (fileToken) fields["单据截图"] = [{ file_token: fileToken, name: `bill_seg${segId}.jpg` }];

        // 录入日志
        console.log(`  [${CURRENT_IMAGE}/${TOTAL_IMAGES}] 档口:${shopName || '??'} 批次:${batchNo || '??'} 上次结余:${prevBalance} 累计结余:${cumBalance} 付款:${paymentAmt} 拿货:${salesQty} 退货:${returnQty} ${errorNote ? '⚠ ' + errorNote : '✓'}`);

        await sleep(500);  // 限速延迟
        const res = await createRecord(token, fields);
        if (!res || res.error || res.code !== 0) {
            process.stderr.write('record_res:' + JSON.stringify(res) + '\n');
        }
        if (!res || res.error) {
            console.error('  [record error]', res?.error || 'unknown');
        } else if (res.code === 0) {
            successCount++;
            console.log(`  [${CURRENT_IMAGE}/${TOTAL_IMAGES}] ✅ ${shopName} ${batchNo} error=${errorNote || 'OK'}`);
            // 只有录入成功且无识别错误时才重命名图片/视频，方便出错时重新录入
            if (!errorNote && VIDEO_PATH) {
                const ext = path.extname(VIDEO_PATH);
                const newName = `已录入_${videoDate.replace(/-/g, '')}_${SEQ_NO}${ext}`;
                const newPath = path.join(path.dirname(VIDEO_PATH), newName);
                try {
                    fs.renameSync(VIDEO_PATH, newPath);
                    console.log(`\n文件已更名为: ${newName}`);
                } catch (e) {
                    console.warn(`\n文件重命名失败: ${e.message}`);
                }
            }
        } else {
            console.error(`  [${CURRENT_IMAGE}/${TOTAL_IMAGES}] ❌ ${res.msg}`);
        }
    }

    console.log(`\n========== 完成 ==========`);
    console.log(`有效录入: ${successCount} 张单据`);
    console.log(`无效跳过: ${bills.length - successCount} 张单据`);
    console.log(`进度: ${CURRENT_IMAGE}/${TOTAL_IMAGES}`);
    console.log(`=========================`);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
