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
        if (stripped === '客户联' || stripped === '存根联') continue;
        if (stripped === '销售明细' || stripped === '销售/退货明细') continue;
        if (stripped === '销售单' || stripped === '退货单' || stripped === '销售退货单') continue;
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
    name = name.replace(/\s*(?:销售退货单|退货单|销售单|收款单)\s*$/, '').trim();
    // 去掉客户联/存根联后缀（OCR有时会把它们粘到同一行）
    name = name.replace(/\s*(?:客户联|存根联)\s*$/, '').trim();
    // 客户联去掉后，销售单可能暴露到末尾，再清一次
    name = name.replace(/\s*(?:销售退货单|退货单|销售单|收款单)\s*$/, '').trim();
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
    // 特例：婉星 -> 婉星儿（所有路径统一处理）
    if (name === '婉星') name = '婉星儿';
    // 特例：梦莎娜熙恒 -> 梦莎娜
    if (name === '梦莎娜熙恒') name = '梦莎娜';
    // 特例：喜梦露 -> 荷传
    if (name === '喜梦露') name = '荷传';
    // 去掉末尾的城市名后缀（如"株洲市" -> "予檬"）
    name = name.replace(/^[一-龥]{2,4}市/, '');
    // 如果仍然是空的，返回空字符串（不要返回原始未处理的字符串）
    if (!name.trim()) return '';
    // 去掉开头的#和空白符号，以及所有【】[]符号和横杠-
    name = name.replace(/^[#\s]+/, '').replace(/^[【】\[\]]+/, '').replace(/[【】\]]+$/, '').replace(/-/g, '');
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
    // 优先从 地址:/店址: 行提取（兼容行首 "- " 前缀）
    const addrMatch = ocrText.match(/(?:地址|店址)[:：]\s*(.+?)(?=\n\s*(?:[-*]\s*)?(?:电话|账号|备注|经办|门店|提醒|$))/);
    if (addrMatch) {
        let addr = addrMatch[1].trim();
        if (addr && addr.length >= 4) {
            return addr.substring(0, 200);
        }
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
    // fallback2：匹配独立地址行（含市场名+楼号，如"株洲市欧洲城3楼888号"）
    for (const line of lines) {
        const m = line.match(/(?:欧洲城|万象汇|世贸|万达|广场|商城|市场)\S*?\d+楼\S+/);
        if (m) return m[0].substring(0, 200);
    }
    return '';
}

function parsePrevBalance(ocrText) {
    const m = ocrText.match(/(?:上次欠款|上次余额|上次结余|上次余|上期余额)[:：]?\s*[¥￥]?\s*(-?\d{1,10}(?:\.\d{1,2})?)/);
    if (!m) return 0;
    const val = parseFloat(m[1]);
    return m[0].includes('欠款') ? val * -1 : val;
}

function parseCumulativeBalance(ocrText) {
    const m = ocrText.match(/(?:累计欠款|累计结余|累计余|总计欠款|总欠款|累计余额)[:：]?\s*[¥￥]?\s*(-?\d{1,10}(?:\.\d{1,2})?)/);
    if (!m) return 0;
    const val = parseFloat(m[1]);
    const matched = m[0];
    return matched.includes('欠款') ? val * -1 : val;
}

function parseRealReceived(ocrText) {
    const m = ocrText.match(/实收(?:金额)?[:：]\s*[¥￥]?\s*(-?\d{1,10}(?:\.\d{1,2})?(?![0-9]))/);
    return m ? parseFloat(m[1]) : 0;
}

function parseTotal(ocrText) {
    const m0 = ocrText.match(/扫码支付[:：]\s*[¥￥]?\s*(\d{1,10}(?:\.\d{1,2})?(?![0-9]))/);
    if (m0) return parseFloat(m0[1]);
    const m = ocrText.match(/(?:实付|已付|付款)[:：]\s*[¥￥]?\s*(-?\d{1,10}(?:\.\d{1,2})?(?![0-9]))/);
    if (m) return parseFloat(m[1]);
    const m2 = ocrText.match(/微信(?:账户|支付)?[:：]\s*[¥￥]?\s*(\d{1,10}(?:\.\d{1,2})?(?![0-9]))/);
    if (m2) return parseFloat(m2[1]);
    const m3 = ocrText.match(/现金\s*(?:账户|支付)?[:：]\s*[¥￥]?\s*(\d{1,10}(?:\.\d{1,2})?(?![0-9]))/);
    if (m3) return parseFloat(m3[1]);
    const m4 = ocrText.match(/支付宝(?:付|支付|账户)?[:：]\s*[¥￥]?\s*(\d{1,10}(?:\.\d{1,2})?(?![0-9]))/);
    if (m4) return parseFloat(m4[1]);
    const m5 = ocrText.match(/农业银行账户[:：]\s*[¥￥]?\s*(\d{1,10}(?:\.\d{1,2})?(?![0-9]))/);
    if (m5) return parseFloat(m5[1]);
    const m6 = ocrText.match(/刷卡(?:\([^)]*\))?\s*[:：]\s*[¥￥]?\s*(\d{1,10}(?:\.\d{1,2})?(?![0-9]))/);
    if (m6) return parseFloat(m6[1]);
    return 0;
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
        const paymentAmt = realReceived !== 0 ? realReceived : parseTotal(ocrText);

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
                else console.warn(`  [${i+1}] 上传失败: ${up.msg}`);
            } catch (e) {
                if (e.message === 'FEISHU_STORAGE_QUOTA_EXCEEDED') {
                    console.error('\n!!! 飞书存储配额已达上限（免费2GB），请清理后重试 !!!');
                    process.exit(1);
                }
                console.warn(`  [${i+1}] 上传异常: ${e.message}`);
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
            "付款金额": paymentAmt
        };
        if (billDateMs) fields["开单日期"] = billDateMs;
        if (fileToken) fields["单据截图"] = [{ file_token: fileToken, name: `bill_seg${segId}.jpg` }];

        // 录入日志
        console.log(`  [${i+1}/${bills.length}] 档口:${shopName || '??'} 批次:${batchNo || '??'} 上次结余:${prevBalance} 累计结余:${cumBalance} 付款:${paymentAmt} ${errorNote ? '⚠ ' + errorNote : '✓'}`);

        await sleep(500);  // 限速延迟
        const res = await createRecord(token, fields);
        process.stderr.write('record_res:' + JSON.stringify(res) + '\n');
        if (!res || res.error) {
            console.error('  [record error]', res?.error || 'unknown');
        } else if (res.code === 0) {
            successCount++;
            console.log(`  [${i+1}/${bills.length}] ✅ ${shopName} ${batchNo} error=${errorNote || 'OK'}`);
            // 只有录入成功且无识别错误时才重命名图片/视频，方便出错时重新录入
            if (!errorNote && VIDEO_PATH) {
                const ext = path.extname(VIDEO_PATH);
                const newName = `${videoDate.replace(/-/g, '')}_${SEQ_NO}${ext}`;
                const { execSync } = require('child_process');
                try {
                    execSync(`powershell -Command "Rename-Item -LiteralPath '${VIDEO_PATH.replace(/'/g, "''")}' -NewName '${newName}'"`, { stdio: 'ignore' });
                    console.log(`\n文件已更名为: ${newName}`);
                } catch (e) {
                    console.warn(`\n文件重命名失败: ${e.message}`);
                }
            }
        } else {
            console.error(`  [${i+1}] ❌ ${res.msg}`);
        }
    }

    console.log(`\n========== 完成 ==========`);
    console.log(`有效录入: ${successCount} 张单据`);
    console.log(`无效跳过: ${bills.length - successCount} 张单据`);
    console.log(`=========================`);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
