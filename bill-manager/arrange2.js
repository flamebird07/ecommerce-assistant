/**
 * 整理票据脚本
 * 重要：此脚本只清理1号表格（源表）的数据，禁止清理2号、3号、4号表格的数据！
 * - 1号表格：票据录入源表 (SRC_TABLE) - 可以清理
 * - 2号表格：票据整理目标表 (DST_TABLE) - 禁止清理
 * - 3号表格：每个档口最新单据 (TBL3_TABLE) - 禁止清理
 * - 4号表格：商品成本表 (TBL4) - 禁止清理
 */
const https = require('https');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const APP_ID = 'cli_a91ad5ae63385bc9';
const APP_SECRET = 'ga7Gn6pBJgUkftKY2JEpFe3TJFpB2Mun';
const APP_TOKEN = 'CfAXbSrUFaBLv3stSRrcuUVon1b';
const SRC_TABLE = 'tblua6KaZ6PiWAp6'; // 1号表格：票据录入源表
const DST_TABLE = 'tblWIMl7CwqqAzD4'; // 2号表格：票据整理目标表（新）
const TBL3_TABLE = 'tblDCMOWzHqq2VtS'; // 3号表格：每个档口最新单据
const TBL4 = 'tblpEOUDXbdCMPPH'; // 4号表格：商品成本表
const TOKEN_TTL = 2 * 3600 * 1000;
let _token = null, _tokenTime = 0;

// 进程锁：防止多实例同时运行
const LOCK_FILE = path.join(__dirname, 'arrange2.lock');

function isProcessRunning(pid) {
    try {
        // 使用 process.kill(pid, 0) 检查进程是否存在，不依赖tasklist的编码
        process.kill(pid, 0);
        return true;
    } catch { return false; }
}

function acquireLock() {
    if (fs.existsSync(LOCK_FILE)) {
        const content = fs.readFileSync(LOCK_FILE, 'utf-8').trim();
        const oldPid = parseInt(content, 10);
        if (oldPid && isProcessRunning(oldPid)) {
            console.error(`[LOCK] arrange2.js 已在运行 (PID ${oldPid})，退出。`);
            process.exit(1);
        }
        console.log('[LOCK] 发现陈旧锁文件，已清除。');
    }
    fs.writeFileSync(LOCK_FILE, String(process.pid), 'utf-8');
    console.log(`[LOCK] 进程锁已创建 (PID ${process.pid})`);
}

function releaseLock() {
    try { if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE); } catch {}
}

// 进程退出时释放锁
process.on('exit', () => releaseLock());
process.on('SIGINT', () => { releaseLock(); process.exit(0); });
process.on('SIGTERM', () => { releaseLock(); process.exit(0); });

acquireLock();

function getPinyinInitials(chinese) {
    if (!chinese) return '';
    // 特例：巴芘仑 -> BBL, 欣焯怡 -> XZY, 靓点红怡纯 -> LDHYC, 5彩缤纷 -> WCBF
    if (chinese === '巴芘仑') return 'BBL';
    if (chinese === '欣焯怡') return 'XZY';
    if (chinese === '靓点红怡纯') return 'LDHYC';
    if (chinese === '5彩缤纷') return 'WCBF';
    try {
        const script = path.join(__dirname, 'pinyin_initials.py');
        const result = execSync(
            `python -W ignore "${script}" "${chinese}"`,
            { encoding: 'utf-8', timeout: 5000, env: { ...process.env, PYTHONWARNINGS: 'ignore' } }
        );
        const initials = result.trim();
        // 如果返回空或仍含中文，说明拼音失败
        if (!initials || /[一-龥]/.test(initials)) return '';
        return initials;
    } catch (e) {
        return '';
    }
}

function req(options, postData) {
    return new Promise((resolve) => {
        const chunks = [];
        const r = https.request(options, (res) => {
            res.on('data', c => chunks.push(Buffer.from(c)));
            res.on('end', () => {
                try {
                    const buf = Buffer.concat(chunks);
                    const str = buf.toString('utf8');
                    resolve(JSON.parse(str));
                } catch {
                    // JSON解析失败，可能是编码问题或响应不完整，返回错误而非截断的raw
                    const str = Buffer.concat(chunks).toString('utf8').substring(0, 200);
                    resolve({ error: 'JSON parse failed', raw: str });
                }
            });
        });
        r.on('error', e => resolve({ error: e.message }));
        if (postData) r.write(postData);
        r.end();
    });
}

// 安全打印：避免终端编码问题，对中文字段做截断处理
function safeLog(...args) {
    const parts = args.map(a => {
        if (typeof a === 'string') {
            // 替换所有非基本拉丁字符为?避免终端乱码，但保留数字和基本符号
            return a;
        }
        return String(a);
    });
    console.log(...parts);
}

async function getToken() {
    if (_token && Date.now() - _tokenTime < TOKEN_TTL) return _token;
    const d = JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET });
    const r = await req({
        hostname: 'open.feishu.cn',
        path: '/open-apis/auth/v3/tenant_access_token/internal',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) }
    }, d);
    _token = r.tenant_access_token;
    _tokenTime = Date.now();
    return _token;
}

async function listRecords(tableId, pageSize = 100, pageToken = '') {
    const token = await getToken();
    const path = `/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/records?page_size=${pageSize}${pageToken ? '&page_token=' + pageToken : ''}`;
    return req({ hostname: 'open.feishu.cn', path, method: 'GET', headers: { 'Authorization': `Bearer ${token}` } });
}

