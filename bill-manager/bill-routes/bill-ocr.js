const fs = require('fs');
const https = require('https');

const ARK_MODEL = 'doubao-1.5-vision-pro-32k-250115';

function getApiKey() {
  return process.env.ARK_API_KEY || '44e38313-658a-4245-986f-e45f9bc66fff';
}

async function ocrImage(imagePath) {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('未配置 ARK_API_KEY 环境变量');

  const imageData = fs.readFileSync(imagePath);
  const base64 = imageData.toString('base64');
  const ext = imagePath.split('.').pop().toLowerCase();
  const mime = ext === 'png' ? 'image/png' : 'image/jpeg';

  const payload = JSON.stringify({
    model: ARK_MODEL,
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } },
        { type: 'text', text: '请识别这张票据图片中的所有文字内容，按原格式输出。特别注意：档口名称、日期、金额、件数、结余、批次号等关键信息。' }
      ]
    }],
    max_tokens: 2000
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'ark.cn-beijing.volces.com',
      path: '/api/v3/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.choices && json.choices[0]) {
            resolve(json.choices[0].message.content);
          } else {
            reject(new Error('OCR返回格式异常: ' + data.slice(0, 200)));
          }
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function parseOcrText(text) {
  // 预处理：去掉 markdown 加粗标记
  text = text.replace(/\*\*/g, '');
  const result = {
    raw_text: text,
    档口名称: '',
    开单日期: '',
    付款金额: null,
    拿货件数: null,
    退货件数: null,
    上次结余: null,
    累计结余: null,
    客户: '',
    地址: '',
    批次号: '',
    是否错误: '',
    单据性质: ''
  };

  // ========== 优先尝试解析 Markdown 表格 ==========
  const tableParsed = parseMarkdownTable(text, result);

  // ========== 如果表格解析未覆盖的字段，用正则回退补充 ==========
  if (!result.批次号) {
    const batchMatch = text.match(/批次(?:[（(]?单号[）)]?)?\s*[:：]\s*(\d+)/);
    if (batchMatch) result.批次号 = batchMatch[1];
    // 兼容班次
    if (!result.批次号) {
      const batchMatch2 = text.match(/班次\s*[:：]\s*(\S+)/);
      if (batchMatch2) result.批次号 = batchMatch2[1].trim();
    }
  }

  if (!result.开单日期) {
    const dateMatch = text.match(/(\d{4})[年\-\/](\d{1,2})[月\-\/](\d{1,2})/);
    if (dateMatch) result.开单日期 = `${dateMatch[1]}-${dateMatch[2].padStart(2,'0')}-${dateMatch[3].padStart(2,'0')}`;
  }

  if (!result.客户) {
    const customerMatch = text.match(/客户\s*[:：]\s*(.+)/);
    if (customerMatch) result.客户 = customerMatch[1].trim();
  }

  if (!result.地址) {
    const addressMatch = text.match(/(?:客户)?地址\s*[:：]\s*(.+)/);
    if (addressMatch) result.地址 = addressMatch[1].trim();
  }

  if (result.上次结余 === null) {
    const prevBalanceMatch = text.match(/上次(?:结余|欠款|余|余额)\s*[:：]\s*[-]?\s*(\d+\.?\d*)/);
    if (prevBalanceMatch) result.上次结余 = parseFloat(prevBalanceMatch[1]);
  }

  if (result.累计结余 === null) {
    const cumBalanceMatch = text.match(/累计(?:结余|欠款|余|余额)\s*[:：]\s*[-]?\s*(\d+\.?\d*)/);
    if (cumBalanceMatch) result.累计结余 = parseFloat(cumBalanceMatch[1]);
  }

  if (result.付款金额 === null) {
    const returnTotalMatch = text.match(/(?:退货|总额)\s*[:：]\s*[-]?\s*(\d+\.?\d*)/);
    const salesTotalMatch = text.match(/(?:销售|收款)总额\s*[:：]\s*(\d+\.?\d*)/);
    if (salesTotalMatch) result.付款金额 = parseFloat(salesTotalMatch[1]);
    else if (returnTotalMatch) result.付款金额 = parseFloat(returnTotalMatch[1]);
  }

  if (result.拿货件数 === null) {
    const salesQtyMatch = text.match(/(?:销售数量|拿货数量|销数)\s*[:：]\s*(\d+)/);
    if (salesQtyMatch) result.拿货件数 = parseInt(salesQtyMatch[1]);
  }

  if (result.退货件数 === null) {
    const returnQtyMatch = text.match(/(?:退货数量|退数)\s*[:：]\s*[-]?\s*(\d+)/);
    if (returnQtyMatch) result.退货件数 = parseInt(returnQtyMatch[1]);
  }

  // 判断单据性质（始终从全文判断）
  if (text.includes('退货单') || text.includes('退货')) result.单据性质 = '退货';
  else if (text.includes('销售单') || text.includes('销售')) result.单据性质 = '销售';
  else if (text.includes('收款单') || text.includes('收款')) result.单据性质 = '收款';

  return result;
}

