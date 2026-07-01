#!/usr/bin/env python3
"""bill_image.py - 扫描目录处理图片票据 + 飞书录入
用法: python bill_image.py [目录路径] [record_time]
不传参数时扫描: C:\\Users\\Administrator\\Desktop\\票据视频\\
支持: .jpg .jpeg .png .bmp .gif .webp
"""
import os, sys, json, time, base64, re

# 禁用所有警告
os.environ['PYTHONWARNINGS'] = 'ignore'
import warnings
warnings.filterwarnings('ignore')

sys.stdout.reconfigure(encoding='utf-8', errors='replace')
# 不使用TextIOWrapper，它会覆盖-u的无缓冲设置，导致日志不能实时输出

import requests, subprocess
import sqlite3
DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'bill-db', 'bills.db')
FEISHU_APP_ID = 'cli_a91ad5ae63385bc9'
FEISHU_APP_SECRET = 'ga7Gn6pBJgUkftKY2JEpFe3TJFpB2Mun'
FEISHU_APP_TOKEN = 'CfAXbSrUFaBLv3stSRrcuUVon1b'
FEISHU_TABLE_ID = 'tblua6KaZ6PiWAp6'

API_KEY = "44e38313-658a-4245-986f-e45f9bc66fff"
ARK_BASE_URL = "https://ark.cn-beijing.volces.com/api/v1/chat/completions"
ARK_MODEL = "doubao-seed-1-8-251228"
VIDEO_DIR = r"C:\Users\Administrator\Desktop\票据视频"
WRITE_FINAL_JS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "write_final.js")

IMAGE_EXTS = {'.jpg', '.jpeg', '.png', '.bmp', '.gif', '.webp'}

def ocr_image(image_path, timeout=120):
    with open(image_path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode()
    payload = {"model": ARK_MODEL, "messages": [{"role": "user", "content": [
        {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}},
        {"type": "text", "text": "请提取图中所有文字，包含单号、日期、金额，商品明细等完整信息。"}
    ]}], "max_tokens": 1024}
    headers = {"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"}
    resp = requests.post(ARK_BASE_URL, headers=headers, json=payload, timeout=timeout)
    if resp.status_code == 200:
        raw_bytes = resp.content
        for enc in ("utf-8", "gbk", "gb2312", "latin-1"):
            try:
                text_str = raw_bytes.decode(enc)
                r = json.loads(text_str)
                break
            except Exception:
                continue
        else:
            text_str = raw_bytes.decode("utf-8", errors="replace")
            r = {"choices": [{"message": {"content": text_str}}]}
        return str(r["choices"][0]["message"]["content"]).strip()
    return ""

def is_bill_text(text):
    if not text or len(text.strip()) < 15: return False
    t = text.lower()
    # 排除明显不是票据的图片
    if any(k in t for k in ['no visible', 'cannot be identified', 'no readable', 'qr code', 'scannable qr', '支付成功', '无法提取']): return False
    bill_types = ['销售单', '退货单', '收据', '发票', '清单', '明细', '销售退货单', '销售单据', '单据', '收款单']
    has_bill_type = any(bt in t for bt in bill_types)
    has_amount = any(k in t for k in ['总额', '总价', '合计', '实付', '金额', '单价', '小计'])
    return has_bill_type or (('单' in t or '联' in t) and has_amount)