async function createRecord(tableId, fields) {
    const token = await getToken();
    const data = JSON.stringify({ fields });
    return req({
        hostname: 'open.feishu.cn',
        path: `/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/records`,
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, data);
}

async function updateRecord(tableId, recordId, fields) {
    const token = await getToken();
    const data = JSON.stringify({ fields });
    return req({
        hostname: 'open.feishu.cn',
        path: `/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/records/${recordId}`,
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, data);
}

async function deleteRecord(tableId, recordId) {
    const token = await getToken();
    return req({
        hostname: 'open.feishu.cn',
        path: `/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/records/${recordId}`,
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
    });
}

async function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// 从单据内容（OCR文本）中提取付款金额
// 优先级：实付 > 支付宝支付/微信支付/现金支付（正数）> 本单额/应收
// 注意：总额/总价/总计不作为付款金额，只反映单据总账
// 忽略负数（退货/退款），若全部找不到，对退货单返回0，对普通销售单返回null
function extractPaymentAmount(text) {
    if (!text) return null;
    // 统一处理实际换行符和 OCR 返回的 literal \n（两个字符）
    text = text.replace('\\n', '\n').replace('\r\n', '\n');
    const lines = text.split('\n');
    // 第1优先：支付宝付/支付宝支付/微信支付/现金支付/现金（带数字金额的才是实际付款）
    let totalPay = 0, foundPay = false;
    for (const line of lines) {
        const m = line.match(/(?:支付宝付|支付宝支付|微信支付|现金支付|现金账户|现金|刷卡(?:\([^)]*\))?)[：:\s]*([\d,，.]+)/);
        if (m) {
            const v = parseFloat(m[1].replace(/[,，]/g, ''));
            if (!isNaN(v) && v > 0) { totalPay += v; foundPay = true; }
        }
    }
    if (foundPay) return totalPay;
    // 第2优先：支付宝账户/微信账户（当无支付宝支付/微信支付时，账户:数字即为付款金额）
    // 储值支付只是账户扣款，不是实际付款，不计入
    let foundAccountPay = false;
    for (const line of lines) {
        const m = line.match(/(?:支付宝账户|微信账户)[：:\s]*([\d,，.]+)/);
        if (m) {
            const v = parseFloat(m[1].replace(/[,，]/g, ''));
            if (!isNaN(v) && v > 0) { totalPay = v; foundAccountPay = true; break; }
        }
    }
    if (foundAccountPay) return totalPay;
    // 第3优先：实付
    for (const line of lines) {
        const m = line.match(/实付[：:\s]*[¥￥]?\s*([\d,，.]+)/);
        if (m) {
            const v = parseFloat(m[1].replace(/[,，]/g, ''));
            if (!isNaN(v) && v > 0) return v;
        }
    }
    // 找不到任何实际付款行：退货单返回0，销售单也返回0
    return 0;
}

// 提取 Feishu 富文本字段的纯文本（字段类型为 1 Text 时，API 返回 [{text:'...',type:'text'}]）
function getText(v) {
    if (!v) return '';
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return v.map(s => typeof s === 'object' && s !== null ? (s.text || '') : String(s)).join('');
    return String(v);
}

function toNum(v) {
    return v != null && v !== '' && !isNaN(Number(v)) ? Number(v) : 0;
}

function toDateMs(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
        const d = new Date(v + 'T00:00:00');
        if (!isNaN(d.getTime())) return d.getTime();
    }
    return null;
}

function getRecordTime() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const h = String(now.getHours()).padStart(2, '0');
    const min = String(now.getMinutes()).padStart(2, '0');
    return `${y}-${m}-${d} ${h}:${min}`;
}

