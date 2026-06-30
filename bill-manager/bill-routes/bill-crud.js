const Database = require('better-sqlite3');
const path = require('path');
const { verifyToken } = require('./auth');

const DB_PATH = path.join(__dirname, '..', 'bill-db', 'bills.db');
function getDb() { return new Database(DB_PATH); }

function save(body, authHeader) {
  const user = verifyToken(authHeader);
  if (!user) return { error: '未登录' };

  const db = getDb();
  try {
    const r = db.prepare(`INSERT INTO bills_1号
      (单据内容,单据截图,单据打印时间,开单日期,记录时间,是否错误,批次号,
       档口名称,上次结余,累计结余,付款金额,拿货件数,退货件数,客户,地址,created_by,status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      body.单据内容 || '', body.单据截图 || '', body.单据打印时间 || Date.now(),
      body.开单日期 ? new Date(body.开单日期).getTime() : Date.now(), Date.now(),
      body.是否错误 || '', body.批次号 || '', body.档口名称 || '',
      body.上次结余 || null, body.累计结余 || null, body.付款金额 || null,
      body.拿货件数 || null, body.退货件数 || null,
      body.客户 || user.customer_name || '', body.地址 || '', user.phone, 'confirmed'
    );
    return { success: true, id: r.lastInsertRowid };
  } finally { db.close(); }
}

function list(query, authHeader) {
  const user = verifyToken(authHeader);
  if (!user) return { error: '未登录' };

  const db = getDb();
  try {
    let sql = 'SELECT * FROM bills_1号 WHERE 1=1';
    const params = [];

    if (query.档口名称) { sql += ' AND 档口名称 = ?'; params.push(query.档口名称); }
    if (query.dateFrom) { sql += ' AND 开单日期 >= ?'; params.push(new Date(query.dateFrom).getTime()); }
    if (query.dateTo) { sql += ' AND 开单日期 <= ?'; params.push(new Date(query.dateTo).getTime() + 86400000); }
    if (query.created_by) { sql += ' AND created_by = ?'; params.push(query.created_by); }

    sql += ' ORDER BY created_at DESC LIMIT 200';
    return { bills: db.prepare(sql).all(...params) };
  } finally { db.close(); }
}

function update(id, body, authHeader) {
  const user = verifyToken(authHeader);
  if (!user) return { error: '未登录' };

  const db = getDb();
  try {
    const fields = ['档口名称', '开单日期', '付款金额', '拿货件数', '退货件数', '上次结余', '累计结余', '客户', '地址', '是否错误', '批次号'];
    const sets = [];
    const vals = [];
    for (const f of fields) {
      if (body[f] !== undefined) {
        sets.push(`${f} = ?`);
        vals.push(body[f]);
      }
    }
    if (sets.length === 0) return { error: '无更新字段' };
    vals.push(id);
    db.prepare(`UPDATE bills_1号 SET ${sets.join(',')} WHERE id = ?`).run(...vals);
    return { success: true };
  } finally { db.close(); }
}

function getShopNames(authHeader) {
  const user = verifyToken(authHeader);
  if (!user) return { error: '未登录' };

  const db = getDb();
  try {
    const rows = db.prepare("SELECT DISTINCT 档口名称 FROM bills_1号 WHERE 档口名称 != '' ORDER BY 档口名称").all();
    return { shops: rows.map(r => r.档口名称) };
  } finally { db.close(); }
}

module.exports = { save, list, update, getShopNames };