def sync_to_sqlite(fields):
    """把write_final.js的解析结果写入SQLite（同一份数据，不从飞书拷贝）"""
    try:
        if not os.path.exists(DB_PATH):
            return
        def gt(val):
            if isinstance(val, list) and val: return val[0].get('text','')
            return str(val) if val else ''
        conn = sqlite3.connect(DB_PATH)
        cur = conn.cursor()
        cur.execute('''INSERT INTO bills_1号
            (单据内容,单据截图,单据打印时间,开单日期,记录时间,批次号,
             档口名称,上次结余,累计结余,付款金额,拿货件数,退货件数,
             客户,地址,是否错误,单据性质,created_by,status)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',
            (gt(fields.get('单据内容','')), gt(fields.get('单据截图','')),
             fields.get('单据打印时间'), fields.get('开单日期'),
             fields.get('记录时间'), gt(fields.get('批次号','')),
             gt(fields.get('档口名称','')), fields.get('上次结余'),
             fields.get('累计结余'), fields.get('付款金额'),
             fields.get('拿货件数'), fields.get('退货件数'),
             gt(fields.get('客户','')), gt(fields.get('地址','')),
             gt(fields.get('是否错误','')), gt(fields.get('单据性质','')),
             gt(fields.get('created_by','')) or '18973384605', 'confirmed'))
        conn.commit()
        conn.close()
    except Exception as e:
        print(f"  [SQLite同步失败] {e}", file=sys.stderr)

def process_image(img_path, record_time, seq_no, total=1, current=1, created_by=''):
    print(f"[IMG] {os.path.basename(img_path)}")
    text = ocr_image(img_path)
    if not text:
        print(f"  OCR失败"); return None
    if not is_bill_text(text):
        print(f"  非票据，跳过: {os.path.basename(img_path)}")
        return None

    result = {"bills": [{"ocr_text": text, "screenshot": img_path, "timestamp": int(time.time()*1000),
        "segment_id": 1, "rank": 0}],
        "stats": {"total":1,"new":1,"dup":0,"no_batch": 0,"blur":0,"no_text":0}}

    tmp_json = os.path.join(os.environ['TEMP'], f"bill_img_{int(time.time()*1000)}.json")
    with open(tmp_json, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    # 捕获stdout以提取__BILL_FIELDS__，stderr直接显示
    r = subprocess.run(['node', WRITE_FINAL_JS, tmp_json,
        'CfAXbSrUFaBLv3stSRrcuUVon1b', 'tblua6KaZ6PiWAp6',
        record_time, img_path, seq_no, str(total), str(current), created_by],
        text=True, encoding='utf-8', errors='replace',
        stdout=subprocess.PIPE)
    os.remove(tmp_json)

    # 输出write_final.js的日志（过滤掉__BILL_FIELDS__行）
    bill_fields = None
    if r.stdout:
        for line in r.stdout.split('\n'):
            if line.startswith('__BILL_FIELDS__'):
                try:
                    bill_fields = json.loads(line[len('__BILL_FIELDS__'):])
                except:
                    pass
            else:
                if line.strip():
                    print(line)

    # 判断：检查返回码
    ok = r.returncode == 0
    if ok:
        print(f"  ✅ 录入成功")
        # 直接用write_final.js的解析结果写入SQLite（同一份数据）
        if bill_fields:
            try:
                sync_to_sqlite(bill_fields)
                print(f"  ✅ SQLite同步成功")
            except Exception as e:
                print(f"  ⚠ SQLite同步失败: {e}", file=sys.stderr)
        else:
            print(f"  ⚠ 未获取到解析结果，跳过SQLite同步")
    else:
        print(f"  ⚠️ 录入失败 (code={r.returncode})")
    return bill_fields if ok else None

def main():
    # 单张模式：python bill_image.py --single /path/to/image.jpg [record_time] [user_phone]
    if len(sys.argv) > 1 and sys.argv[1] == '--single':
        img_path = sys.argv[2] if len(sys.argv) > 2 else ''
        record_time = sys.argv[3] if len(sys.argv) > 3 else str(int(time.time()*1000))
        user_phone = sys.argv[4] if len(sys.argv) > 4 else ''
        if not img_path or not os.path.isfile(img_path):
            print(json.dumps({"success": False, "error": f"文件不存在: {img_path}"}))
            sys.exit(1)
        # 输出调试信息到stderr，JSON到stdout
        print(f"[SINGLE] {os.path.basename(img_path)}", file=sys.stderr)
        bill_fields = process_image(img_path, record_time, '001', 1, 1, user_phone)
        if bill_fields:
            # 直接用 __BILL_FIELDS__ 的解析结果，不再重新OCR和查飞书
            def gt(val):
                if isinstance(val, list) and val: return val[0].get('text','')
                return val if val else ''
            result = {"success": True,
                "shop_name": gt(bill_fields.get('档口名称','')),
                "batch": gt(bill_fields.get('批次号','')),
                "bill_date": bill_fields.get('开单日期',''),
                "customer": gt(bill_fields.get('客户','')),
                "address": gt(bill_fields.get('地址','')),
                "prev_balance": bill_fields.get('上次结余'),
                "cum_balance": bill_fields.get('累计结余'),
                "payment": bill_fields.get('付款金额'),
                "sales_qty": bill_fields.get('拿货件数'),
                "return_qty": bill_fields.get('退货件数'),
                "bill_type": gt(bill_fields.get('单据性质','')),
                "raw_text": gt(bill_fields.get('单据内容',''))}
            print(json.dumps(result, ensure_ascii=False, default=str))
        else:
            print(json.dumps({"success": False, "error": "处理失败"}))
            sys.exit(1)
        return

    target_dir = sys.argv[1] if len(sys.argv) > 1 else VIDEO_DIR
    # 第四参数改为时间戳(毫秒)
    record_time_ms = sys.argv[2] if len(sys.argv) > 2 else str(int(time.time()*1000))
    seq_no = sys.argv[3] if len(sys.argv) > 3 else "001"
    # 老界面批量录入默认 created_by
    default_created_by = sys.argv[4] if len(sys.argv) > 4 else '18973384605'

    print(f"[SCAN] {target_dir}")
    files = []
    for f in os.listdir(target_dir):
        # 跳过已录入的图片
        if f.startswith('已录入_'):
            continue
        ext = os.path.splitext(f)[1].lower()
        if ext in IMAGE_EXTS:
            files.append(os.path.join(target_dir, f))
    print(f"[FOUND] {len(files)} 张图片")
    if not files:
        print("[DONE] 无图片可处理")
        return

    total = len(files)
    for i, img_path in enumerate(files):
        seq = f"{i+1:03d}"
        print(f"\n[{i+1}/{total}] 处理: {os.path.basename(img_path)}")
        ok = process_image(img_path, record_time_ms, seq, total, i+1, default_created_by)

    print(f"[DONE] 全部完成")

if __name__ == "__main__":
    main()