/**
 * 解析 Markdown 表格格式的 OCR 文本
 * 格式示例：
 * |类别|详情|
 * |--|--|
 * |档口名称|李小姐销售|
 * |日期|2026 - 06 - 23|
 */
function parseMarkdownTable(text, result) {
  // 检测是否包含 Markdown 表格（至少有两行以 | 开头）
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.startsWith('|'));
  if (lines.length < 2) return false;

  // 字段名 → 结果字段的映射表
  const fieldMap = {
    '档口名称': '档口名称',
    '日期':     '开单日期',
    '开单日期': '开单日期',
    '客户姓名': '客户',
    '客户':     '客户',
    '客户电话': null,  // 暂不存
    '门店电话': null,
    '门店地址': '地址',
    '地址':     '地址',
    '上次结余': '上次结余',
    '累计结余': '累计结余',
    '本单结余': '付款金额',
    '付款金额': '付款金额',
    '退货总额': '付款金额',  // 退货单场景映射到付款金额
    '销售总额': '付款金额',
    '收款总额': '付款金额',
    '销售数量': '拿货件数',
    '拿货数量': '拿货件数',
    '拿货件数': '拿货件数',
    '退货数量': '退货件数',
    '退货件数': '退货件数',
    '批次（单号）': '批次号',
    '批次号':   '批次号',
    '批次':     '批次号',
    '班次':     '批次号',
    '整单备注': null,  // 备注暂不映射
    '单据性质': '单据性质'
  };

  // 辅助：清理值中的多余空格（处理 "2026 - 06 - 23" → "2026-06-23"）
  function cleanValue(val) {
    // 去除前后空格
    val = val.trim();
    // 日期格式修正：将 "2026 - 06 - 23" 转为 "2026-06-23"
    const dateCleaned = val.match(/^(\d{4})\s*-\s*(\d{1,2})\s*-\s*(\d{1,2})$/);
    if (dateCleaned) {
      return `${dateCleaned[1]}-${dateCleaned[2].padStart(2,'0')}-${dateCleaned[3].padStart(2,'0')}`;
    }
    return val;
  }

  let parsedCount = 0;

  for (const line of lines) {
    // 跳过分隔行，如 |--|--|
    if (/^\|[\s\-:]+\|$/.test(line.replace(/\|/g, (m, offset, str) => {
      // 标准化后检测
      return '|';
    }))) {
      // 更准确的分隔行检测
      const cells = line.split('|').filter(c => c !== '');
      if (cells.every(c => /^[\s\-:]+$/.test(c))) continue;
    }

    // 拆分单元格
    const cells = line.split('|').map(c => c.trim()).filter(c => c !== '');
    if (cells.length < 2) continue;

    // 跳过表头行（如 "类别|详情"）
    const key = cells[0];
    const value = cells[1];

    if (!(key in fieldMap)) continue;

    const targetField = fieldMap[key];
    if (targetField === null) continue;  // 明确跳过的字段

    const cleanedValue = cleanValue(value);
    if (!cleanedValue && cleanedValue !== '0') continue;

    // 根据字段类型赋值
    if (['上次结余', '累计结余', '付款金额'].includes(targetField)) {
      const numVal = parseFloat(cleanedValue);
      if (!isNaN(numVal)) {
        result[targetField] = numVal;
        parsedCount++;
      }
    } else if (['拿货件数', '退货件数'].includes(targetField)) {
      const numVal = parseInt(cleanedValue, 10);
      if (!isNaN(numVal)) {
        result[targetField] = numVal;
        parsedCount++;
      }
    } else {
      result[targetField] = cleanedValue;
      parsedCount++;
    }
  }

  return parsedCount > 0;
}

module.exports = { ocrImage, parseOcrText };