// 将1号表格的某条记录同步到2号表格
async function syncRecordToDstTable(srcRecord, recordIndex) {
    const f = srcRecord.fields;
    let shop = getText(f['档口名称']).trim();
    // 特例：婉星 -> 婉星儿（和write_final.js保持一致）
    if (shop === '婉星') shop = '婉星儿';
    if (shop === '梦莎娜熙恒') shop = '梦莎娜';
    if (shop === '喜梦露') shop = '荷传';
    const batch = getText(f['批次号']).trim();
    // 单据打印时间为空时，用记录时间作fallback，避免被错误跳过
    const srcTime = f['单据打印时间'] || f['记录时间'] || 0;
    const recordTime = getRecordTime();

    // 构建要写入的字段（全部照搬，只记录时间用当前时间）
    const toNum2 = v => v != null && v !== '' ? Number(v) : null;
    // 生成档口缩写，失败则从3号表格查询
    let abbr = getPinyinInitials(shop);
    if (!abbr || /[一-龥]/.test(abbr)) {
        console.log(`  [${recordIndex}] 拼音转换失败，从3号表格查询档口"${shop}"的缩写`);
        let tbl3Pt = '';
        do {
            const list = await listRecords(TBL3_TABLE, 100, tbl3Pt);
            if (list.data?.items) {
                for (const item of list.data.items) {
                    const s = (getText(item.fields['档口名称']) || '').trim();
                    if (s === shop.trim()) {
                        abbr = getText(item.fields['档口缩写']) || '';
                        if (abbr) {
                            console.log(`  [${recordIndex}] 从3号表格获取缩写: ${abbr}`);
                            break;
                        }
                    }
                }
            }
            tbl3Pt = list.data?.page_token || '';
        } while (tbl3Pt && !abbr);
        if (!abbr) {
            console.error(`  [${recordIndex}] 跳过 ${shop} ${batch}（3号表格未找到缩写）`);
            await updateRecord(SRC_TABLE, srcRecord.id, { '是否错误': '' });
            await sleep(200);
            return false;
        }
    }

    // 校验档口名称是否仍含地址信息（楼层房号等）
    if (/(?:富|负)?[一二三四五六七八九十\d]+楼-?[a-zA-Z]?\d*(?:号|$)/.test(shop)) {
        console.error(`  [${recordIndex}] 跳过 ${shop} ${batch}（档口名称含地址）`);
        await updateRecord(SRC_TABLE, srcRecord.id, { '是否错误': '档口名称错误' });
        await sleep(200);
        return false;
    }

    const salesQty = toNum2(f['拿货件数']) || 0;
    const returnQty = toNum2(f['退货件数']) || 0;
    const paymentAmt = (() => { const v = toNum2(f['付款金额']); return (v && v !== 0) ? v : extractPaymentAmount(getText(f['单据内容'])); })() || 0;

    // 判断单据性质
    let billType = '';
    if (salesQty > 0 && returnQty === 0) {
        billType = '拿货单';
    } else if (salesQty === 0 && returnQty > 0) {
        billType = '退货单';
    } else if (salesQty > 0 && returnQty > 0) {
        billType = '混合单';
    } else if (salesQty === 0 && returnQty === 0 && paymentAmt > 0) {
        billType = '付款单';
    }

    const fields = {
        '档口名称': shop,
        '档口缩写': abbr,
        '单据打印时间': f['单据打印时间'],
        '开单日期': toDateMs(f['开单日期']),
        '批次号': batch,
        '上次结余': toNum2(f['上次结余']),
        '累计结余': toNum2(f['累计结余']),
        '付款金额': paymentAmt,
        '地址': getText(f['地址']),
        '单据内容': getText(f['单据内容']),
        '客户': getText(f['客户']),
        '拿货件数': salesQty,
        '退货件数': returnQty,
        '单据性质': billType,
        '记录时间': Date.now()
    };

    // 复制单据截图
    const rawSs = f['单据截图'];
    if (rawSs) {
        if (Array.isArray(rawSs) && rawSs.length > 0) {
            fields['单据截图'] = [{ file_token: rawSs[0].file_token, name: rawSs[0].name || '单据截图.jpg' }];
        } else if (typeof rawSs === 'string' && rawSs.length > 20) {
            fields['单据截图'] = [{ file_token: rawSs, name: '单据截图.jpg' }];
        }
    }

    // 查询2号表格中是否已有该档口+批次的记录
    let pt = '';
    let existingRecord = null;
    do {
        const list = await listRecords(DST_TABLE, 100, pt);
        if (list.data?.items) {
            for (const item of list.data.items) {
                const s = (getText(item.fields['档口名称']) || '').trim();
                const b = (getText(item.fields['批次号']) || '').trim();
                if (s === shop && b === batch) {
                    existingRecord = { id: item.id, billTime: item.fields['单据打印时间'] || 0 };
                    break;
                }
            }
        }
        pt = list.data?.page_token || '';
    } while (pt && !existingRecord);

    let synced = false;
    if (existingRecord) {
        // 已存在，检查是否需要覆盖（OBY记录强制覆盖以同步4号表格）
        if (srcTime > existingRecord.billTime || shop.includes('欧贝缘')) {
            const res2 = await updateRecord(DST_TABLE, existingRecord.id, fields);
            if (res2 && res2.code === 0) {
                console.log(`  [${recordIndex}] 覆盖 ${shop} ${batch}${shop.includes('欧贝缘') ? ' (OBY强制)' : ''}`);
                synced = true;
            } else {
                console.error(`  [${recordIndex}] 覆盖失败 ${shop} ${batch}:`, res2?.msg || res2?.error || JSON.stringify(res2));
            }
        } else {
            console.log(`  [${recordIndex}] 跳过 ${shop} ${batch} (已有最新)`);
            await updateRecord(SRC_TABLE, srcRecord.id, { '是否错误': '重复跳过' });
            await sleep(100);
        }
    } else {
        const res2 = await createRecord(DST_TABLE, fields);
        if (res2 && res2.code === 0) {
            console.log(`  [${recordIndex}] 新增 ${shop} ${batch}`);
            synced = true;
        } else {
            console.error(`  [${recordIndex}] 新增失败 ${shop} ${batch}:`, res2?.msg || res2?.error || JSON.stringify(res2));
        }
    }

    // 同步更新3号表格（每个档口的最新单据）
    if (synced) {
        await syncToTbl3(shop);
    }

    // 同步到4号表格（商品成本表）
    if (synced) {
        await syncToTbl4(srcRecord, srcTime);
    }

    // 只有2号表格真正写入成功，才标记该条记录为已记录
    if (synced) {
        await updateRecord(SRC_TABLE, srcRecord.id, { '是否错误': '已记录' });
        await sleep(100);
    }

    return synced;
}

