const fs = require('fs');
const https = require('https');

const ARK_MODEL = 'doubao-1.5-vision-pro-32k-250115';

function getApiKey() {
  return process.env.ARK_API_KEY || '';
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

  // 提取批次号
  const batchMatch = text.match(/批次[（(]?单号[）)]?\s*[:：]\s*(\d+)/);
  if (batchMatch) result.批次号 = batchMatch[1];

  // 提取日期
  const dateMatch = text.match(/(\d{4})[年\-\/](\d{1,2})[月\-\/](\d{1,2})/);
  if (dateMatch) result.开单日期 = `${dateMatch[1]}-${dateMatch[2].padStart(2,'0')}-${dateMatch[3].padStart(2,'0')}`;

  // 提取客户
  const customerMatch = text.match(/客户\s*[:：]\s*(.+)/);
  if (customerMatch) result.客户 = customerMatch[1].trim();

  // 提取地址
  const addressMatch = text.match(/(?:客户)?地址\s*[:：]\s*(.+)/);
  if (addressMatch) result.地址 = addressMatch[1].trim();

  // 提取上次结余
  const prevBalanceMatch = text.match(/上次结余\s*[:：]\s*[-]?\s*(\d+\.?\d*)/);
  if (prevBalanceMatch) result.上次结余 = parseFloat(prevBalanceMatch[1]);

  // 提取累计结余
  const cumBalanceMatch = text.match(/累计结余\s*[:：]\s*[-]?\s*(\d+\.?\d*)/);
  if (cumBalanceMatch) result.累计结余 = parseFloat(cumBalanceMatch[1]);

  // 提取付款金额
  const returnTotalMatch = text.match(/退货总额\s*[:：]\s*[-]?\s*(\d+\.?\d*)/);
  const salesTotalMatch = text.match(/(?:销售|收款)总额\s*[:：]\s*(\d+\.?\d*)/);
  if (salesTotalMatch) result.付款金额 = parseFloat(salesTotalMatch[1]);
  else if (returnTotalMatch) result.付款金额 = parseFloat(returnTotalMatch[1]);

  // 提取拿货件数
  const salesQtyMatch = text.match(/(?:销售|拿货)数量\s*[:：]\s*(\d+)/);
  if (salesQtyMatch) result.拿货件数 = parseInt(salesQtyMatch[1]);

  // 提取退货件数
  const returnQtyMatch = text.match(/退货数量\s*[:：]\s*[-]?\s*(\d+)/);
  if (returnQtyMatch) result.退货件数 = parseInt(returnQtyMatch[1]);

  // 判断单据性质
  if (text.includes('退货单') || text.includes('退货')) result.单据性质 = '退货';
  else if (text.includes('销售单') || text.includes('销售')) result.单据性质 = '销售';
  else if (text.includes('收款单') || text.includes('收款')) result.单据性质 = '收款';

  return result;
}

module.exports = { ocrImage, parseOcrText };
