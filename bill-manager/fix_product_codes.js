/**
 * 修复4号表格中包含中文字符的款号
 */
const https = require('https');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const WORKSPACE = __dirname;
const APP_TOKEN = 'CfAXbSrUFaBLv3stSRrcuUVon1b';
const TBL4 = 'tblpEOUDXbdCMPPH';
const APP_ID = 'cli_a91ad5ae63385bc9';
const APP_SECRET = 'ga7Gn6pBJgUkftKY2JEpFe3TJFpB2Mun';

// 获取拼音缩写
function getPinyinInitials(name) {
  try {
    const tmp = path.join(WORKSPACE, '_pinyin_input.txt');
    fs.writeFileSync(tmp, name, 'utf-8');
    const result = execSync(`python -W ignore -c "import sys; sys.path.insert(0, r'${WORKSPACE}'); from bill_check import get_pinyin_initials; t=open(r'${tmp}',encoding='utf-8').read(); print(get_pinyin_initials(t),end='')"`, { encoding: 'utf-8', timeout: 5000 }).trim();
    try { fs.unlinkSync(tmp); } catch {}
    return result || name.substring(0, 2);
  } catch {
    return name.substring(0, 2);
  }
}

// 获取token
async function getToken() {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET });
    const req = https.request({
      hostname: 'open.feishu.cn',
      path: '/open-apis/auth/v3/tenant_access_token/internal',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve(JSON.parse(body).tenant_access_token));
    });
    req.write(data);
    req.end();
  });
}

// 读取所有记录
async function listAllRecords(token) {
  const records = [];
  let pt = '';
  do {
    const url = `/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${TBL4}/records?page_size=100` + (pt ? `&page_token=${pt}` : '');
    const result = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'open.feishu.cn',
        path: url,
        method: 'GET',
        headers: { 'Authorization': 'Bearer ' + token }
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => resolve(JSON.parse(body)));
      });
      req.end();
    });
    if (result.data && result.data.items) records.push(...result.data.items);
    pt = result.data?.page_token || '';
  } while (pt);
  return records;
}

// 更新记录
async function updateRecord(token, recordId, fields) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ fields });
    const req = https.request({
      hostname: 'open.feishu.cn',
      path: `/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${TBL4}/records/${recordId}`,
      method: 'PUT',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json'
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve(JSON.parse(body)));
    });
    req.write(data);
    req.end();
  });
}

// 主函数
async function main() {
  console.log('获取token...');
  const token = await getToken();

  console.log('读取4号表格...');
  const records = await listAllRecords(token);
  console.log(`共 ${records.length} 条记录`);

  // 找出有问题的款号（包含中文字符）
  const badRecords = records.filter(r => {
    const code = (r.fields['款号'] || '').trim();
    return /[一-鿿]/.test(code);
  });

  console.log(`找到 ${badRecords.length} 条需要修复的记录`);

  let fixed = 0;
  for (const r of badRecords) {
    const oldCode = r.fields['款号'].trim();
    const shopName = r.fields['档口'] || '';
    const shopAbbr = getPinyinInitials(shopName);

    // 清理款号：去掉中文字符，保留数字和字母
    let newCode = oldCode.replace(/[一-鿿]+/g, '');
    // 去掉末尾的符号（-、/、_等）
    newCode = newCode.replace(/[-\/_]+$/, '');
    // 如果款号不以缩写开头，加上缩写
    if (shopAbbr && !newCode.startsWith(shopAbbr)) {
      // 检查是否有其他店铺的缩写前缀，如果有则替换
      const otherPrefixes = ['SZTC', 'YDD', 'ASYG', 'PPT', 'XLFE', 'WXE', 'XFS', 'GZKK', 'XWYDL', 'LXJ', 'XW', 'ZL', 'SWKJ', 'YMR', 'XMY', 'SDBR', 'HBJJ', 'YXY', 'JXG', 'XYM', 'XYGCD', 'JQM', 'XNF', 'AB', 'MYS', 'TYTS'];
      for (const prefix of otherPrefixes) {
        if (newCode.startsWith(prefix) && prefix !== shopAbbr) {
          newCode = newCode.substring(prefix.length);
          break;
        }
      }
      newCode = shopAbbr + newCode;
    }

    console.log(`修复: ${oldCode} -> ${newCode} (${shopName})`);

    const result = await updateRecord(token, r.id, { '款号': newCode });
    if (result.code === 0) {
      fixed++;
      console.log('  -> 成功');
    } else {
      console.log('  -> 失败:', result.msg);
    }

    // 限速
    await new Promise(r => setTimeout(r, 100));
  }

  console.log(`\n修复完成，共修复 ${fixed} 条`);
}

main().catch(console.error);
