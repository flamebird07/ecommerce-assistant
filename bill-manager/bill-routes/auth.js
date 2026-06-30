const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');

const JWT_SECRET = 'bill-manager-secret-' + os.hostname();
const DB_PATH = path.join(__dirname, '..', 'bill-db', 'bills.db');
function getDb() { return new Database(DB_PATH); }

function register(body) {
  const { phone, password, customer_name, nickname } = body;
  if (!phone || !password) return { error: '手机号和密码必填' };
  if (!/^1\d{10}$/.test(phone)) return { error: '手机号格式不正确' };
  if (password.length < 6) return { error: '密码至少6位' };

  const db = getDb();
  try {
    const existing = db.prepare('SELECT phone FROM users WHERE phone = ?').get(phone);
    if (existing) return { error: '该手机号已注册' };

    const hash = bcrypt.hashSync(password, 10);
    db.prepare('INSERT INTO users (phone, password_hash, customer_name, nickname) VALUES (?, ?, ?, ?)')
      .run(phone, hash, customer_name || '', nickname || '');
    return { success: true, message: '注册成功' };
  } finally { db.close(); }
}

function login(body) {
  const { phone, password } = body;
  if (!phone || !password) return { error: '手机号和密码必填' };

  const db = getDb();
  try {
    const user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
    if (!user) return { error: '用户不存在' };
    if (!bcrypt.compareSync(password, user.password_hash)) return { error: '密码错误' };

    const token = jwt.sign({ phone: user.phone }, JWT_SECRET, { expiresIn: '7d' });
    return {
      token,
      user: { phone: user.phone, customer_name: user.customer_name, nickname: user.nickname }
    };
  } finally { db.close(); }
}

function verifyToken(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  try {
    const decoded = jwt.verify(authHeader.slice(7), JWT_SECRET);
    const db = getDb();
    try {
      const u = db.prepare('SELECT phone, customer_name, nickname FROM users WHERE phone = ?').get(decoded.phone);
      return u || null;
    } finally { db.close(); }
  } catch { return null; }
}

function me(authHeader) {
  const user = verifyToken(authHeader);
  return user ? { user } : { error: '未登录' };
}

module.exports = { register, login, me, verifyToken };
