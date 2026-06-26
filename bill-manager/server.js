/**
 * 票据管理服务
 * 重要：禁止清理2号、3号、4号表格的数据！只允许清理1号表格。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 3000;
// 项目独立运行，路径基于脚本所在目录
const WORKSPACE = __dirname;
const COOKIES_DIR = path.join(__dirname, 'cookies');

// ========== 自动关机状态 ==========
// 用内存标志位记录关机计划，避免 check 接口产生副作用（旧的 /check-shutdown
// 实现会执行 shutdown /a，反而把已安排的关机取消了）
let shutdownScheduledAt = null; // 记录调度关机的时间戳（ms），null 表示未调度
const SHUTDOWN_DELAY_SEC = 60;  // 关机倒计时秒数，需与前端提示保持一致

// ========== 防止多实例运行 ==========
const LOCK_FILE = path.join(WORKSPACE, '.server.lock');
function checkLock() {
    try {
        if (fs.existsSync(LOCK_FILE)) {
            const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim());
            // 检查进程是否还在运行
            try {
                process.kill(pid, 0); // 不发送信号，只检查进程是否存在
                console.error(`服务已在运行中 (PID: ${pid})，请先停止再启动`);
                process.exit(1);
            } catch {
                // 进程不存在，清理旧锁文件
                fs.unlinkSync(LOCK_FILE);
            }
        }
        fs.writeFileSync(LOCK_FILE, process.pid.toString());
    } catch (err) {
        console.error('锁文件处理失败:', err.message);
    }
}
function releaseLock() {
    try {
        if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE);
    } catch {}
}
checkLock();

// ========== 全局错误处理 ==========
process.on('uncaughtException', (err) => {
    console.error('未捕获异常:', err);
    log('服务异常: ' + err.message);
});
process.on('unhandledRejection', (reason) => {
    console.error('未处理的Promise拒绝:', reason);
});
process.on('SIGINT', () => { releaseLock(); process.exit(0); });
process.on('SIGTERM', () => { releaseLock(); process.exit(0); });

// 日志文件
const LOG_FILE = path.join(WORKSPACE, 'bill.log');
const SHOP_LOG_FILE = path.join(WORKSPACE, 'shop.log');  // 店铺商品分析日志（抖店+拼多多+自动化）
const DOUYIN_LOG_FILE = path.join(WORKSPACE, 'douyin.log'); // 旧日志文件，保留兼容

// 图片目录配置文件
const DIR_CONFIG_FILE = path.join(WORKSPACE, 'dir_config.json');

// 获取已保存的店铺列表
function getShops() {
    try {
        if (!fs.existsSync(COOKIES_DIR)) return [];
        const files = fs.readdirSync(COOKIES_DIR);
        return files
            .filter(f => f.endsWith('.json'))
            .map(f => f.replace('.json', ''));
    } catch (err) {
        return [];
    }
}

// 删除店铺cookie
function removeShop(shopName) {
    try {
        // 检查抖店cookies目录
        const cookiePath = path.join(COOKIES_DIR, `${shopName}.json`);
        if (fs.existsSync(cookiePath)) {
            fs.unlinkSync(cookiePath);
            return true;
        }
        // 检查拼多多cookies目录
        const pddCookiesDir = path.join(WORKSPACE, 'pdd-cookies');
        const pddCookiePath = path.join(pddCookiesDir, `${shopName}.json`);
        if (fs.existsSync(pddCookiePath)) {
            fs.unlinkSync(pddCookiePath);
            return true;
        }
    } catch (err) {}
    return false;
}

// 当前运行的子进程（按任务类型分开管理）
let billProcess = null;        // 票据录入/整理进程
let douyinProcess = null;      // 抖音单次分析进程
let douyinMultiProcess = null; // 抖音多次执行进程
let pddProcess = null;         // 拼多多进程
let isBillCheckRunning = false;
let isDouyinRunning = false;
let isDouyinMultiRunning = false;

// 读取指定日志文件的内容
function getLogsFromFile(filePath, hours = 24, linesCount = 1000) {
    try {
        if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath, 'utf8');
            const lines = content.split('\n')
                .map(l => l.replace(/[\r]/g, '').trim())
                .filter(l => l);

            // 时间过滤
            const cutoff = Date.now() - hours * 60 * 60 * 1000;
            const filtered = lines.filter(line => {
                const m = line.match(/^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]/);
                if (!m) return true;
                return new Date(m[1]).getTime() >= cutoff;
            });

            // 行数限制
            const recent = filtered.slice(-linesCount);
            return recent.map(line => line.length > 200 ? line.substring(0, 200) + '...' : line);
        }
    } catch (err) {}
    return [];
}

// 读取票据日志（保持兼容）
function getLogs() {
    return getLogsFromFile(LOG_FILE);
}

// 写入日志到指定文件
function logToFile(msg, filePath) {
    const targetFile = filePath || LOG_FILE;
    const time = new Date().toISOString();
    // 清理消息中的特殊字符，确保JSON安全（保留换行符\n）
    const clean = msg
        .replace(/[\r]/g, '')
        .replace(/\\/g, '/')
        .replace(/"/g, "'")
        .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, '')  // 保留0x0A(\n)
        .substring(0, 2000);  // 增加长度限制
    // 处理多行日志：每行都添加时间戳
    const lines = clean.split('\n');
    const logLines = lines.map(line => `[${time}] ${line}`);
    fs.appendFileSync(targetFile, logLines.join('\n') + '\n');
    // 日志轮转：超过5MB时截断
    try {
        const stats = fs.statSync(targetFile);
        if (stats.size > 5 * 1024 * 1024) {
            const content = fs.readFileSync(targetFile, 'utf8');
            const lines = content.split('\n');
            const keep = lines.slice(-1000);
            fs.writeFileSync(targetFile, keep.join('\n'));
        }
    } catch {}
}

function log(msg) {
    console.log(msg);
    logToFile(msg, LOG_FILE);
}

function douyinLog(msg) {
    console.log(msg);
    logToFile(msg, DOUYIN_LOG_FILE);
}

function shopLog(msg) {
    console.log(msg);
    logToFile(msg, SHOP_LOG_FILE);
}

// 路由处理
const server = http.createServer((req, res) => {
    // 设置CORS和缓存控制
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    // 健康检查
    if (req.url === '/ping') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
        return;
    }

    // 静态文件服务 - index.html
    if (req.url === '/' || req.url === '/index.html') {
        const htmlPath = path.join(WORKSPACE, 'index.html');
        fs.readFile(htmlPath, (err, data) => {
            if (err) {
                res.writeHead(500);
                res.end('Error loading HTML');
                return;
            }
            res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0'
            });
            res.end(data);
        });
        return;
    }

    // 查询进程状态
    if (req.url === '/get-process-status' && req.method === 'GET') {
        const shopRunning = isDouyinRunning || isDouyinMultiRunning || !!pddProcess;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            running: isBillCheckRunning || shopRunning,
            billRunning: isBillCheckRunning,
            shopRunning,
            douyinRunning: isDouyinRunning  // 保留兼容
        }));
        return;
    }

    // 停止票据进程（只杀票据，不影响商品分析）
    if (req.url === '/stop-bill' && req.method === 'POST') {
        let stopped = false;
        if (isBillCheckRunning) {
            isBillCheckRunning = false;
            log('票据录入状态已重置');
            stopped = true;
        }
        if (billProcess) {
            if (process.platform === 'win32') {
                spawn('taskkill', ['/T', '/F', '/PID', billProcess.pid.toString()]);
            } else {
                billProcess.kill('SIGTERM');
            }
            log('票据进程已终止');
            billProcess = null;
            stopped = true;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: stopped, message: stopped ? '已停止票据进程' : '没有运行中的票据进程' }));
        return;
    }

    // 停止商品分析进程（只杀抖店/拼多多，不影响票据）
    if (req.url === '/stop-shop' && req.method === 'POST') {
        let stopped = false;
        if (isDouyinRunning) {
            isDouyinRunning = false;
            shopLog('商品获取状态已重置');
            stopped = true;
        }
        if (isDouyinMultiRunning) {
            isDouyinMultiRunning = false;
            shopLog('商品多次执行状态已重置');
            stopped = true;
        }
        // 终止商品分析相关的进程（Windows 需杀掉整个进程树）
        const shopProcesses = [
            { proc: douyinProcess, name: '抖音' },
            { proc: douyinMultiProcess, name: '抖音多次' },
            { proc: pddProcess, name: '拼多多' }
        ];
        for (const { proc, name } of shopProcesses) {
            if (proc) {
                if (process.platform === 'win32') {
                    spawn('taskkill', ['/T', '/F', '/PID', proc.pid.toString()]);
                } else {
                    proc.kill('SIGTERM');
                }
                shopLog(`${name}进程已终止`);
                stopped = true;
            }
        }
        douyinProcess = null;
        douyinMultiProcess = null;
        pddProcess = null;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: stopped, message: stopped ? '已停止商品分析进程' : '没有运行中的商品分析进程' }));
        return;
    }

    // 获取图片目录配置
    if (req.url === '/get-dir-config' && req.method === 'GET') {
        let dir = '';
        try {
            if (fs.existsSync(DIR_CONFIG_FILE)) {
                const cfg = JSON.parse(fs.readFileSync(DIR_CONFIG_FILE, 'utf-8'));
                dir = cfg.dir || '';
            }
        } catch {}
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ dir }));
        return;
    }

    // 设置图片目录配置
    if (req.url === '/set-dir-config' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { dir } = JSON.parse(body);
                fs.writeFileSync(DIR_CONFIG_FILE, JSON.stringify({ dir: dir || '' }, null, 2));
                log('图片目录已更新: ' + (dir || '默认'));
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
            } catch (e) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, message: e.message }));
            }
        });
        return;
    }


    // 录入票据 - 使用 bill_image.py
    if (req.url === '/run-bill-check' && req.method === 'POST') {
        if (isBillCheckRunning) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: '已有运行的进程' }));
            return;
        }
        isBillCheckRunning = true;

        // 立即返回响应，不等待请求体
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: '已启动' }));

        // 消费请求体（避免连接泄漏）
        req.resume();

        log('=== 开始录入票据 ===');

        // 读取目录配置
        let targetDir = '';
        try {
            if (fs.existsSync(DIR_CONFIG_FILE)) {
                const cfg = JSON.parse(fs.readFileSync(DIR_CONFIG_FILE, 'utf-8'));
                targetDir = cfg.dir || '';
            }
        } catch {}

        const billCheckPy = path.join(WORKSPACE, 'bill_image.py');
        const pyArgs = ['-u', billCheckPy];
        if (targetDir) pyArgs.push(targetDir);
        const py = spawn('python', pyArgs, {
            shell: true,
            cwd: WORKSPACE,
            env: { ...process.env, PYTHONUNBUFFERED: '1' }
        });
        billProcess = py;

        py.stdout.on('data', (data) => {
            const msg = data.toString().trim();
            if (msg) log(msg);
        });

        py.stderr.on('data', (data) => {
            const msg = data.toString().trim();
            // 过滤掉python warnings
            if (msg && !msg.includes('Warning') && !msg.includes('RequestsDependencyWarning')) {
                log('[错误] ' + msg);
            }
        });

        py.on('close', (code) => {
            isBillCheckRunning = false;
            billProcess = null;
            log('=== 录入票据结束 ===');
        });
        return;
    }

    // 整理票据 - 使用 arrange2.js
    if (req.url === '/run-arrange' && req.method === 'POST') {
        if (isBillCheckRunning) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: '已有运行的进程' }));
            return;
        }
        isBillCheckRunning = true;

        // 立即返回响应，不等待请求体
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: '已启动' }));

        // 消费请求体
        req.resume();

        log('=== 开始整理票据 ===');

        const node = spawn('node', [path.join(WORKSPACE, 'arrange2.js')], {
            shell: true,
            cwd: WORKSPACE,
            env: { ...process.env, NODE_OPTIONS: '' }
        });
        billProcess = node;

        node.stdout.on('data', (data) => {
            const msg = data.toString().trim();
            if (msg) log(msg);
        });

        node.stderr.on('data', (data) => {
            const msg = data.toString().trim();
            if (msg) log('[错误] ' + msg);
        });

        node.on('close', (code) => {
            billProcess = null;
            isBillCheckRunning = false;
            log('=== 整理票据结束 ===');
        });
        return;
    }

    // 抖店商品信息获取 - 使用 douyin-shop-analyzer.js
    if (req.url === '/run-douyin-analyzer' && req.method === 'POST') {
        // 智能检查：如果标志为true但进程不存在，重置标志
        if (isDouyinRunning) {
            if (douyinProcess) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, message: '已有运行的进程' }));
                return;
            } else {
                // 进程不存在但标志未重置，强制重置
                shopLog('[修复] 检测到标志未重置，强制重置 isDouyinRunning');
                isDouyinRunning = false;
            }
        }
        // 先设置运行状态，再返回响应
        isDouyinRunning = true;
        // 防止卡死：如果10秒内进程还没启动，重置标志
        const douyinSafetyTimer = setTimeout(() => {
            if (isDouyinRunning && !douyinProcess) {
                isDouyinRunning = false;
                shopLog('[安全] 超时重置 isDouyinRunning');
            }
        }, 10000);

        // 清理旧的cookie过期标记
        const markerFile = path.join(WORKSPACE, 'cookie_expired.txt');
        if (fs.existsSync(markerFile)) { try { fs.unlinkSync(markerFile); } catch (e) {} }

        // 立即返回响应，不等待请求体
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: '已启动' }));

        // 读取请求体（用Buffer收集，避免编码问题）
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            let targetCount = 1;
            let shopName = '';
            let shippingFee = 2.1;
            let insurance = 4.01;
            try {
                const body = Buffer.concat(chunks).toString('utf8');
                const parsed = JSON.parse(body);
                targetCount = parseInt(parsed.targetCount) || 1;
                shopName = parsed.shopName || '';
                shippingFee = parseFloat(parsed.shippingFee) || 2.1;
                insurance = parseFloat(parsed.insurance) || 4.01;
            } catch (e) {}
            shopLog(`=== 开始获取抖店商品信息 (目标${targetCount}个) [${shopName}] ===`);

            // 将店铺名写入临时文件（用Buffer写入确保编码正确）
            const shopNameFile = path.join(WORKSPACE, 'current_shop.txt');
            fs.writeFileSync(shopNameFile, Buffer.from(shopName, 'utf8'));

            // 将费用配置写入临时文件
            const feeConfigFile = path.join(WORKSPACE, 'fee_config.json');
            fs.writeFileSync(feeConfigFile, JSON.stringify({ shippingFee, insurance }));

            const douyinScript = path.join(WORKSPACE, 'douyin-shop-analyzer.js');
            const node = spawn('node', [douyinScript, targetCount.toString()], {
                shell: true,
                cwd: WORKSPACE
            });
            douyinProcess = node;
            clearTimeout(douyinSafetyTimer);

            node.stdout.on('data', (data) => {
                const raw = data.toString();
                const lines = raw.split('\n');
                for (const line of lines) {
                    const msg = line.trim();
                    if (!msg) continue;
                    shopLog(msg);
                    if (msg.indexOf('COOKIE_EXPIRED:') !== -1) {
                        const idx = msg.indexOf('COOKIE_EXPIRED:');
                        const expiredShop = msg.substring(idx + 'COOKIE_EXPIRED:'.length).trim();
                        shopLog(`[DEBUG] 检测到过期信号, 店铺=${expiredShop}`);
                        if (expiredShop) {
                            const safeName = expiredShop.replace(/[\\/:*?"<>|]/g, '_');
                            const cookieFile = path.join(COOKIES_DIR, safeName + '.json');
                            shopLog(`[DEBUG] cookie文件: ${cookieFile}, 存在=${fs.existsSync(cookieFile)}`);
                            try {
                                if (fs.existsSync(cookieFile)) {
                                    fs.unlinkSync(cookieFile);
                                    shopLog(`Cookie已过期，自动删除店铺: ${expiredShop}`);
                                } else {
                                    shopLog(`Cookie文件不存在: ${cookieFile}`);
                                }
                            } catch (e) {
                                shopLog(`删除cookie失败: ${e.message}`);
                            }
                        }
                    }
                }
            });

            node.stderr.on('data', (data) => {
                const lines = data.toString().split('\n');
                for (const line of lines) {
                    const msg = line.trim();
                    if (msg) shopLog('[错误] ' + msg);
                }
            });

            node.on('close', (code) => {
                douyinProcess = null;
                isDouyinRunning = false;
                // 检查cookie过期标记文件
                const markerFile = path.join(WORKSPACE, 'cookie_expired.txt');
                if (fs.existsSync(markerFile)) {
                    try {
                        const expiredShop = fs.readFileSync(markerFile, 'utf-8').trim();
                        fs.unlinkSync(markerFile);
                        if (expiredShop) {
                            const safeName = expiredShop.replace(/[\\/:*?"<>|]/g, '_');
                            const cookieFile = path.join(COOKIES_DIR, safeName + '.json');
                            if (fs.existsSync(cookieFile)) {
                                fs.unlinkSync(cookieFile);
                                shopLog(`Cookie已过期，自动删除店铺: ${expiredShop}`);
                            }
                        }
                    } catch (e) { shopLog(`标记文件处理异常: ${e.message}`); }
                }
                shopLog('=== 抖店商品信息获取结束 ===');
            });
        });
        return;
    }

    // 抖店商品信息多次执行
    if (req.url === '/run-douyin-multi' && req.method === 'POST') {
        if (isDouyinMultiRunning) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: '已有运行的进程' }));
            return;
        }
        // 清理旧的cookie过期标记
        const markerFile2 = path.join(WORKSPACE, 'cookie_expired.txt');
        if (fs.existsSync(markerFile2)) { try { fs.unlinkSync(markerFile2); } catch (e) {} }
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            let targetCount = 1;
            let intervalMinutes = 30;
            let shopName = '';
            let shippingFee = 2.1;
            let insurance = 4.01;
            try {
                const parsed = JSON.parse(body);
                targetCount = parseInt(parsed.targetCount) || 1;
                intervalMinutes = parseInt(parsed.intervalMinutes) || 30;
                shopName = parsed.shopName || '';
                shippingFee = parseFloat(parsed.shippingFee) || 2.1;
                insurance = parseFloat(parsed.insurance) || 4.01;
            } catch (e) {}
            shopLog(`=== 开始多次获取抖店商品信息 (目标${targetCount}个, 间隔${intervalMinutes}分钟) [${shopName}] ===`);

            // 将店铺名写入临时文件（避免编码问题）
            const shopNameFile = path.join(WORKSPACE, 'current_shop.txt');
            fs.writeFileSync(shopNameFile, shopName);

            // 将费用配置写入临时文件
            const feeConfigFile = path.join(WORKSPACE, 'fee_config.json');
            fs.writeFileSync(feeConfigFile, JSON.stringify({ shippingFee, insurance }));

            const douyinScript = path.join(WORKSPACE, 'douyin-shop-analyzer.js');
            const node = spawn('node', [douyinScript, targetCount.toString(), intervalMinutes.toString(), 'multi'], {
                shell: true,
                cwd: WORKSPACE
            });
            douyinMultiProcess = node;

            node.stdout.on('data', (data) => {
                const raw = data.toString();
                const lines = raw.split('\n');
                for (const line of lines) {
                    const msg = line.trim();
                    if (!msg) continue;
                    shopLog(msg);
                    if (msg.indexOf('COOKIE_EXPIRED:') !== -1) {
                        const idx = msg.indexOf('COOKIE_EXPIRED:');
                        const expiredShop = msg.substring(idx + 'COOKIE_EXPIRED:'.length).trim();
                        shopLog(`[DEBUG] 检测到过期信号, 店铺=${expiredShop}`);
                        if (expiredShop) {
                            const safeName = expiredShop.replace(/[\\/:*?"<>|]/g, '_');
                            const cookieFile = path.join(COOKIES_DIR, safeName + '.json');
                            try {
                                if (fs.existsSync(cookieFile)) {
                                    fs.unlinkSync(cookieFile);
                                    shopLog(`Cookie已过期，自动删除店铺: ${expiredShop}`);
                                }
                            } catch (e) {
                                shopLog(`删除cookie失败: ${e.message}`);
                            }
                        }
                    }
                }
            });

            node.stderr.on('data', (data) => {
                const lines = data.toString().split('\n');
                for (const line of lines) {
                    const msg = line.trim();
                    if (msg) shopLog('[错误] ' + msg);
                }
            });

            node.on('close', (code) => {
                douyinMultiProcess = null;
                isDouyinMultiRunning = false;
                // 检查cookie过期标记文件
                const markerFile = path.join(WORKSPACE, 'cookie_expired.txt');
                if (fs.existsSync(markerFile)) {
                    try {
                        const expiredShop = fs.readFileSync(markerFile, 'utf-8').trim();
                        fs.unlinkSync(markerFile);
                        if (expiredShop) {
                            const safeName = expiredShop.replace(/[\\/:*?"<>|]/g, '_');
                            const cookieFile = path.join(COOKIES_DIR, safeName + '.json');
                            if (fs.existsSync(cookieFile)) {
                                fs.unlinkSync(cookieFile);
                                shopLog(`Cookie已过期，自动删除店铺: ${expiredShop}`);
                            }
                        }
                    } catch (e) {}
                }
                shopLog('=== 抖店商品信息多次执行结束 ===');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: code === 0,
                    message: code === 0 ? '完成' : '失败'
                }));
            });
        });
        return;
    }

    // 获取已保存的店铺列表
    if (req.url === '/get-shops' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ shops: getShops() }));
        return;
    }

    // 登录新店铺
    if (req.url === '/login-new-shop' && req.method === 'POST') {
        isDouyinRunning = true;
        shopLog('=== 开始登录新店铺 ===');

        const loginScript = path.join(WORKSPACE, 'login-shop.js');
        const node = spawn('node', [loginScript], {
            shell: true,
            cwd: WORKSPACE
        });

        let shopName = '';
        node.stdout.on('data', (data) => {
            const msg = data.toString().trim();
            if (msg) {
                shopLog(msg);
                if (msg.startsWith('SHOP_NAME:')) {
                    shopName = msg.replace('SHOP_NAME:', '');
                }
            }
        });

        node.stderr.on('data', (data) => {
            const msg = data.toString().trim();
            if (msg) shopLog('[错误] ' + msg);
        });

        node.on('close', (code) => {
            isDouyinRunning = false;
            shopLog('=== 登录新店铺结束 ===');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            if (code === 0 && shopName) {
                res.end(JSON.stringify({ success: true, shopName }));
            } else {
                res.end(JSON.stringify({ success: false, message: '登录失败或超时' }));
            }
        });
        return;
    }

    // 删除失效店铺
    if (req.url === '/remove-shop' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const parsed = JSON.parse(body);
                const removed = removeShop(parsed.shopName);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: removed }));
            } catch (e) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false }));
            }
        });
        return;
    }

    // ========== 拼多多相关接口 ==========
    // 获取拼多多店铺列表（使用独立的cookies目录）
    if (req.url === '/get-pdd-shops' && req.method === 'GET') {
        const pddCookiesDir = path.join(WORKSPACE, 'pdd-cookies');
        try {
            if (!fs.existsSync(pddCookiesDir)) fs.mkdirSync(pddCookiesDir, { recursive: true });
            const files = fs.readdirSync(pddCookiesDir);
            const shops = files.filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ shops }));
        } catch {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ shops: [] }));
        }
        return;
    }

    // 登录新拼多多店铺
    if (req.url === '/login-new-pdd-shop' && req.method === 'POST') {
        isDouyinRunning = true;
        shopLog('=== 开始登录拼多多店铺 ===');
        const pddLoginScript = path.join(WORKSPACE, 'pdd-login-shop.js');
        if (!fs.existsSync(pddLoginScript)) {
            isDouyinRunning = false;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: '拼多多登录脚本不存在，请先创建 pdd-login-shop.js' }));
            return;
        }
        const node = spawn('node', [pddLoginScript], { shell: true, cwd: WORKSPACE });
        let shopName = '';
        node.stdout.on('data', (data) => {
            const msg = data.toString().trim();
            if (msg) shopLog(msg);
        });
        node.stderr.on('data', (data) => {
            const msg = data.toString().trim();
            if (msg) {
                if (msg.startsWith('SHOP_NAME:')) {
                    shopName = msg.replace('SHOP_NAME:', '');
                } else {
                    shopLog('[错误] ' + msg);
                }
            }
        });
        node.on('close', (code) => {
            isDouyinRunning = false;
            shopLog('=== 登录拼多多店铺结束 ===');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(code === 0 && shopName ? { success: true, shopName } : { success: false, message: '登录失败或超时' }));
        });
        return;
    }

    // 拼多多商品获取
    if (req.url === '/run-pdd-analyzer' && req.method === 'POST') {
        // 智能检查：如果标志为true但进程不存在，重置标志
        if (isDouyinRunning) {
            if (pddProcess) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, message: '已有运行的进程' }));
                return;
            } else {
                shopLog('[修复] 检测到标志未重置，强制重置 isDouyinRunning');
                isDouyinRunning = false;
            }
        }
        isDouyinRunning = true;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: '已启动' }));
        // 防止卡死：如果10秒内进程还没启动，重置标志
        const pddSafetyTimer = setTimeout(() => {
            if (isDouyinRunning && !pddProcess) {
                isDouyinRunning = false;
                shopLog('[安全] 超时重置 isDouyinRunning (PDD)');
            }
        }, 10000);
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            let targetCount = 1, shopName = '', shippingFee = 2.1, insurance = 4.01;
            try {
                const parsed = JSON.parse(body);
                targetCount = parseInt(parsed.targetCount) || 1;
                shopName = parsed.shopName || '';
                shippingFee = parseFloat(parsed.shippingFee) || 2.1;
                insurance = parseFloat(parsed.insurance) || 4.01;
            } catch {}
            shopLog(`=== 开始获取拼多多商品 (目标${targetCount}个) [${shopName}] ===`);
            const pddScript = path.join(WORKSPACE, 'pdd-shop-analyzer.js');
            if (!fs.existsSync(pddScript)) {
                isDouyinRunning = false;
                shopLog('[错误] 拼多多脚本不存在: pdd-shop-analyzer.js');
                shopLog('=== 拼多多商品获取结束 ===');
                return;
            }
            // 将店铺名写入临时文件
            const shopNameFile = path.join(WORKSPACE, 'current_shop.txt');
            fs.writeFileSync(shopNameFile, Buffer.from(shopName, 'utf8'));
            const feeConfigFile = path.join(WORKSPACE, 'fee_config.json');
            fs.writeFileSync(feeConfigFile, JSON.stringify({ shippingFee, insurance }));
            const node = spawn('node', [pddScript, targetCount.toString()], { shell: true, cwd: WORKSPACE });
            pddProcess = node;
            node.stdout.on('data', (data) => { const msg = data.toString().trim(); if (msg) shopLog(msg); });
            node.stderr.on('data', (data) => { const msg = data.toString().trim(); if (msg) shopLog('[错误] ' + msg); });
            node.on('close', (code) => {
                clearTimeout(pddSafetyTimer);
                pddProcess = null;
                isDouyinRunning = false;
                // 检测cookie过期标记文件，自动删除过期店铺
                const markerFile = path.join(WORKSPACE, 'cookie_expired.txt');
                try {
                    if (fs.existsSync(markerFile)) {
                        const expiredShop = fs.readFileSync(markerFile, 'utf8').trim();
                        if (expiredShop) {
                            removeShop(expiredShop);
                            shopLog(`Cookie已过期，自动删除店铺: ${expiredShop}`);
                        }
                        fs.unlinkSync(markerFile);
                    }
                } catch (e) {}
                shopLog('=== 拼多多商品获取结束 ===');
            });
        });
        return;
    }

    // 获取日志（票据）
    if (req.url.startsWith('/get-logs') && req.method === 'GET') {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const hours = parseInt(url.searchParams.get('hours')) || 24;
        const lines = parseInt(url.searchParams.get('lines')) || 1000;
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ logs: getLogsFromFile(LOG_FILE, hours, lines) }));
        return;
    }

    // 获取抖店/拼多多日志（旧接口，保留兼容）
    if (req.url.startsWith('/get-douyin-logs') && req.method === 'GET') {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const hours = parseInt(url.searchParams.get('hours')) || 24;
        const lines = parseInt(url.searchParams.get('lines')) || 1000;
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ logs: getLogsFromFile(DOUYIN_LOG_FILE, hours, lines) }));
        return;
    }

    // 获取店铺商品分析日志（新接口，抖店+拼多多+自动化共用）
    if (req.url.startsWith('/get-shop-logs') && req.method === 'GET') {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const hours = parseInt(url.searchParams.get('hours')) || 24;
        const lines = parseInt(url.searchParams.get('lines')) || 1000;
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ logs: getLogsFromFile(SHOP_LOG_FILE, hours, lines) }));
        return;
    }

    // 定时关机（60秒后）
    if (req.url === '/schedule-shutdown' && req.method === 'POST') {
        log(`=== ${SHUTDOWN_DELAY_SEC}秒后自动关机 ===`);
        spawn('shutdown', ['-s', '-t', String(SHUTDOWN_DELAY_SEC)], { shell: true });
        shutdownScheduledAt = Date.now(); // 记录调度时间
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
    }

    // 检查关机状态（只读，不产生副作用）
    if (req.url === '/check-shutdown' && req.method === 'GET') {
        if (shutdownScheduledAt) {
            // 根据调度时间计算剩余秒数；若已超过延迟时间，说明早已关机或被外部取消
            const elapsed = Math.floor((Date.now() - shutdownScheduledAt) / 1000);
            const remaining = SHUTDOWN_DELAY_SEC - elapsed;
            if (remaining > 0) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    shutdownScheduled: true,
                    shutdownTime: `${remaining}秒后`
                }));
            } else {
                // 倒计时已过但服务还在运行，说明关机被外部取消，清理标志位
                shutdownScheduledAt = null;
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ shutdownScheduled: false }));
            }
        } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ shutdownScheduled: false }));
        }
        return;
    }

    // 取消关机
    if (req.url === '/cancel-shutdown' && req.method === 'POST') {
        spawn('shutdown', ['/a'], { shell: true });
        shutdownScheduledAt = null; // 清理标志位
        log('=== 已取消自动关机 ===');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
    }

    // 404
    res.writeHead(404);
    res.end('Not Found');
});


server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`端口 ${PORT} 已被占用，请先停止占用该端口的进程`);
        releaseLock();
        process.exit(1);
    }
    console.error('服务器错误:', err);
});

// 确保退出时清理锁文件
process.on('exit', releaseLock);

server.listen(PORT, () => {
    // 只写入日志文件，不输出到console（避免开机启动时显示窗口）
    logToFile(`票据管理服务已启动: http://localhost:${PORT}`, LOG_FILE);
});