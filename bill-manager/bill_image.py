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

def parse_batch(text):
    # 先尝试批次（行首或换行后，兼容"- "前缀），再尝试小票/单号
    m = re.search(r'(?:^|\n)\s*(?:[-*]\s*)?(?:批次|班次|小票|单号)[:：]\s*(\S+)', text)
    b = ''
    if m:
        b = re.sub(r'^[^0-9A-Za-z]+', '', m.group(1)).strip().rstrip('.,;:!?。；：！？')
        if re.match(r'^[0-9A-Za-z]{3,20}$', b):
            pass
        else:
            b = ''
    # 兼容订单编号
    if not b:
        m = re.search(r'订单编号[:：]\s*(\S+)', text)
        if m: b = re.sub(r'^[^0-9A-Za-z]+', '', m.group(1)).strip().rstrip('.,;:!?。；：！？')
    if not b:
        for line in text.split('\n'):
            if any(k in line for k in ['总额','单价','小计','合计','本单','上次','累计','销数','退数','余额','电话','地址','账号','卡号','微信','支付宝','农行','中行','建行','邮政']): continue
            m2 = re.search(r'(?<![0-9A-Za-z])([0-9]{4,8})(?![0-9A-Za-z])', line)
            if m2: b = m2.group(1); break
    # 批次号低于5位时补日期
    if b and len(b) < 5:
        b = b + '-' + time.strftime('%m%d')
    return b or ''

def parse_shop_name(text):
    result = None
    for line in text.split('\n'):
        s = line.strip().replace('客户联','').replace('存根联','').strip()
        s = re.sub(r'^```[a-zA-Z]*', '', s).strip()  # 去掉 Markdown 代码块前缀
        s = re.sub(r'^#+\s*', '', s).strip()  # 去掉 Markdown 标题前缀
        if not s or s=='```' or s in ('销售明细','销售/退货明细','销售单','退货单','销售退货单'): continue
        # 跳过UI元素和无关行
        if re.match(r'^[<🔔]', s): continue
        if re.search(r'小票详情|切换样式|开通线上|一键邀请|复制$', s): continue
        if re.match(r'^\d{11}$', s): continue  # 纯手机号
        # 尝试匹配【档口名】格式
        m = re.match(r'^(?:【|【|\[)([^】\]]+)(?:】|】|\])', s)
        if m:
            n = m.group(1)
            idx = n.find('号')
            n = n[:idx] if idx > 0 else n
            n = re.sub(r'(欧洲城店|欧洲城|国际面料城|万象汇|万象会|世贸|万达|广场|商城|合泰轻纺城|和泰轻纺城)\s*$', '', n)
            n = re.sub(r'(女裤|裤业|时尚女装)\s*$', '', n)
            if n.strip():
                result = n.strip()
                break
        # 尝试匹配"档口名 销售单"格式 - 第一步去掉销售单，第二步去掉地址（欧洲城等）
        m2 = re.match(r'^(.+?)\s*(?:销售退货单|退货单|销售单|收款单)\s*$', s)
        if m2:
            n = m2.group(1).replace('服饰厂','').strip()
            # 第二步去掉地址后缀（欧洲城店、欧洲城、国际面料城、万象汇、万象会、世贸、万达、广场、商城）
            n = re.sub(r'(欧洲城店|欧洲城|国际面料城|万象汇|万象会|世贸|万达|广场|商城|合泰轻纺城|和泰轻纺城)', '', n)
            n = re.sub(r'(女裤|裤业|时尚女装)\s*$', '', n)
            # 去掉楼层房号（如2楼043、富一楼A28号）
            n = re.sub(r'(?:富|负)?[一二三四五六七八九十\d]+楼-?[a-zA-Z]?\d*(?:号(?=[^0-9A-Za-z]|$))?', '', n).strip()
            if n.strip():
                result = n.strip()
                break
    # 如果上面都没匹配到，尝试取第一行作为店名（去掉数字后缀）
    if result is None:
        lines = text.split('\n')
        for line in lines:
            s = line.strip().replace('客户联','').replace('存根联','').strip()
            s = re.sub(r'^```[a-zA-Z]*', '', s).strip()
            s = re.sub(r'^#+\s*', '', s).strip()  # 去掉 Markdown 标题前缀
            s = re.sub(r'[（()）【】\[\]]+', '', s)  # 去掉括号
            s = re.sub(r'\s*(?:销售退货单|退货单|销售单|收款单)\s*$', '', s).strip()  # 去掉销售单后缀
            s = re.sub(r'\s*(?:客户联|存根联)\s*$', '', s).strip()
            s = re.sub(r'\s*(?:销售退货单|退货单|销售单|收款单)\s*$', '', s).strip()  # 客户联去掉后再清一次
            if s and len(s) >= 2:
                n = re.sub(r'(欧洲城店|欧洲城|国际面料城|万象汇|万象会|世贸|万达|广场|商城|合泰轻纺城|和泰轻纺城)', '', s)
                n = re.sub(r'(女裤|裤业|时尚女装)\s*$', '', n)
                n = re.sub(r'(?:富|负)?[一二三四五六七八九十\d]+楼-?[a-zA-Z]?\d*(?:号(?=[^0-9A-Za-z]|$))?', '', n).strip()
                if n:
                    result = n
                    break
    # 特例：婉星 -> 婉星儿（所有路径统一处理）
    if result == '婉星':
        result = '婉星儿'
    # 特例：梦莎娜熙恒 -> 梦莎娜
    if result == '梦莎娜熙恒':
        result = '梦莎娜'
    # 特例：喜梦露 -> 荷传
    if result == '喜梦露':
        result = '荷传'
    # 去掉末尾的城市名后缀（如"株洲市" -> "予檬"）
    result = re.sub(r'^[一-龥]{2,4}市', '', result)
    # 去掉开头的#和空白符号，以及所有【】[]符号和横杠-
    if result:
        result = re.sub(r'^[#\s]+', '', result)
        result = re.sub(r'^[【】\[\]]+', '', result)
        result = re.sub(r'[【】\]]+$', '', result)
        result = result.replace('-', '')
        result = re.sub(r'\s*[./·\-\u2013\u2014\u0300\u0301\u0304\u0306]+\s*', '', result)
        result = re.sub(r'^[^0-9a-zA-Z\u4e00-\u9fa5]*[a-zA-Z]+', '', result)
        if re.search(r'销售单|退货单|销售退货单|收款单|客户联|存根联', result):
            return ''
    return result or ''