// 同步到3号表格（每个档口的最新单据）
// 比较逻辑：以2号表格数据为准，优先比对开单日期，开单日期相同再比对单据打印时间
async function syncToTbl3(shop) {
    if (!shop) return;

    // 从2号表格查询该档口所有记录，找最新记录
    let dstPt = '';
    let latest = null; // { id, billDate, billTime, fields }
    do {
        const list = await listRecords(DST_TABLE, 100, dstPt);
        if (list.data?.items) {
            for (const item of list.data.items) {
                const s = (getText(item.fields['档口名称']) || '').trim();
                if (s !== shop) continue;
                const bd = item.fields['开单日期'] || 0;
                const bt = item.fields['单据打印时间'] || 0;
                if (!latest) {
                    latest = { id: item.id, billDate: bd, billTime: bt, fields: item.fields };
                } else {
                    // 优先比对开单日期，开单日期相同再比对单据打印时间
                    if (bd > latest.billDate || (bd === latest.billDate && bt > latest.billTime)) {
                        latest = { id: item.id, billDate: bd, billTime: bt, fields: item.fields };
                    }
                }
            }
        }
        dstPt = list.data?.page_token || '';
    } while (dstPt);

    if (!latest) {
        console.log(`  [3号] 跳过 ${shop}（2号表格无记录）`);
        return;
    }

    // 查询3号表格中是否已有该档口的记录
    let tbl3Pt = '';
    let existingRecord = null;
    do {
        const list = await listRecords(TBL3_TABLE, 100, tbl3Pt);
        if (list.data?.items) {
            for (const item of list.data.items) {
                const s = (getText(item.fields['档口名称']) || '').trim();
                if (s === shop) {
                    existingRecord = { id: item.id, billDate: item.fields['开单日期'] || 0, billTime: item.fields['单据打印时间'] || 0, fields: item.fields };
                    break;
                }
            }
        }
        tbl3Pt = list.data?.page_token || '';
    } while (tbl3Pt && !existingRecord);

    const toNum3 = v => v != null && v !== '' && !isNaN(Number(v)) ? Number(v) : 0;

    // 比较：开单日期优先，相同再比单据打印时间
    const needUpdate = !existingRecord
        || latest.billDate > existingRecord.billDate
        || (latest.billDate === existingRecord.billDate && latest.billTime > existingRecord.billTime);

    if (!needUpdate) {
        console.log(`  [3号] 跳过 ${shop} (已有最新)`);
        return;
    }

    const f = latest.fields;
    const recordTimeTs = Date.now();
    const rawSs = f['单据截图'];
    let screenshotField = null;
    if (rawSs) {
        if (Array.isArray(rawSs) && rawSs.length > 0) {
            const item = rawSs[0];
            if (item.file_token) screenshotField = [{ file_token: item.file_token, name: item.name || '单据截图.jpg' }];
        } else if (typeof rawSs === 'string' && rawSs.length > 20) {
            screenshotField = [{ file_token: rawSs, name: '单据截图.jpg' }];
        }
    }
    const billTs = f['单据打印时间'];
    const billDateMs = f['开单日期'] || null;
    // 地址处理：去掉省、市、区、县等行政地区前缀（排除"市场"等词）
    let addr = getText(f['地址']).replace(/^(?:.*?(?:省|市(?!场)|区|县|镇|乡|街道))+/, '').trim();
    // 如果新地址为空，保留3号表格原有地址
    if (!addr && existingRecord) {
        const oldAddr = getText(existingRecord.fields?.['地址']);
        if (oldAddr) addr = oldAddr;
    }
    const fields = {
        '单据打印时间': typeof billTs === 'number' ? billTs : (billTs ? Number(billTs) : null),
        '开单日期': typeof billDateMs === 'number' ? billDateMs : (billDateMs ? Number(billDateMs) : null),
        '档口名称': shop,
        '档口缩写': (() => {
            const abbr = getPinyinInitials(shop);
            return abbr && !/[一-龥]/.test(abbr) ? abbr : '';
        })(),
        '累计结余': toNum3(f['累计结余']),
        '地址': addr,
        '单据内容': getText(f['单据内容']),
        '记录时间': recordTimeTs
    };
    if (screenshotField) fields['单据截图'] = screenshotField;

    if (existingRecord) {
        const res3 = await updateRecord(TBL3_TABLE, existingRecord.id, fields);
        if (res3 && res3.code === 0) {
            console.log(`  [3号] 更新 ${shop}（开单日期=${billDateMs ? new Date(billDateMs).toISOString().slice(0,10) : '?'}）`);
        } else {
            console.error(`  [3号] 更新失败 ${shop}:`, res3?.msg || res3?.error || JSON.stringify(res3));
        }
    } else {
        const res3 = await createRecord(TBL3_TABLE, fields);
        if (res3 && res3.code === 0) {
            console.log(`  [3号] 新增 ${shop}（开单日期=${billDateMs ? new Date(billDateMs).toISOString().slice(0,10) : '?'}）`);
        } else {
            console.error(`  [3号] 新增失败 ${shop}:`, res3?.msg || res3?.error || JSON.stringify(res3));
        }
    }
}

