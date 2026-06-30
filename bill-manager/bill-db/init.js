const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'bills.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// 1号票据录入（映射飞书 tblua6KaZ6PiWAp6）
db.exec(`CREATE TABLE IF NOT EXISTS bills_1号 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  单据内容 TEXT,
  单据截图 TEXT,
  单据打印时间 INTEGER,
  开单日期 INTEGER,
  记录时间 INTEGER,
  是否错误 TEXT,
  批次号 TEXT,
  档口名称 TEXT,
  上次结余 REAL,
  累计结余 REAL,
  付款金额 REAL,
  拿货件数 INTEGER,
  退货件数 INTEGER,
  客户 TEXT,
  地址 TEXT,
  created_by TEXT DEFAULT '18973384605',
  status TEXT DEFAULT 'draft',
  feishu_record_id TEXT,
  synced_at INTEGER,
  created_at INTEGER DEFAULT (strftime('%s','now')*1000)
)`);

// 2号档口对账（映射飞书 tblWIMl7CwqqAzD4）
db.exec(`CREATE TABLE IF NOT EXISTS reconciliation_2号 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  档口名称 TEXT,
  单据打印时间 INTEGER,
  开单日期 INTEGER,
  批次号 TEXT,
  上次结余 REAL,
  累计结余 REAL,
  付款金额 REAL,
  档口缩写 TEXT,
  记录时间 INTEGER,
  地址 TEXT,
  客户 TEXT,
  单据内容 TEXT,
  单据截图 TEXT,
  备注 TEXT,
  拿货件数 INTEGER,
  退货件数 INTEGER,
  单据性质 TEXT,
  created_by TEXT DEFAULT '18973384605',
  status TEXT DEFAULT 'draft',
  feishu_record_id TEXT,
  synced_at INTEGER,
  created_at INTEGER DEFAULT (strftime('%s','now')*1000)
)`);

// 3号档口余款（映射飞书 tblDCMOWzHqq2VtS）
db.exec(`CREATE TABLE IF NOT EXISTS balance_3号 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  单据内容 TEXT,
  档口名称 TEXT,
  单据打印时间 INTEGER,
  累计结余 REAL,
  地址 TEXT,
  记录时间 INTEGER,
  档口缩写 TEXT,
  备注 TEXT,
  单据截图 TEXT,
  开单日期 INTEGER,
  created_by TEXT DEFAULT '18973384605',
  feishu_record_id TEXT,
  synced_at INTEGER,
  created_at INTEGER DEFAULT (strftime('%s','now')*1000)
)`);

// 4号商品成本（映射飞书 tblpEOUDXbdCMPPH）
db.exec(`CREATE TABLE IF NOT EXISTS costs_4号 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  单据内容 TEXT,
  款号 TEXT,
  档口 TEXT,
  成本 REAL,
  记录时间 TEXT,
  备注 TEXT,
  同款 TEXT,
  单据截图 TEXT,
  商品图片 TEXT,
  尺码 TEXT,
  颜色 TEXT,
  created_by TEXT DEFAULT '18973384605',
  feishu_record_id TEXT,
  synced_at INTEGER,
  created_at INTEGER DEFAULT (strftime('%s','now')*1000)
)`);

// 用户表（仅数据库，不在飞书）
db.exec(`CREATE TABLE IF NOT EXISTS users (
  phone TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  customer_name TEXT,
  nickname TEXT,
  created_at INTEGER DEFAULT (strftime('%s','now')*1000)
)`);

// 插入默认用户
const bcrypt = require('bcryptjs');
const existing = db.prepare('SELECT phone FROM users WHERE phone = ?').get('18973384605');
if (!existing) {
  const hash = bcrypt.hashSync('123456', 10);
  db.prepare('INSERT INTO users (phone, password_hash, customer_name, nickname) VALUES (?, ?, ?, ?)')
    .run('18973384605', hash, '默认客户', '默认用户');
  console.log('已创建默认用户: 18973384605 (密码: 123456)');
} else {
  console.log('默认用户已存在');
}

console.log('数据库初始化完成:', DB_PATH);
db.close();