def parse_date(text):
    m = re.search(r'(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})', text)
    if m: return {'full': m.group(1), 'date': m.group(1).split(' ')[0]}
    # 兼容 HH:MM（无秒）
    m = re.search(r'(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})', text)
    if m: return {'full': m.group(1), 'date': m.group(1).split(' ')[0]}
    m = re.search(r'(\d{4}-\d{2}-\d{2})', text)
    if m: return {'full': m.group(1), 'date': m.group(1)}
    return None

def process_image(img_path, record_time, seq_no, total=1, current=1):
    print(f"[IMG] {os.path.basename(img_path)}")
    text = ocr_image(img_path)
    if not text:
        print(f"  OCR失败"); return False
    if not is_bill_text(text):
        print(f"  非票据，跳过: {os.path.basename(img_path)}")
        return False

    batch = parse_batch(text)
    shop = parse_shop_name(text)
    parsed = parse_date(text)
    parsed = parse_date(text)
    # 支持带时分秒或不带时分秒的日期
    bill_time_ms = None
    if parsed:
        for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
            try:
                dt = time.strptime(parsed['full'], fmt)
                bill_time_ms = int(time.mktime(dt)*1000)
                break
            except ValueError:
                continue

    print(f"  档口={shop} 批次={batch} 日期={parsed['full'] if parsed else '?'}")

    result = {"bills": [{"ocr_text": text, "screenshot": img_path, "timestamp": int(time.time()*1000),
        "batch_number": batch, "shop": shop, "bill_time": bill_time_ms, "segment_id": 1, "rank": 0}],
        "stats": {"total":1,"new":1,"dup":0,"no_batch": 0 if batch else 1,"blur":0,"no_text":0}}

    tmp_json = os.path.join(os.environ['TEMP'], f"bill_img_{int(time.time()*1000)}.json")
    with open(tmp_json, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    # 实时输出write_final.js的日志（不捕获，直接显示）
    r = subprocess.run(['node', WRITE_FINAL_JS, tmp_json,
        'CfAXbSrUFaBLv3stSRrcuUVon1b', 'tblua6KaZ6PiWAp6',
        record_time, img_path, seq_no, str(total), str(current)],
        text=True, encoding='utf-8', errors='replace')
    os.remove(tmp_json)

    # 判断：检查返回码
    ok = r.returncode == 0
    if ok:
        print(f"  ✅ 录入成功")
    else:
        print(f"  ⚠️ 录入失败 (code={r.returncode})")
    return ok

def main():
    target_dir = sys.argv[1] if len(sys.argv) > 1 else VIDEO_DIR
    # 第四参数改为时间戳(毫秒)
    record_time_ms = sys.argv[2] if len(sys.argv) > 2 else str(int(time.time()*1000))
    seq_no = sys.argv[3] if len(sys.argv) > 3 else "001"

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
        ok = process_image(img_path, record_time_ms, seq, total, i+1)

    print(f"[DONE] 全部完成")

if __name__ == "__main__":
    main()
