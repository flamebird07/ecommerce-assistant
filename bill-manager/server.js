/**
 * 票据管理服务
 * 重要：禁止清理2号、3号、4号表格的数据！只允许清理1号表格。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 3000;
const WORKSPACE = 'C:\\Users\\Administrator\\.openclaw\\workspace';
const COOKIES_DIR = 'C:\\Users\\Administrator\\.openclaw\\cookies';

// 日志文件
const LOG_FILE = path.join(WORKSPACE, 'bill.log');

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
        const cookiePath = path.join(COOKIES_DIR, `${shopName}.json`);
        if (fs.existsSync(cookiePath)) {
            fs.unlinkSync(cookiePath);
            return true;
        }
    } catch (err) {}
    return false;
}

// 当前运行的子进程
let currentProcess = null;
let isBillCheckRunning = false;
let isDouyinRunning = false;
let isDouyinMultiRunning = false;

// 读取日志
function getLogs() {
    try {
        if (fs.existsSync(LOG_FILE)) {
            const content = fs.readFileSync(LOG_FILE, 'utf8');
            return content.split('\n').filter(line => line.trim());
        }
    } catch (err) {}
    return [];
}

function logToFile(msg) {
    const time = new Date().toISOString();
    fs.appendFileSync(LOG_FILE, `[${time}] ${msg}\n`);
}

function log(msg) {
    console.log(msg);
    logToFile(msg);
}

// 路由处理
const server = http.createServer((req, res) => {
    // 设置CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
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
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        });
        return;
    }

    // 停止进程
    if (req.url === '/stop-process' && req.method === 'POST') {
        let stopped = false;
        // 先清除运行标志
        if (isBillCheckRunning) {
            isBillCheckRunning = false;
            log('票据录入状态已重置');
            stopped = true;
        }
        if (isDouyinRunning) {
            isDouyinRunning = false;
            log('抖店商品获取状态已重置');
            stopped = true;
        }
        if (isDouyinMultiRunning) {
            isDouyinMultiRunning = false;
            log('抖店商品多次执行状态已重置');
            stopped = true;
        }
        // 再终止实际的 node 进程（Windows 需杀掉整个进程树）
        if (currentProcess) {
            if (process.platform === 'win32') {
                spawn('taskkill', ['/T', '/F', '/PID', currentProcess.pid.toString()]);
            } else {
                currentProcess.kill('SIGTERM');
            }
            log('进程已终止');
            currentProcess = null;
            stopped = true;
        }
        if (stopped) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: '已停止' }));
        } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: '没有运行中的进程' }));
        }
        return;
    }

    // 录入票据 - 使用 bill_check_fixed.py
    if (req.url === '/run-bill-check' && req.method === 'POST') {
        if (isBillCheckRunning) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: '已有运行的进程' }));
            return;
        }
        if (fs.existsSync(LOG_FILE)) { fs.writeFileSync(LOG_FILE, ''); }
        isBillCheckRunning = true;
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            log('=== 开始录入票据 ===');

            const billCheckPy = path.join(WORKSPACE, 'bill_image.py');
            const py = spawn('python', [billCheckPy], {
                shell: true,
                cwd: WORKSPACE
            });
            currentProcess = py;

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
                currentProcess = null;
                log('=== 录入票据结束 ===');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: code === 0,
                    message: code === 0 ? '完成' : '失败'
                }));
            });
        });
        return;
    }

    // 整理票据 - 使用 arrange2.js
    if (req.url === '/run-arrange' && req.method === 'POST') {
        if (fs.existsSync(LOG_FILE)) { fs.writeFileSync(LOG_FILE, ''); }
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            log('=== 开始整理票据 ===');

            const node = spawn('node', [path.join(WORKSPACE, 'arrange2.js')], {
                shell: true,
                cwd: WORKSPACE
            });
            currentProcess = node;

            node.stdout.on('data', (data) => {
                const msg = data.toString().trim();
                if (msg) log(msg);
            });

            node.stderr.on('data', (data) => {
                const msg = data.toString().trim();
                if (msg) log('[错误] ' + msg);
            });

            node.on('close', (code) => {
                currentProcess = null;
                log('=== 整理票据结束 ===');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: code === 0,
                    message: code === 0 ? '完成' : '失败'
                }));
            });
        });
        return;
    }

    // 抖店商品信息获取 - 使用 douyin-shop-analyzer.js
    if (req.url === '/run-douyin-analyzer' && req.method === 'POST') {
        if (isDouyinRunning) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: '已有运行的进程' }));
            return;
        }
        if (fs.existsSync(LOG_FILE)) { fs.writeFileSync(LOG_FILE, ''); }
        // 清理旧的cookie过期标记
        const markerFile = 'C:\\Users\\Administrator\\.openclaw\\cookie_expired.txt';
        if (fs.existsSync(markerFile)) { try { fs.unlinkSync(markerFile); } catch (e) {} }
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            let targetCount = 1;
            let shopName = '';
            let shippingFee = 2.1;
            let insurance = 4.01;
            try {
                const parsed = JSON.parse(body);
                targetCount = parseInt(parsed.targetCount) || 1;
                shopName = parsed.shopName || '';
                shippingFee = parseFloat(parsed.shippingFee) || 2.1;
                insurance = parseFloat(parsed.insurance) || 4.01;
            } catch (e) {}
            log(`=== 开始获取抖店商品信息 (目标${targetCount}个) [${shopName}] ===`);

            // 将店铺名写入临时文件（避免编码问题）
            const shopNameFile = 'C:\\Users\\Administrator\\.openclaw\\current_shop.txt';
            fs.writeFileSync(shopNameFile, shopName);

            // 将费用配置写入临时文件
            const feeConfigFile = 'C:\\Users\\Administrator\\.openclaw\\fee_config.json';
            fs.writeFileSync(feeConfigFile, JSON.stringify({ shippingFee, insurance }));

            const douyinScript = 'C:\\Users\\Administrator\\douyin-shop-analyzer.js';
            const node = spawn('node', [douyinScript, targetCount.toString()], {
                shell: true,
                cwd: 'C:\\Users\\Administrator'
            });
            currentProcess = node;

            node.stdout.on('data', (data) => {
                const raw = data.toString();
                const lines = raw.split('\n');
                for (const line of lines) {
                    const msg = line.trim();
                    if (!msg) continue;
                    log(msg);
                    if (msg.indexOf('COOKIE_EXPIRED:') !== -1) {
                        const idx = msg.indexOf('COOKIE_EXPIRED:');
                        const expiredShop = msg.substring(idx + 'COOKIE_EXPIRED:'.length).trim();
                        log(`[DEBUG] 检测到过期信号, 店铺=${expiredShop}`);
                        if (expiredShop) {
                            const safeName = expiredShop.replace(/[\\/:*?"<>|]/g, '_');
                            const cookieFile = path.join(COOKIES_DIR, safeName + '.json');
                            log(`[DEBUG] cookie文件: ${cookieFile}, 存在=${fs.existsSync(cookieFile)}`);
                            try {
                                if (fs.existsSync(cookieFile)) {
                                    fs.unlinkSync(cookieFile);
                                    log(`Cookie已过期，自动删除店铺: ${expiredShop}`);
                                } else {
                                    log(`Cookie文件不存在: ${cookieFile}`);
                                }
                            } catch (e) {
                                log(`删除cookie失败: ${e.message}`);
                            }
                        }
                    }
                }
            });

            node.stderr.on('data', (data) => {
                const lines = data.toString().split('\n');
                for (const line of lines) {
                    const msg = line.trim();
                    if (msg) log('[错误] ' + msg);
                }
            });

            node.on('close', (code) => {
                currentProcess = null;
                isDouyinRunning = false;
                // 检查cookie过期标记文件
                const markerFile = 'C:\\Users\\Administrator\\.openclaw\\cookie_expired.txt';
                log(`[DEBUG] 检查标记文件: ${markerFile}, 存在=${fs.existsSync(markerFile)}`);
                if (fs.existsSync(markerFile)) {
                    try {
                        const expiredShop = fs.readFileSync(markerFile, 'utf-8').trim();
                        fs.unlinkSync(markerFile);
                        log(`[DEBUG] 标记文件内容: "${expiredShop}"`);
                        if (expiredShop) {
                            const safeName = expiredShop.replace(/[\\/:*?"<>|]/g, '_');
                            const cookieFile = path.join(COOKIES_DIR, safeName + '.json');
                            if (fs.existsSync(cookieFile)) {
                                fs.unlinkSync(cookieFile);
                                log(`Cookie已过期，自动删除店铺: ${expiredShop}`);
                            } else {
                                log(`[DEBUG] cookie文件不存在: ${cookieFile}`);
                            }
                        }
                    } catch (e) { log(`[DEBUG] 标记文件处理异常: ${e.message}`); }
                }
                log('=== 抖店商品信息获取结束 ===');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: code === 0,
                    message: code === 0 ? '完成' : '失败'
                }));
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
        if (fs.existsSync(LOG_FILE)) { fs.writeFileSync(LOG_FILE, ''); }
        // 清理旧的cookie过期标记
        const markerFile2 = 'C:\\Users\\Administrator\\.openclaw\\cookie_expired.txt';
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
            log(`=== 开始多次获取抖店商品信息 (目标${targetCount}个, 间隔${intervalMinutes}分钟) [${shopName}] ===`);

            // 将店铺名写入临时文件（避免编码问题）
            const shopNameFile = 'C:\\Users\\Administrator\\.openclaw\\current_shop.txt';
            fs.writeFileSync(shopNameFile, shopName);

            // 将费用配置写入临时文件
            const feeConfigFile = 'C:\\Users\\Administrator\\.openclaw\\fee_config.json';
            fs.writeFileSync(feeConfigFile, JSON.stringify({ shippingFee, insurance }));

            const douyinScript = 'C:\\Users\\Administrator\\douyin-shop-analyzer.js';
            const node = spawn('node', [douyinScript, targetCount.toString(), intervalMinutes.toString(), 'multi'], {
                shell: true,
                cwd: 'C:\\Users\\Administrator'
            });
            currentProcess = node;

            node.stdout.on('data', (data) => {
                const raw = data.toString();
                const lines = raw.split('\n');
                for (const line of lines) {
                    const msg = line.trim();
                    if (!msg) continue;
                    log(msg);
                    if (msg.indexOf('COOKIE_EXPIRED:') !== -1) {
                        const idx = msg.indexOf('COOKIE_EXPIRED:');
                        const expiredShop = msg.substring(idx + 'COOKIE_EXPIRED:'.length).trim();
                        log(`[DEBUG] 检测到过期信号, 店铺=${expiredShop}`);
                        if (expiredShop) {
                            const safeName = expiredShop.replace(/[\\/:*?"<>|]/g, '_');
                            const cookieFile = path.join(COOKIES_DIR, safeName + '.json');
                            try {
                                if (fs.existsSync(cookieFile)) {
                                    fs.unlinkSync(cookieFile);
                                    log(`Cookie已过期，自动删除店铺: ${expiredShop}`);
                                }
                            } catch (e) {
                                log(`删除cookie失败: ${e.message}`);
                            }
                        }
                    }
                }
            });

            node.stderr.on('data', (data) => {
                const lines = data.toString().split('\n');
                for (const line of lines) {
                    const msg = line.trim();
                    if (msg) log('[错误] ' + msg);
                }
            });

            node.on('close', (code) => {
                currentProcess = null;
                isDouyinMultiRunning = false;
                // 检查cookie过期标记文件
                const markerFile = 'C:\\Users\\Administrator\\.openclaw\\cookie_expired.txt';
                if (fs.existsSync(markerFile)) {
                    try {
                        const expiredShop = fs.readFileSync(markerFile, 'utf-8').trim();
                        fs.unlinkSync(markerFile);
                        if (expiredShop) {
                            const safeName = expiredShop.replace(/[\\/:*?"<>|]/g, '_');
                            const cookieFile = path.join(COOKIES_DIR, safeName + '.json');
                            if (fs.existsSync(cookieFile)) {
                                fs.unlinkSync(cookieFile);
                                log(`Cookie已过期，自动删除店铺: ${expiredShop}`);
                            }
                        }
                    } catch (e) {}
                }
                log('=== 抖店商品信息多次执行结束 ===');
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
        if (fs.existsSync(LOG_FILE)) { fs.writeFileSync(LOG_FILE, ''); }
        log('=== 开始登录新店铺 ===');

        const loginScript = path.join(WORKSPACE, 'login-shop.js');
        const node = spawn('node', [loginScript], {
            shell: true,
            cwd: WORKSPACE
        });

        let shopName = '';
        node.stdout.on('data', (data) => {
            const msg = data.toString().trim();
            if (msg) {
                log(msg);
                if (msg.startsWith('SHOP_NAME:')) {
                    shopName = msg.replace('SHOP_NAME:', '');
                }
            }
        });

        node.stderr.on('data', (data) => {
            const msg = data.toString().trim();
            if (msg) log('[错误] ' + msg);
        });

        node.on('close', (code) => {
            log('=== 登录新店铺结束 ===');
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

    // 获取日志
    if (req.url === '/get-logs' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ logs: getLogs() }));
        return;
    }

    // 404
    res.writeHead(404);
    res.end('Not Found');
});


server.listen(PORT, () => {
    log(`票据管理服务已启动: http://localhost:${PORT}`);
});