// 从单据内容提取商品成本
function extractGoodsCost(text, shopAbbr) {
    if (!text) return [];
    text = text.replace(/\\n/g, '\n');
    const lines = text.split('\n');
    const results = [];

    // 找到"款号"所在的列位置
    let codeColIndex = -1;
    let priceColIndex = -1;
    let headerColCount = 0;
    let headerHasSubtotal = false;
    let foundHeader = false;
    let dataStarted = false;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        // 遇到核销批次，停止解析（该字段之后的所有内容都不是款号）
        if (line.includes('核销批次')) break;

        // 遇到合计/总计，停止当前段收集（但允许后面出现新的款号表头）
        if (foundHeader && (line.includes('合计') || line.includes('总计'))) {
            foundHeader = false;
            dataStarted = false;
            continue;
        }

        // 遇到款号表头，重置列位置，开始新的数据段
        // 兼容多种表头：款号/款号名称/货号/编码/型号/商品
        const headerMatch = line.match(/款号|货号|编码|型号/) || (text.includes('款号') && /\b商品\b/.test(line));
        if (headerMatch) {
            let parts = line.split(/[\s|]+/).filter(p => p.trim());
            // 处理"32数"这种大小码+数量合并的情况，拆成"32"和"数"两列
            const expanded = [];
            for (const p of parts) {
                const m = p.match(/^(\d+)(数)$/);
                if (m) { expanded.push(m[1]); expanded.push(m[2]); }
                else expanded.push(p);
            }
            parts = expanded;
            let tmpCodeCol = -1, tmpPriceCol = -1;
            for (let j = 0; j < parts.length; j++) {
                const p = parts[j];
                // 款号列兼容：款号、款号名称、货号、编码、型号
                if ((/款号|货号|编码|型号/.test(p)) && tmpCodeCol < 0) tmpCodeCol = j;
                // 回退：商品列
                if (tmpCodeCol < 0 && p.includes('商品')) tmpCodeCol = j;
                // 价格列兼容：单价、价格、成本、进价（小计是金额×数量，不当单价处理，所以不纳入priceCol）
                if ((p === '单价' || p.includes('价格') || p.includes('成本') || p.includes('进价')) && tmpPriceCol < 0) {
                    tmpPriceCol = j;
                }
            }
            if (tmpCodeCol >= 0) {
                codeColIndex = tmpCodeCol;
                priceColIndex = tmpPriceCol;  // 可能为 -1（未找到单价）
                headerColCount = parts.length;
                headerHasSubtotal = parts.some(p => p.includes('小计'));
                foundHeader = true;
                dataStarted = false;
                console.log(`  [4号] 找到表头: 款号列=${codeColIndex}, 价格列=${priceColIndex}, 列数=${headerColCount}, 含小计=${headerHasSubtotal}`);
            }
            continue;
        }

        // 表头之后开始收集数据行
        if (foundHeader && !dataStarted) {
            // 原来用 /^[\d\s]+$/ 跳过，但它会错误跳过纯数字款号行（如 "7713 1 1 70 70"）
            // 只保留行长度检查，极短的行才跳过
            if (line.length < 3) continue;
            dataStarted = true;
        }

        if (dataStarted) {
            // 跳过Markdown章节标题（如"3. 核销记录"、"4. 结余统计"）
            if (/^\d+\.\s/.test(line.trim())) continue;
            // 跳过非数据行关键词
            const skipKeywords = ['序号', '客户', '电话', '地址', '经办人', '店员', '批次', '日期', '总额', '销数', '退数', '微信', '支付宝', '银行', '账号', '农行', '交行', '手机', '提醒', '版本', '入库', 'QR', '扫码', '发生日期', '类型', '本次核销', '上次结余', '本单结余', '累计结余', '本单额', '本单余', '累计余', '抵扣', '欠款', '总数', '实付', '应收', '开单', '退货', '数量', '款数', '数量:', '款数:'];
            if (skipKeywords.some(k => line.includes(k))) continue;

            const parts = line.split(/[\s|]+/).filter(p => p.trim());
            // 如果分割后只有1个部分，且含冒号/等号，跳过（键值对行）
            if (parts.length === 1 && /[：:]/.test(parts[0])) continue;

            // 诊断
            

            // 获取款号：优先用codeColIndex，列数不够时fallback到行中第一个候选
            let codeStr = '';
            if (parts.length > codeColIndex && codeColIndex >= 0) {
                codeStr = parts[codeColIndex].replace(/补/g, '').replace(/[#款]/g, '').replace(/\[[\d]*\]\([^)]*\)/g, '');
            } else if (parts.length > 0) {
                const candidate = parts[0].replace(/补/g, '').replace(/[#款]/g, '');
                if (/^\d+[a-zA-Z\u4e00-\u9fa5]+/.test(candidate) || /^\d{2,}$/.test(candidate)) {
                    codeStr = candidate;
                }
            }
            if (!codeStr || codeStr.length < 2) {
                
                continue;
            }
            // 诊断：打印解析出的parts和款号/价格位置
            

            // 跳过尺码行：一行中超过3个部分匹配尺码格式（26S、XL、30/2XL等）
            const sizeRe = /^\d*[SsMmLlXx]\d*$/;
            const sizeRe2 = /^\d+\/\d+[SsMmLlXx]\d*$/;
            const sizeCount = parts.filter(p => sizeRe.test(p) || sizeRe2.test(p)).length;
            if (sizeCount >= 3) {
                console.log(`  [4号] 跳过尺码行: ${line}`);
                continue;
            }

            // 获取价格：用表头识别的priceColIndex（如果正确识别了价格列），直接从该列取值
            // 当表头含"小计"且数据列数不匹配时（如缺少"名称"列），priceCol会错位，直接走fallback
            let unitPrice = 0;
            const canUsePriceCol = priceColIndex >= 0 && priceColIndex > codeColIndex && priceColIndex < parts.length
                && (!headerHasSubtotal || headerColCount === parts.length);
            if (canUsePriceCol && parts[priceColIndex]) {
                const rawPrice = parts[priceColIndex].replace(/[,，]/g, '').replace(/元$/g, '');
                if (/^-?[\d.]+$/.test(rawPrice)) {
                    const v = parseFloat(rawPrice);
                    if (!isNaN(v) && v > 0) unitPrice = v;
                }
            }
            // 如果priceCol取值失败或不合法，从后往前扫描找单价
            // 账单中金额通常在最后一列，单价在倒数第二列
            if (unitPrice <= 0) {
                const scanStart = Math.max(codeColIndex + 1, parts.length - 2);
                for (let pi = scanStart; pi >= codeColIndex + 1; pi--) {
                    if (pi >= parts.length) continue;
                    const raw = parts[pi].replace(/[,，]/g, '').replace(/元$/g, '');
                    if (!/^-?[\d.]+$/.test(raw)) continue;
                    const v = parseFloat(raw);
                    if (!isNaN(v) && v > 0) { unitPrice = v; break; }
                }
                if (unitPrice <= 0 && parts.length > 1) {
                    for (let pi = parts.length - 1; pi >= 0; pi--) {
                        const raw = parts[pi].replace(/[,，]/g, '').replace(/元$/g, '');
                        if (!/^-?[\d.]+$/.test(raw)) continue;
                        const v = parseFloat(raw);
                        if (!isNaN(v) && v > 0) { unitPrice = v; break; }
                    }
                }
            }
            if (isNaN(unitPrice) || unitPrice <= 0) {
                continue;
            }

            // 清理款号：去掉开头非数字、分号后缀（带描述）、全角横杠
            codeStr = codeStr.replace(/^[^0-9]+/, '').replace(/;.*$/, '');
            // 三段式数字+字母+数字（如2F068）→ 去掉字母段，保留末尾数字：2F068 → 068
            // 两段式数字+字母结尾（如8526jh、25203AB）→ 去掉末尾字母：8526jh → 8526
            const m = codeStr.match(/^(\d+)([a-zA-Z]+)(\d.*)$/);
            if (m) {
                codeStr = m[3];  // 2F068 → 068
            } else {
                codeStr = codeStr.replace(/[a-zA-Z]+$/, '');  // 8526jh → 8526
            }
            codeStr = codeStr.replace(/[－—]/g, '-');
            // 去掉末尾的符号（-、/、_、.等）
            codeStr = codeStr.replace(/[-\/_.]+$/, '');
            // 跳过日期格式的款号（如2026-05-30）
            if (/^\d{4}-\d{2}-\d{2}$/.test(codeStr)) {
                console.log(`  [4号] 跳过日期格式: ${codeStr}`);
                continue;
            }
            // 跳过过短的款号（少于2个字符）
            if (codeStr.length < 2) continue;
            // 如果款号不以缩写开头，加上档口拼音缩写（仅当缩写是纯字母时）
            if (shopAbbr && /^[a-zA-Z]+$/.test(shopAbbr) && !codeStr.startsWith(shopAbbr)) codeStr = shopAbbr + codeStr;
            results.push({ code: codeStr, cost: unitPrice });
        }
    }
    // 去重：同一个款号只保留第一个
    const seen = new Set();
    return results.filter(g => {
        if (seen.has(g.code)) return false;
        seen.add(g.code);
        return true;
    });
}

// 同步到4号表格（商品成本表）
async function syncToTbl4(srcRecord, srcTime) {
    if (!srcRecord || !srcRecord.fields) return 0;
    const content = getText(srcRecord.fields['单据内容']);
    let shopName = getText(srcRecord.fields['档口名称']);
    // 特例：婉星 -> 婉星儿（和write_final.js保持一致）
    if (shopName === '婉星') shopName = '婉星儿';
    if (shopName === '梦莎娜熙恒') shopName = '梦莎娜';
    if (shopName === '喜梦露') shopName = '荷传';
    let shopAbbr = getPinyinInitials(shopName);
    // 拼音转换失败时，从3号表格查询档口缩写
    if (!shopAbbr || /[一-龥]/.test(shopAbbr)) {
        console.log(`  [4号] 拼音转换失败，从3号表格查询档口"${shopName}"的缩写`);
        let tbl3Pt = '';
        do {
            const list = await listRecords(TBL3_TABLE, 100, tbl3Pt);
            if (list.data?.items) {
                for (const item of list.data.items) {
                    const s = (getText(item.fields['档口名称']) || '').trim();
                    if (s === shopName.trim()) {
                        shopAbbr = getText(item.fields['档口缩写']) || '';
                        if (shopAbbr) {
                            console.log(`  [4号] 从3号表格获取缩写: ${shopAbbr}`);
                            break;
                        }
                    }
                }
            }
            tbl3Pt = list.data?.page_token || '';
        } while (tbl3Pt && !shopAbbr);
        if (!shopAbbr) {
            console.log(`  [4号] 3号表格未找到缩写，跳过写入`);
            return 0;
        }
    }
    console.log(`  [4号] 档口=${shopName} 缩写=${shopAbbr || '(无)'}`);

    // 提取商品信息
    const goods = extractGoodsCost(content, shopAbbr);
    if (goods.length === 0) {
        console.log(`  [4号] 无商品信息`);
        return 0;
    }
    console.log(`  [4号] 提取商品: ${goods.length}个`);

    // 记录时间使用当前时间
    let recordTimeStr = getRecordTime();

    // 读取4号表格已有记录
    const tbl4All = [];
    let pt = '';
    do {
        const list = await listRecords(TBL4, 100, pt);
        if (list.data?.items) tbl4All.push(...list.data.items);
        pt = list.data?.page_token || '';
    } while (pt);

    const tbl4Map = new Map();
    for (const r of tbl4All) {
        const code = getText(r.fields['款号']);
        const shop = getText(r.fields['档口']) || '';
        const cost = r.fields['成本'];
        const note = getText(r.fields['备注']) || '';
        const rawSs = r.fields['单据截图'];
        let screenshots = [];
        if (rawSs && Array.isArray(rawSs)) {
            screenshots = rawSs.filter(s => s && s.file_token).map(s => ({ file_token: s.file_token, name: s.name || '单据截图.jpg' }));
        } else if (rawSs && typeof rawSs === 'string' && rawSs.length > 20) {
            screenshots = [{ file_token: rawSs, name: '单据截图.jpg' }];
        }
        if (code && cost != null) tbl4Map.set(code.trim() + '|' + shop.trim(), { id: r.id, cost: Number(cost), note, shop: shop.trim(), screenshots });
    }
    console.log(`  [4号] 已有商品: ${tbl4Map.size}个`);

    // 处理单据截图
    let screenshotField = null;
    const rawSs = srcRecord.fields['单据截图'];
    if (rawSs) {
        if (Array.isArray(rawSs) && rawSs.length > 0) {
            const item = rawSs[0];
            if (item.file_token) screenshotField = [{ file_token: item.file_token, name: item.name || '单据截图.jpg' }];
        } else if (typeof rawSs === 'string' && rawSs.length > 20) {
            screenshotField = [{ file_token: rawSs, name: '单据截图.jpg' }];
        }
    }

    let added = 0;
    const shopNameTrim = shopName.trim();
    for (const g of goods) {
        const existing = tbl4Map.get(g.code.trim() + '|' + shopNameTrim);
        if (!existing) {
            const fields = {
                '款号': g.code.trim(),
                '档口': shopNameTrim,
                '成本': g.cost,
                '记录时间': recordTimeStr,
                '单据内容': content || null
            };
            if (screenshotField) fields['单据截图'] = screenshotField;
            const res = await createRecord(TBL4, fields);
            if (res.code === 0) {
                added++;
                console.log(`  [4号] 新增 ${g.code} 成本=${g.cost}`);
                // 更新Map，防止同一批次中重复创建
                tbl4Map.set(g.code.trim() + '|' + shopNameTrim, { id: res.data.record.id, cost: Number(g.cost), note: '', shop: shopNameTrim, screenshots: screenshotField || [] });
            }
            await sleep(300);
        } else {
            // 备注包含[锁定成本]或[锁定价格]则跳过更新
            const noteStr = existing.note || '';
            if (noteStr.includes('[锁定成本]') || noteStr.includes('[锁定价格]')) {
                console.log(`  [4号] 跳过 ${g.code}（价格已锁定）`);
                continue;
            }
            // 成本没变化则跳过，不更新也不写备注（使用Number确保类型一致）
            if (Number(existing.cost) === Number(g.cost)) {
                console.log(`  [4号] 跳过 ${g.code}（成本无变化）`);
            } else {
                // 成本变化：备注追加新内容，不覆盖旧内容；合并新旧截图
                const oldNote = existing.note || '';
                const newNote = `[${recordTimeStr}] ${shopName} 成本更新为${g.cost}`;
                const mergedNote = oldNote ? `${oldNote}\n${newNote}` : newNote;
                let mergedScreenshots = screenshotField ? [...existing.screenshots, screenshotField[0]] : existing.screenshots;
                // 只保留最新的3张截图
                if (mergedScreenshots.length > 3) {
                    mergedScreenshots = mergedScreenshots.slice(-3);
                    console.log(`  [4号] 截图超过3张，只保留最新3张`);
                }
                const res = await updateRecord(TBL4, existing.id, {
                    '成本': g.cost,
                    '记录时间': recordTimeStr,
                    '备注': mergedNote,
                    '单据截图': mergedScreenshots
                });
                if (res.code === 0) {
                    console.log(`  [4号] 更新 ${g.code} 成本=${g.cost}（备注追加）`);
                }
            }
            await sleep(300);
        }
    }
    return added;
}

async function main() {
    // 清理1号表格中超过7天的冗余数据
    console.log('[CLEANUP] 清理1号表格冗余记录（记录时间>7天前）...');
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const sevenDaysAgoMs = sevenDaysAgo.getTime();

    let srcAll = [], srcPt = '', srcRetries = 3;
    while (true) {
        const list = await listRecords(SRC_TABLE, 100, srcPt);
        if (list.error) { console.log('读取1号表格失败，重试...'); await sleep(2000); srcRetries--; if (srcRetries <= 0) break; continue; }
        if (list.data && list.data.items) srcAll.push(...list.data.items);
        if (!list.data.has_more) break;
        srcPt = list.data.page_token;
        await sleep(500);
    }
    console.log(`1号表格共 ${srcAll.length} 条`);

    let deleted = 0;
    for (const r of srcAll) {
        const recTime = r.fields['记录时间'];
        if (recTime && recTime < sevenDaysAgoMs) {
            const del = await deleteRecord(SRC_TABLE, r.id);
            if (del.code === 0 || del.error && del.error.code === 1244001) {
                deleted++;
                console.log(`  删除 ${r.fields['档口名称']} ${r.fields['批次号']}`);
            } else {
                console.log(`  删除失败 ${r.fields['档口名称']} ${r.fields['批次号']}: ${del.msg || del.error?.msg}`);
            }
            await sleep(500);
        }
    }
    console.log(`清理完成: 删除 ${deleted} 条\n`);

    // 清理1号表格中是否错误=已记录且超过5天的数据
    console.log('[CLEANUP] 清理1号表格已记录数据（是否错误=已记录 且 记录时间>5天前）...');
    const fiveDaysAgo = new Date();
    fiveDaysAgo.setDate(fiveDaysAgo.getDate() - 5);
    const fiveDaysAgoMs = fiveDaysAgo.getTime();

    srcAll = [];
    srcPt = '';
    srcRetries = 3;
    while (true) {
        const list = await listRecords(SRC_TABLE, 100, srcPt);
        if (list.error) { console.log('读取1号表格失败，重试...'); await sleep(2000); srcRetries--; if (srcRetries <= 0) break; continue; }
        if (list.data && list.data.items) srcAll.push(...list.data.items);
        if (!list.data.has_more) break;
        srcPt = list.data.page_token;
        await sleep(500);
    }

    deleted = 0;
    for (const r of srcAll) {
        const err = r.fields['是否错误'];
        const recTime = r.fields['记录时间'];
        if (err && String(err).trim() === '已记录' && recTime && recTime < fiveDaysAgoMs) {
            const del = await deleteRecord(SRC_TABLE, r.id);
            if (del.code === 0 || del.error && del.error.code === 1244001) {
                deleted++;
                console.log(`  删除 ${r.fields['档口名称']} ${r.fields['批次号']}`);
            } else {
                console.log(`  删除失败 ${r.fields['档口名称']} ${r.fields['批次号']}: ${del.msg || del.error?.msg}`);
            }
            await sleep(500);
        }
    }
    console.log(`清理完成: 删除 ${deleted} 条\n`);

    // 获取源表所有记录
    console.log('读取源表...');
    let all = [], pt = '', retries = 3;
    while (true) {
        const list = await listRecords(SRC_TABLE, 100, pt);
        if (list.error) { console.log('读取失败，重试...'); await sleep(2000); retries--; if (retries <= 0) break; continue; }
        if (list.data && list.data.items) all.push(...list.data.items);
        if (!list.data.has_more) break;
        pt = list.data.page_token;
        await sleep(500);
    }
    console.log(`共 ${all.length} 条`);

    // 筛选有效：是否错误字段为空（空白字符也算空）的记录才保留
    const valid = all.filter(r => {
        const err = getText(r.fields['是否错误']);
        // 严格遵守：是否错误项有任何内容（包括空格）都跳过
        if (err && err.trim()) return false;
        return true;
    });
    console.log(`有效: ${valid.length} 条`);

    // 建立 id -> 源表原始序号 的映射
    const idToIdx = new Map(all.map((r, i) => [r.id, i + 1]));

    // 去重：同档口+同批次，保留单据打印时间靠后的（但OBY记录永远去重跳过，强制同步4号表格）
    const seen = new Map();
    for (const r of valid) {
        const shop = getText(r.fields['档口名称']).trim();
        const batch = getText(r.fields['批次号']).trim();
        const key = shop + '|' + batch;
        const existing = seen.get(key);
        // 单据打印时间为空时，用记录时间作fallback
        const curTime = r.fields['单据打印时间'] || r.fields['记录时间'] || 0;
        // OBY记录：永远重新处理（不管表3是否有更新的）
        if (shop.includes('欧贝缘')) {
            seen.set(key, r);  // 强制覆盖
            continue;
        }
        if (!existing || curTime > (existing.fields['单据打印时间'] || existing.fields['记录时间'] || 0)) seen.set(key, r);
    }
    // 按原始序号排序
    const unique = Array.from(seen.values()).sort((a, b) => idToIdx.get(a.id) - idToIdx.get(b.id));
    console.log(`去重后: ${unique.length} 条`);

    // 同步到2号表格（去重后的记录，保留单据打印时间最新）
    let ok = 0;
    for (let i = 0; i < unique.length; i++) {
        const r = unique[i];
        const synced = await syncRecordToDstTable(r, i);
        if (synced) ok++;
    }
    console.log(`\n有效录入: ${ok} 张单据`);

    // 标记被去重跳过的重复记录为已记录（unique 中的记录已在 syncRecordToDstTable 中标记）
    const uniqueIds = new Set(unique.map(r => r.id));
    const dupRecords = valid.filter(r => !uniqueIds.has(r.id));
    if (dupRecords.length > 0) {
        console.log(`[MARK] 标记 ${dupRecords.length} 条重复记录为已记录...`);
        for (const r of dupRecords) {
            await updateRecord(SRC_TABLE, r.id, { '是否错误': '已记录' });
            await sleep(100);
        }
    }

    // ========== 第1.5步：4号表格去重（款号+档口相同则保留记录时间最新） ==========
    console.log('\n[DEDUP-TBL4] 4号表格去重...');
    let tbl4AllDedup = [], tbl4PtDedup = '', tbl4Retries = 3;
    while (true) {
        const list = await listRecords(TBL4, 100, tbl4PtDedup);
        if (list.error) { await sleep(2000); tbl4Retries--; if (tbl4Retries <= 0) break; continue; }
        if (list.data && list.data.items) tbl4AllDedup.push(...list.data.items);
        if (!list.data.has_more) break;
        tbl4PtDedup = list.data.page_token;
        await sleep(500);
    }

    const tbl4DedupMap = new Map();
    for (const r of tbl4AllDedup) {
        const code = getText(r.fields['款号']).trim();
        const shop = getText(r.fields['档口']).trim();
        if (!code || !shop) continue;
        const key = code + '|' + shop;
        const curTime = r.fields['记录时间'] || 0;
        const existing = tbl4DedupMap.get(key);
        if (!existing || curTime > existing.time) {
            tbl4DedupMap.set(key, { record: r, time: curTime });
        }
    }

    const tbl4LatestIds = new Set([...tbl4DedupMap.values()].map(v => v.record.id));
    const tbl4ToDelete = tbl4AllDedup.filter(r => {
        if (tbl4LatestIds.has(r.id)) return false; // 保留最新记录
        // 备注包含锁定标记的不删除
        const note = getText(r.fields['备注']) || '';
        if (note.includes('[锁定成本]') || note.includes('[锁定价格]')) return false;
        return true;
    });

    console.log(`4号去重: 共 ${tbl4AllDedup.length} 条, 最新记录 ${tbl4LatestIds.size} 条, 待删除 ${tbl4ToDelete.length} 条`);

    let tbl4Deleted = 0;
    for (const r of tbl4ToDelete) {
        const del = await deleteRecord(TBL4, r.id);
        if (del.code === 0 || (del.error && del.error.code === 1244001)) {
            tbl4Deleted++;
            console.log(`  删除 ${getText(r.fields['款号'])} ${getText(r.fields['档口'])}`);
        } else {
            console.log(`  删除失败 ${getText(r.fields['款号'])}: ${del.msg || del.error?.msg}`);
        }
        await sleep(500);
    }
    console.log(`4号去重完成: 删除 ${tbl4Deleted} 条`);

    // ========== 第2步：2号表格去重（档口名称+批次号相同则保留单据打印时间最新） ==========
    console.log('\n[DEDUP-TBL2] 2号表格去重...');
    let dstAllDedup = [], dstPtDedup = '', retriesDedup = 3;
    while (true) {
        const list = await listRecords(DST_TABLE, 100, dstPtDedup);
        if (list.error) { await sleep(2000); retriesDedup--; if (retriesDedup <= 0) break; continue; }
        if (list.data && list.data.items) dstAllDedup.push(...list.data.items);
        if (!list.data.has_more) break;
        dstPtDedup = list.data.page_token;
        await sleep(500);
    }

    // Build dedup map: key=shop|batch, value={record, time}
    const dedupMap = new Map();
    for (const r of dstAllDedup) {
        const shop = getText(r.fields['档口名称']).trim();
        const batch = getText(r.fields['批次号']).trim();
        if (!shop || !batch) continue;
        const key = shop + '|' + batch;
        const curTime = r.fields['单据打印时间'] || 0;
        const existing = dedupMap.get(key);
        if (!existing || curTime > existing.time) {
            dedupMap.set(key, { record: r, time: curTime });
        }
    }

    // Find records to delete (records in table but NOT in dedupMap's latest set)
    const latestIds = new Set([...dedupMap.values()].map(v => v.record.id));
    const toDelete = dstAllDedup.filter(r => !latestIds.has(r.id));

    console.log(`去重: 共 ${dstAllDedup.length} 条, 最新记录 ${latestIds.size} 条, 待删除 ${toDelete.length} 条`);

    let deletedDedup = 0;
    for (const r of toDelete) {
        const del = await deleteRecord(DST_TABLE, r.id);
        if (del.code === 0 || (del.error && del.error.code === 1244001)) {
            deletedDedup++;
            console.log(`  删除 ${getText(r.fields['档口名称'])} ${getText(r.fields['批次号'])}`);
        } else {
            console.log(`  删除失败 ${getText(r.fields['档口名称'])}: ${del.msg || del.error?.msg}`);
        }
        await sleep(500);
    }
    console.log(`去重完成: 删除 ${deletedDedup} 条`);

}

main().catch(console.error);
