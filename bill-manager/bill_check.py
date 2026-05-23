#!/usr/bin/env python3
"""
Video Bill Detection using Doubao Seed Vision Model
Pipeline: Extract frames -> Group by bill completeness -> Select best frame per bill -> OCR -> Deduplicate
"""
import os, sys, json, time, base64, re
os.environ["PYTHONIOENCODING"] = "utf-8"
if sys.platform == "win32":
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

import argparse, requests
import cv2
import numpy as np
from PIL import Image
from datetime import datetime
from pathlib import Path
import shutil


# ========== Pinyin Initials ==========
def get_pinyin_initials(chinese):
    """将中文转换为拼音首字母大写，如'东琴'->'DQ'，'湘微'->'XM'"""
    if not chinese:
        return ''
    # 档口缩写特例：巴芘仑→BBL，欣焯怡→XZY
    if chinese == '巴芘仑':
        return 'BBL'
    if chinese == '欣焯怡':
        return 'XZY'
    try:
        from pypinyin import lazy_pinyin
        initials = lazy_pinyin(chinese)
        result = ''.join(w[0].upper() for w in initials if w)
        # 如果结果为空或仍含中文，说明pypinyin失败，返回空
        if not result or any('一' <= c <= '鿿' for c in result):
            return ''
        return result
    except Exception:
        return ''


# ========== Config ==========

_folder_created = False

def get_desktop_dir():
    """Get desktop directory, create if not exists."""
    global _folder_created
    desktop = None

    # Method 1: USERPROFILE
    userprofile = os.environ.get('USERPROFILE')
    if userprofile:
        desktop = os.path.join(userprofile, 'Desktop')
        if os.path.exists(desktop):
            bill_dir = os.path.join(desktop, '票据视频')
            if not os.path.exists(bill_dir):
                os.makedirs(bill_dir)
                _folder_created = True
            return bill_dir

    # Method 2: HOMEDRIVE+HOMEPATH
    homedrive = os.environ.get('HOMEDRIVE')
    homepath = os.environ.get('HOMEPATH')
    if homedrive and homepath:
        desktop = os.path.join(homedrive + homepath, 'Desktop')
        if os.path.exists(desktop):
            bill_dir = os.path.join(desktop, '票据视频')
            if not os.path.exists(bill_dir):
                os.makedirs(bill_dir)
                _folder_created = True
            return bill_dir

    # Method 3: expanduser
    desktop = os.path.join(os.path.expanduser('~'), 'Desktop')
    if os.path.exists(desktop):
        bill_dir = os.path.join(desktop, '票据视频')
        if not os.path.exists(bill_dir):
            os.makedirs(bill_dir)
            _folder_created = True
        return bill_dir

    return None

VIDEO_DIR = r"C:\Users\Administrator\Desktop\temp_bill"

# Show usage hint when folder is created
def show_usage_hint():
    print("\n" + "=" * 50)
    print("票据视频文件夹已创建在桌面！")
    print("=" * 50)
    print("用法:")
    print("  1. 把票据视频或图片放入: " + VIDEO_DIR)
    print("  2. 运行: python scripts/bill_check.py " + VIDEO_DIR)
    print("")
    print("整理数据到飞书:")
    print("  python scripts/arrange.py")
    print("=" * 50)

ARK_API_KEY = "44e38313-658a-4245-986f-e45f9bc66fff"
ARK_BASE_URL = "https://ark.cn-beijing.volces.com/api/v1/chat/completions"
ARK_MODEL = "doubao-seed-1-8-251228"

# Feishu config for bill entry
FEISHU_APP_ID = 'cli_a91ad5ae63385bc9'
FEISHU_APP_SECRET = 'ga7Gn6pBJgUkftKY2JEpFe3TJFpB2Mun'
FEISHU_APP_TOKEN = 'CfAXbSrUFaBLv3stSRrcuUVon1b'
FEISHU_TABLE_ID = 'tblua6KaZ6PiWAp6'  # 录入目标表
_feishu_token = None


def get_feishu_token():
    global _feishu_token
    import json, urllib.request
    body = json.dumps({'app_id': FEISHU_APP_ID, 'app_secret': FEISHU_APP_SECRET}).encode()
    req = urllib.request.Request(
        'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
        data=body, headers={'Content-Type': 'application/json'}, method='POST')
    with urllib.request.urlopen(req, timeout=30) as resp:
        _feishu_token = json.loads(resp.read())['tenant_access_token']
    return _feishu_token


# 提取 Feishu 富文本字段的纯文本（字段类型为 1 Text 时，API 返回 [{text:'...',type:'text'}]）
def get_text_field(v):
    if not v:
        return ''
    if isinstance(v, str):
        return v
    if isinstance(v, list):
        return ''.join(
            s.get('text', '') if isinstance(s, dict) else str(s)
            for s in v
        )
    return str(v)


def feishu_api_get(path):
    import urllib.request
    req = urllib.request.Request(
        f'https://open.feishu.cn{path}',
        headers={'Authorization': f'Bearer {get_feishu_token()}'}, method='GET')
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


def feishu_api_post(path, data):
    import json, urllib.request, time
    body = json.dumps(data).encode()
    req = urllib.request.Request(
        f'https://open.feishu.cn{path}', data=body,
        headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {get_feishu_token()}'}, method='POST')
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


def feishu_api_put(path, data):
    import json, urllib.request, time
    body = json.dumps(data).encode()
    req = urllib.request.Request(
        f'https://open.feishu.cn{path}', data=body,
        headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {get_feishu_token()}'}, method='PUT')
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


def upload_file_to_feishu(file_path):
    """上传文件到飞书，返回 file_token"""
    import os, json, urllib.request, mimetypes, time
    if not os.path.exists(file_path):
        return None
    time.sleep(0.3)
    url = 'https://open.feishu.cn/open-apis/drive/v1/files/upload_all'
    boundary = '----FormBoundary7MA4YWxkTrZu0gW'
    with open(file_path, 'rb') as f:
        file_data = f.read()
    file_size = os.path.getsize(file_path)
    ext = os.path.splitext(file_path)[1].lower()
    mime_type = mimetypes.guess_type(file_path)[0] or 'image/jpeg'
    file_name = os.path.basename(file_path)
    body = (
        f'--{boundary}\r\n'
        f'Content-Disposition: form-data; name="file_name"\r\n\r\n{file_name}\r\n'
        f'--{boundary}\r\n'
        f'Content-Disposition: form-data; name="parent_type"\r\n\r\nbitable_file\r\n'
        f'--{boundary}\r\n'
        f'Content-Disposition: form-data; name="parent_node"\r\n\r\n{FEISHU_APP_TOKEN}\r\n'
        f'--{boundary}\r\n'
        f'Content-Disposition: form-data; name="size"\r\n\r\n{file_size}\r\n'
        f'--{boundary}\r\n'
        f'Content-Disposition: form-data; name="file"; filename="{file_name}"\r\n'
        f'Content-Type: {mime_type}\r\n\r\n'
    ).encode() + file_data + f'\r\n--{boundary}--'.encode()
    req = urllib.request.Request(
        url, data=body,
        headers={'Authorization': f'Bearer {get_feishu_token()}', 'Content-Type': f'multipart/form-data; boundary={boundary}'},
        method='POST'
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            result = json.loads(resp.read())
            if result.get('code') == 0:
                return result['data']['file_token']
            return None
    except:
        return None


def create_bill_record(fields):
    """写入一条票据记录到飞书表格"""
    import time
    # Clean up fields before sending
    clean_fields = {}
    for k, v in fields.items():
        if v is None or v == '':
            continue  # Skip empty fields
        clean_fields[k] = v
    time.sleep(0.5)
    return feishu_api_post(
        f'/open-apis/bitable/v1/apps/{FEISHU_APP_TOKEN}/tables/{FEISHU_TABLE_ID}/records',
        {'fields': clean_fields}
    )


# ========== Customer Name Validation ==========

def levenshtein_distance(s1, s2):
    """计算两个字符串之间的编辑距离（字符级）。"""
    if len(s1) < len(s2):
        return levenshtein_distance(s2, s1)
    if len(s2) == 0:
        return len(s1)
    prev_row = list(range(len(s2) + 1))
    for i, c1 in enumerate(s1):
        curr_row = [i + 1]
        for j, c2 in enumerate(s2):
            insertions = prev_row[j + 1] + 1
            deletions = curr_row[j] + 1
            substitutions = prev_row[j] + (c1 != c2)
            curr_row.append(min(insertions, deletions, substitutions))
        prev_row = curr_row
    return prev_row[-1]


def similarity_score(s1, s2):
    """计算两个字符串的相似度（0~1）。"""
    if not s1 or not s2:
        return 0.0
    # 清理空白字符
    s1 = re.sub(r'\s+', '', str(s1))
    s2 = re.sub(r'\s+', '', str(s2))
    if s1 == s2:
        return 1.0
    dist = levenshtein_distance(s1, s2)
    max_len = max(len(s1), len(s2))
    return 1.0 - dist / max_len


def get_existing_customers():
    """从飞书录入表获取所有已有的客户名称。返回 set。"""
    try:
        customers = set()
        pt = ''
        while True:
            path = f'/open-apis/bitable/v1/apps/{FEISHU_APP_TOKEN}/tables/{FEISHU_TABLE_ID}/records?page_size=100'
            if pt:
                path += f'&page_token={pt}'
            result = feishu_api_get(path)
            if result.get('code') != 0 or not result.get('data', {}).get('items'):
                break
            for r in result['data']['items']:
                c = get_text_field(r['fields'].get('客户', ''))
                if c:
                    # 去掉跟单、店员等后缀，保留主名
                    main = re.sub(r'(?:跟单|店员|账户)[:：\s].*$', '', c).strip()
                    if main:
                        customers.add(main)
            if not result['data'].get('has_more'):
                break
            pt = result['data'].get('page_token', '')
            time.sleep(0.3)
        return customers
    except Exception as e:
        print(f"[WARN] 获取已有客户列表失败: {e}")
        return set()


def find_closest_customer(customer, existing_customers):
    """在已有客户列表中找到最相似的名称。返回 (最相似名称, 相似度)。"""
    if not customer or not existing_customers:
        return None, 0.0
    best_match = None
    best_score = 0.0
    for ec in existing_customers:
        score = similarity_score(customer, ec)
        if score > best_score:
            best_score = score
            best_match = ec
    return best_match, best_score


def validate_and_fix_customer(customer, existing_customers, ocr_text=None, retry_fn=None):
    """验证客户名称，如果不符合已有列表则尝试修正。

    流程：
    1. 如果客户名完全匹配已有列表 -> 直接返回
    2. 如果相似度 >= 0.7 -> 自动修正并记入 是否错误
    3. 如果相似度 < 0.7 -> 重新 OCR（一次），再比较
    4. 如果重新 OCR 后相似度 >= 0.7 -> 修正并记入 是否错误
    5. 如果完全不相同（相似度 < 0.7）-> 记入 是否错误，保持原值

    返回：(最终客户名, 是否错误信息)
    """
    if not customer:
        return '', ''

    # 去掉空白
    customer_clean = re.sub(r'\s+', '', customer).strip()
    if not customer_clean:
        return '', ''

    # 主名去掉跟单/店员后缀
    customer_main = re.sub(r'(?:跟单|店员|账户)[:：\s].*$', '', customer_clean)

    # 已有列表为空，直接放行
    if not existing_customers:
        return customer, ''

    # 检查是否直接匹配已有名称
    if customer_main in existing_customers:
        return customer, ''

    # 检查主名是否在已有列表中
    for ec in existing_customers:
        if customer_main == ec:
            return customer, ''

    # 不匹配，检查相似度
    best_match, best_score = find_closest_customer(customer_main, existing_customers)

    # 情况1：相似度高（>= 0.7），自动修正
    if best_score >= 0.7:
        correction_note = f'客户名已修正: {customer_main} -> {best_match}'
        return best_match, correction_note

    # 情况2：相似度低，尝试重新 OCR
    if retry_fn and ocr_text:
        print(f"[RETRY] 客户名不匹配，重新 OCR... (best={best_match}, score={best_score:.2f})")
        text2 = retry_fn()
        if text2:
            # 从新 OCR 中提取客户名
            m = re.search(r'客户[:：]\s*([^\n]+)', text2)
            if m:
                new_customer = m.group(1).strip()
                new_main = re.sub(r'(?:跟单|店员|账户)[:：\s].*$', '', re.sub(r'\s+', '', new_customer))
                if new_main in existing_customers:
                    correction_note = f'客户名已修正: {customer_main} -> {new_main}（重新OCR）'
                    return new_main, correction_note
                new_best, new_score = find_closest_customer(new_main, existing_customers)
                if new_score >= 0.7:
                    correction_note = f'客户名已修正: {customer_main} -> {new_best}（重新OCR）'
                    return new_best, correction_note
                else:
                    # 重新 OCR 后仍然不同
                    correction_note = f'客户名异常: {customer_main}（已OCR重试，匹配度={new_score:.2f}）'
                    return customer_main, correction_note

    # 情况3：完全不相同
    correction_note = f'客户名异常: {customer_main}（匹配度={best_score:.2f}）'
    return customer_main, correction_note


def check_and_update_customer_error(record_id, existing_customers, table_id):
    """写入后读取记录，验证客户名是否正确，有问题则更新是否错误。

    流程：写入 -> 读取回记录 -> 提取客户名 -> 验证 -> 更新是否错误
    返回：(是否有问题, 错误信息)
    """
    if not record_id:
        return False, ''
    try:
        path = f'/open-apis/bitable/v1/apps/{FEISHU_APP_TOKEN}/tables/{table_id}/records/{record_id}'
        res = feishu_api_get(path)
        if res.get('code') != 0:
            return False, ''
        record = res.get('data', {}).get('record', {})
        customer = get_text_field(record.get('fields', {}).get('客户', ''))
        if not customer:
            return False, ''
        customer_main = re.sub(r'(?:跟单|店员|账户)[:：\s].*$', '', re.sub(r'\s+', '', customer)).strip()
        if not customer_main:
            return False, ''
        # 检查是否匹配已有名称
        if customer_main in existing_customers:
            return False, ''
        best_match, best_score = find_closest_customer(customer_main, existing_customers)
        update_path = f'/open-apis/bitable/v1/apps/{FEISHU_APP_TOKEN}/tables/{table_id}/records/{record_id}'
        if best_score >= 0.7:
            err_msg = f'客户名已修正: {customer_main} -> {best_match}'
            # 修正客户名并记录
            feishu_api_put(update_path, {'fields': {'客户': best_match, '是否错误': err_msg}})
        else:
            err_msg = f'客户名异常: {customer_main}（匹配度={best_score:.2f}）'
            # 只记错误，不强行修正
            feishu_api_put(update_path, {'fields': {'是否错误': err_msg}})
        return True, err_msg
    except Exception as e:
        print(f"[WARN] check_and_update_customer_error failed: {e}")
        return False, ''


def check_and_update_shop_error(record_id, table_id):
    """写入后读取记录，检查档口名称是否异常，必要时从单据内容重新解析更正。

    流程：读取记录 -> 检查档口名称 -> 明显异常则从单据内容重解析 -> 一致则更新，不一致则写是否错误
    返回：(是否有问题, 错误信息)
    """
    if not record_id:
        return False, ''
    try:
        path = f'/open-apis/bitable/v1/apps/{FEISHU_APP_TOKEN}/tables/{table_id}/records/{record_id}'
        res = feishu_api_get(path)
        if res.get('code') != 0:
            return False, ''
        record = res.get('data', {}).get('record', {})
        fields = record.get('fields', {})
        shop = get_text_field(fields.get('档口名称', ''))
        text = get_text_field(fields.get('单据内容', ''))

        # 判断是否明显异常：空、含地址特征（号/楼/层+街/路/市/区等）
        obviously_bad = False
        if not shop or not shop.strip():
            obviously_bad = True
        elif re.search(r'(?:号|栋|幢|楼|层|室)[^\s]*$', shop) and re.search(r'(?:街|路|道|巷|[省市县区镇])', shop):
            obviously_bad = True
        elif len(shop) < 2:
            obviously_bad = True

        if not obviously_bad:
            return False, ''

        # 异常，从单据内容重新解析
        if not text:
            return True, f'档口名称异常: {shop}（无法重新解析）'

        fixed_shop, _ = parse_shop_name(text)
        if not fixed_shop:
            return True, f'档口名称异常: {shop}（重解析失败）'

        if fixed_shop == shop:
            return False, ''

        # 解析结果与记录不同，更新档口名称
        update_data = {'fields': {'档口名称': fixed_shop, '是否错误': f'档口名称已修正: {shop}->{fixed_shop}'}}
        feishu_api_put(path, update_data)
        return True, f'档口名称已修正: {shop}->{fixed_shop}'
    except Exception as e:
        print(f"[WARN] check_and_update_shop_error failed: {e}")
        return False, ''


def filter_qr_content(text):
    """从 OCR 文本中过滤掉二维码/条形码相关内容。"""
    if not text:
        return text
    lines = []
    for line in text.split('\n'):
        # 跳过含二维码/条形码关键词的行
        if re.search(r'(?:扫码入库码|银行支付码|微信支付码|支付宝支付码|QR\s*code|scannable\s*QR|条形码|二维码|关辅日记|关铺日记)', line, re.I):
            continue
        # 跳过超长的十六进制/Base64 字符串（QR 原始数据）
        if len(line) > 200 and re.match(r'^[A-Fa-f0-9\s]{100,}$', line):
            continue
        lines.append(line)
    return '\n'.join(lines)

# Rate limiting: minimum seconds between API calls
_last_api_call = 0
API_RATE_LIMIT = 1.5  # seconds between calls


def ocr_doubao(image_path, timeout=300, retries=3):
    """OCR with rate limiting and extended timeout."""
    global _last_api_call

    # Rate limiting
    now = time.time()
    elapsed = now - _last_api_call
    if elapsed < API_RATE_LIMIT:
        time.sleep(API_RATE_LIMIT - elapsed)
    _last_api_call = time.time()

    # Resize image if too large
    img = Image.open(image_path)
    if max(img.size) > 1024:
        ratio = 1024 / max(img.size)
        new_size = tuple(int(dim * ratio) for dim in img.size)
        img = img.resize(new_size, Image.LANCZOS)
        img.save(image_path, "JPEG", quality=85)

    # Encode
    with open(image_path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode()

    payload = {
        "model": ARK_MODEL,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}},
                {"type": "text", "text": (
                    "Please extract ALL text visible in this image exactly as shown. "
                    "Include every word, number and symbol. "
                    "If it is a receipt or bill, include all fields: date, amount, account, items, totals."
                )}
            ]
        }],
        "max_tokens": 1024
    }
    headers = {"Authorization": f"Bearer {ARK_API_KEY}", "Content-Type": "application/json"}

    for attempt in range(retries):
        try:
            resp = requests.post(ARK_BASE_URL, headers=headers, json=payload, timeout=timeout)
            if resp.status_code == 200:
                return resp.json()["choices"][0]["message"]["content"].strip()
            elif resp.status_code == 429:
                # Rate limited, wait longer
                print(f"[OCR] Rate limited, waiting 10s...")
                time.sleep(10)
                continue
            else:
                print(f"[OCR ERROR] {resp.status_code}: {resp.text[:100]}", file=sys.stderr)
                if attempt < retries - 1:
                    time.sleep(2)  # Short wait before retry
                continue
        except requests.exceptions.Timeout:
            print(f"[OCR] Timeout, retry {attempt+1}/{retries}...")
            if attempt < retries - 1:
                time.sleep(3)
        except Exception as e:
            print(f"[OCR] Error: {e}")
            if attempt < retries - 1:
                time.sleep(2)

    return ""


def extract_batch_number(text):
    if not text:
        return None
    patterns = [
        r'单据号\s*[：:]\s*([A-Za-z0-9]+)',  # 单据号:260514XS173
        r'\**批次\*?\*?[号:：]?\s*([A-Za-z0-9+]{1,})',  # handles 批次: **批次**: **批次** 等
        r'批次号\s*[：:]\s*([A-Za-z0-9+]{1,})',
        r'批次\s*([A-Za-z0-9+]{1,})',
        r'单号\s*[：:]\s*([A-Za-z0-9+]{1,})',  # 秦丝单号格式
        r'订单编号[#：:]*\s*#?(\d{1,})',  # 订单编号:#22 or 订单编号:22
        r'#(\d{2,})',  # standalone #22
        r'川次[:：]?\s*(\d{5,})',
    ]
    for pattern in patterns:
        m = re.search(pattern, text)
        if m:
            batch = m.group(1)
            # 保留字母和数字，只清理特殊字符
            batch = re.sub(r'[^\w]', '', batch)
            return batch if len(batch) >= 1 else None
    return None


def parse_shop_name(text):
    """简化版档口名称提取逻辑"""
    # 预处理
    text = filter_qr_content(text)
    text = text.replace('\\n', '\n')
    lines = [l for l in text.split('\n') if l.strip() and l.strip() not in ('```', "'''")]
    if not lines:
        return "", ""

    # ===== Priority 1: 【店名】格式（优先）=====
    for line in lines:
        m = re.search(r'【([^】]+)】', line)
        if m:
            shop = m.group(1).strip()
            # 去除产品名称后缀
            for suffix in ['半身裙', '连衣裙', '上衣', 'T恤', '衬衫', '裤子', '裙子', '外套', '套装', '服饰厂', '服饰', '女裤', '裤业', '销售单', '退货单', '收款单']:
                if shop.endswith(suffix) and len(shop) > len(suffix):
                    shop = shop[:-len(suffix)]
            shop = shop.strip()
            if 2 <= len(shop) <= 6:
                if shop == '婉星': shop = '婉星儿'
                return shop, ""

    # ===== Priority 2: [店名]xxx销售单 格式（如 [巴芘仑]万能遥感销售单）=====
    for line in lines:
        m = re.search(r'\[([^\]]+)\].*(销售单|退货单|收款单)', line)
        if m:
            shop = m.group(1).strip()
            for suffix in ['半身裙', '连衣裙', '上衣', 'T恤', '衬衫', '裤子', '裙子', '外套', '套装', '服饰厂', '服饰', '女裤', '裤业', '销售单', '退货单', '收款单']:
                if shop.endswith(suffix) and len(shop) > len(suffix):
                    shop = shop[:-len(suffix)]
            shop = shop.strip()
            if 2 <= len(shop) <= 6:
                if shop == '婉星': shop = '婉星儿'
                return shop, ""

    # ===== Priority 3: [店名] 格式（简单括号）=====
    for line in lines:
        m = re.search(r'^\[([^\]]+)\]$', line)
        if m:
            shop = m.group(1).strip()
            for suffix in ['半身裙', '连衣裙', '上衣', 'T恤', '衬衫', '裤子', '裙子', '外套', '套装', '服饰厂', '服饰', '女裤', '裤业', '销售单', '退货单', '收款单']:
                if shop.endswith(suffix) and len(shop) > len(suffix):
                    shop = shop[:-len(suffix)]
            shop = shop.strip()
            if 2 <= len(shop) <= 6:
                if shop == '婉星': shop = '婉星儿'
                return shop, ""

    # ===== Priority 4: 查找包含"销售单/退货单/收款单"的行 =====
    # 只搜索前5行，避免找到底部文字
    for line in lines[:5]:
        line = line.strip()
        # 第1步：移除行中的 "-" 符号（档口名前的编号分隔符），只移除第一个
        line = re.sub(r'-', '', line, 1)
        # 第2步：匹配 "店名+销售单" 格式（支持中文+英文+数字）
        m = re.search(r'^([A-Za-z0-9\u4e00-\u9fa5]+)(?:服饰厂|服饰|女裤|裤业|时尚女装)*(?:销售单?|退货单?|收款单?)$', line)
        if m:
            shop = m.group(1)
            # 第3步：先移除 "店铺"
            if shop.endswith('店铺') and len(shop) > 2:
                shop = shop[:-2]
            # 第4步：移除 "销售单/退货单/收款单/销售/退货/收款"
            for suffix in ['半身裙', '连衣裙', '上衣', 'T恤', '衬衫', '裤子', '裙子', '外套', '套装', '销售单', '销售', '退货单', '退货', '收款单', '收款', '服饰厂', '服饰', '女裤', '裤业', '时尚女装']:
                if shop.endswith(suffix) and len(shop) > len(suffix):
                    shop = shop[:-len(suffix)]
            # 第5步：移除 "欧洲城店" 等地址后缀
            for suffix in ['欧洲城店', '欧洲城', '国际面料城', '世贸', '万达', '广场', '商城']:
                if shop.endswith(suffix) and len(shop) > len(suffix):
                    shop = shop[:-len(suffix)]
            shop = shop.strip()
            if len(shop) >= 2:
                if shop == '婉星': shop = '婉星儿'
                return shop, ""

        # 另一种格式：地址+店名+销售单
        m2 = re.search(r'([A-Za-z0-9\u4e00-\u9fa5]+)(?:销售单?|退货单?|收款单?)$', line)
        if m2:
            shop = m2.group(1)
            # 第3步：先移除 "店铺"
            if shop.endswith('店铺') and len(shop) > 2:
                shop = shop[:-2]
            # 第4步：移除后缀
            for suffix in ['半身裙', '连衣裙', '上衣', 'T恤', '衬衫', '裤子', '裙子', '外套', '套装', '销售单', '销售', '退货单', '退货', '收款单', '收款', '服饰厂', '服饰', '女裤', '裤业']:
                if shop.endswith(suffix) and len(shop) > len(suffix):
                    shop = shop[:-len(suffix)]
            # 第5步：移除 "欧洲城店" 等地址后缀
            for suffix in ['欧洲城店', '欧洲城', '国际面料城', '世贸', '万达', '广场', '商城']:
                if shop.endswith(suffix) and len(shop) > len(suffix):
                    shop = shop[:-len(suffix)]
            shop = shop.strip()
            if len(shop) >= 2:
                if shop == '婉星': shop = '婉星儿'
                return shop, ""

    return "", ""


def extract_batch_info(text):
    batch = extract_batch_number(text)
    shop, addr_from_shop = parse_shop_name(text)
    time_match = re.search(r'(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})(?::\d{2})?', text)
    timestamp = time_match.group(1) if time_match else None
    return batch, shop, timestamp, addr_from_shop


def extract_payment_amount(text):
    """从单据内容提取付款金额"""
    if not text:
        return 0
    lines = text.split('\n')
    # 第1优先：支付宝付/支付宝支付/微信支付/现金支付/现金（带数字金额的才是实际付款）
    for line in lines:
        m = re.search(r'(?:支付宝付|支付宝支付|微信支付|现金支付|现金|刷卡)[^\d]*?([\d,，.]+)', line)
        if m:
            v = re.sub(r'[,，]', '', m.group(1))
            try:
                val = float(v)
                if val > 0:
                    return val
            except:
                pass
    # 第2优先：支付宝账户/微信账户
    for line in lines:
        m = re.search(r'(?:支付宝账户|微信账户)[：:\s]*([\d,，.]+)', line)
        if m:
            v = re.sub(r'[,，]', '', m.group(1))
            try:
                val = float(v)
                if val > 0:
                    return val
            except:
                pass
    # 第3优先：实付
    for line in lines:
        m = re.search(r'实付[：:\s]*[¥￥]?\s*([\d,，.]+)', line)
        if m:
            v = re.sub(r'[,，]', '', m.group(1))
            try:
                val = float(v)
                if val > 0:
                    return val
            except:
                pass
    # 第4优先：农业银行账户/农行账户（储值卡充值）
    for line in lines:
        m = re.search(r'(?:农业银行账户|农行账户)[：:\s]*([\d,，.]+)', line)
        if m:
            v = re.sub(r'[,，]', '', m.group(1))
            try:
                val = float(v)
                if val > 0:
                    return val
            except:
                pass
    return 0


def extract_all_fields(text):
    """Extract all fields from OCR text for Feishu record."""
    # First: filter out QR code related content before any extraction
    text = filter_qr_content(text)
    batch, shop, timestamp, addr_from_shop = extract_batch_info(text)

    # Extract 客户 - 只取"客户:"后的第一段（到空格/顿号/换行/店员前为止）
    # 兼容格式：客户:郭时伟 / 客户: 郭时伟 / 客户:郭时伟 店员:欣欣
    customer_match = re.search(r'客户[:：]\s*([^\n]+)', text)
    customer = ''
    if customer_match:
        raw = customer_match.group(1).strip()
        # 去掉"店员:"及之后的内容
        raw = re.sub(r'\s*店员[:：].*$', '', raw)
        # 去掉"账户:"及之后的内容
        raw = re.sub(r'\s*账户[:：].*$', '', raw)
        customer = raw.strip()

    # Extract 地址 - 优先使用从店名解析出的地址，其次匹配档口地址:/门店地址:/地址: 标签行
    address = ''
    # 优先：从 parse_shop_name 解析出的地址（如"万象会4楼-430"）
    if addr_from_shop:
        address = addr_from_shop
    address_lines = []
    # 保存 parse_shop_name 解析出的地址，避免被后续循环覆盖
    shop_addr = addr_from_shop
    for i, line in enumerate(text.split('\n')):
        original_line = line
        line = line.strip()
        # 匹配地址标签行：档口地址:/门店地址:/地址: 后面跟内容
        # 使用 (.+) 而非 (.+?) 来确保匹配（行尾无换行符时 (?=\n) 不满足）
        m = re.match(r'^(?:档口|门店)?地址[:：]\s*(.+)', line)
        if m and m.group(1).strip():
            addr = m.group(1).strip()
            # 排除纯数字（门牌号等不算地址）
            if not re.match(r'^[\d\s\-]+$', addr) and not address:
                address = addr
                break
        # 记录所有含地址关键词的行（用于后续 fallback 精确匹配）
        if re.search(r'(?:欧洲城|芦淞市场|轻纺城|房兴|和泰|万象汇|万象会|银座|金都|金丽|金华|金钻|步行街|商贸|工业园)', line):
            address_lines.append((i, original_line))

    # 如果地址仍为空，尝试从含地址的行中提取
    if not address and address_lines:
        for _, line in address_lines:
            line = line.strip()
            # 市场类地址（欧洲城、芦淞市场 等关键词 + 号/楼/城/市场 等后缀）
            m = re.search(r'([^\n]{0,40}(?:欧洲城|芦淞市场|轻纺城|房兴|和泰|万象汇|万象会)[^\n]{0,20}(?:号|楼|城|市场|园|栋|层|座)?[^\n]{0,15})', line)
            if m:
                addr = m.group(0).strip()
                if addr and not re.match(r'^[\d\s\-]+$', addr):
                    address = addr
                    break
            # 尝试市场+具体位置格式（如"欧洲城芦淞市场2楼555号"）
            m2 = re.search(r'([\u4e00-\u9fa5]{2,20}(?:欧洲城|芦淞市场|轻纺城|房兴|和泰|万象汇)[^\n]{0,30})', line)
            if m2 and not address:
                addr = m2.group(0).strip()
                if addr and not re.match(r'^[\d\s\-]+$', addr) and len(addr) >= 4:
                    address = addr
                    break

    # 如果最终还是空的，且 parse_shop_name 返回过地址，保留它
    if not address and shop_addr:
        address = shop_addr

    # Fallback: 在全文中搜索地址模式（省/市/区/县/镇 + 街/路/道/号/楼/栋/层等）
    if not address:
        addr_pattern = re.search(
            r'([\u4e00-\u9fa5]{2,7}[省市县区镇][^\n]{0,30}?(?:街|路|道|巷|号|栋|幢|楼|层|室|城|市场|园))',
            text
        )
        if addr_pattern:
            address = addr_pattern.group(0).strip()
        else:
            # 直接以市/区结尾后跟地址关键词
            addr_pattern2 = re.search(
                r'([\u4e00-\u9fa5]*市[\u4e00-\u9fa5]{0,20}(?:街|路|道|巷|号|栋|楼|层|室|城|市场|园)[^\n]{0,15})',
                text
            )
            if addr_pattern2:
                address = addr_pattern2.group(0).strip()
            else:
                # 市场类地址（增强版：支持欧洲城、芦淞市场 等多种市场名称）
                # 修复：市场名后允许数字/短横（即"万象会4楼-430"中"4"在"楼"之前的情况）
                addr_pattern3 = re.search(
                    r'([\u4e00-\u9fa5]{2,10}(?:欧洲城|芦淞市场|轻纺城|房兴|和泰|万象汇|万象会|银座|金都|金丽|金华|金钻|步行街|商贸)[\d\-]{0,10}(?:号|楼|城|市场|园|栋|层|座)?[^\n]{0,20})',
                    text
                )
                if addr_pattern3:
                    address = addr_pattern3.group(0).strip()
                else:
                    # 地址可能在票据底部（经办人/电话附近），搜索含短地址关键词的行
                    bottom_lines = text.split('\n')[-15:]  # 取底部15行
                    for line in bottom_lines:
                        line = line.strip()
                        # 排除非地址行
                        if re.match(r'^(?:序号|款号|名称|数量|单价|小计|备注|经办人|电话|手机|微信|QQ|账号|合计|总计|实付|应付|优惠)', line):
                            continue
                        # 短城市/区名 + 地址关键词（如"株州芦淞区"或"芦淞市场2楼"）
                        m = re.search(r'([\u4e00-\u9fa5]{1,6}[省市县区镇]?[^\n]{0,25}(?:街|路|道|巷|号|栋|楼|层|室|城|市场|园|座|会))', line)
                        if m:
                            addr = m.group(0).strip()
                            if addr and not re.match(r'^[\d\s\-]+$', addr) and len(addr) >= 4:
                                address = addr
                                break
                    # 如果仍未找到，尝试从电话/经办人之前的行中找地址
                    if not address:
                        for line in text.split('\n'):
                            line = line.strip()
                            if re.match(r'^(?:经办人|电话|手机|微信|QQ|账号)', line):
                                break
                            # 株洲/芦淞等短城市名 + 地址关键词
                            m = re.search(r'((?:株?州|芦淞|荷塘|石峰|天元)[^\n]{0,30}?(?:街|路|道|巷|号|栋|楼|城|市场|会))', line)
                            if m:
                                addr = m.group(0).strip()
                                if addr and not re.match(r'^[\d\s\-]+$', addr):
                                    address = addr
                                    break
        # 排除纯数字行
        if address and re.match(r'^[\d\s\-]+$', address):
            address = ''
    last_balance = None
    # OCR 有时会将数字拆到下一行（如"上次余:11\n5元" → 115，"累计余:14\n1元" → 141），合并数字间换行
    text_bal = re.sub(r'(?<=\d)\n(?=\d)', '', text)
    m = re.search(r'上次余[：:\s]*¥?([-\d]+)', text_bal)
    if m:
        val = re.sub(r'[^-\d]', '', m.group(1).strip())
        last_balance = val if val and (val.lstrip('-').isdigit()) else None
    if not last_balance:
        m = re.search(r'上次结余[：:\s]*¥?([-\d]+)', text_bal)
        if m:
            val = re.sub(r'[^-\d]', '', m.group(1).strip())
            last_balance = val if val and (val.lstrip('-').isdigit()) else None
    if not last_balance:
        m = re.search(r'上次余额[：:\s]*¥?([-\d]+)', text_bal)
        if m:
            val = re.sub(r'[^-\d]', '', m.group(1).strip())
            last_balance = val if val and (val.lstrip('-').isdigit()) else None
    if not last_balance:
        # 匹配 "上次欠: 56"、"上次欠56"、"上次欠款：56" 等
        m = re.search(r'上次欠[款]?[：:\s]*[¥￥]?\s*([-\d]+)', text_bal)
        if m:
            val = re.sub(r'[^-\d]', '', m.group(1).strip())
            if val and val.lstrip('-').isdigit():
                last_balance = str(-int(val))
    if not last_balance:
        m = re.search(r'上期余额[：:\s]*¥?([-\d]+)', text_bal)
        if m:
            val = re.sub(r'[^-\d]', '', m.group(1).strip())
            last_balance = val if val and (val.lstrip('-').isdigit()) else None

    # Extract 累计结余 / 累计余 / 累计欠款 / 累计余额 - 欠款乘以-1（同样使用 text_bal 合并数字换行）
    total_balance = None
    m = re.search(r'累计余[：:\s]*¥?([-\d]+)', text_bal)
    if m:
        total_balance = m.group(1).strip()
    if not total_balance:
        m = re.search(r'累计结余[：:\s]*¥?([-\d]+)', text_bal)
        if m:
            total_balance = m.group(1).strip()
    if not total_balance:
        m = re.search(r'累计余额[：:\s]*¥?([-\d]+)', text_bal)
        if m:
            total_balance = m.group(1).strip()
    if not total_balance:
        m = re.search(r'累计欠款[：:\s]*¥?([-\d]+)', text_bal)
        if m:
            val = re.sub(r'[^-\d]', '', m.group(1).strip())
            if val and val.lstrip('-').isdigit():
                total_balance = str(-int(val))

    # 清理店名中的空格
    if shop:
        shop = re.sub(r'\s+', '', shop)
        # 如果同时有拉丁字母和中文，只保留拉丁字母
        has_latin = bool(re.search(r'[A-Za-z]', shop))
        has_chinese = bool(re.search(r'[\u4e00-\u9fa5]', shop))
        if has_latin and has_chinese:
            latin_only = re.sub(r'[^A-Za-z]', '', shop)
            if latin_only:
                shop = latin_only

    return {
        'batch_number': batch,
        'shop': shop,
        'bill_time': re.sub(r'^(\d{4})-(\d{2})-(\d{2})', r'\1/\2/\3', timestamp) if timestamp else None,
        'customer': customer,
        'address': address,
        'last_balance': int(last_balance) if last_balance and last_balance.lstrip('-').isdigit() else 0,
        'total_balance': int(total_balance) if total_balance and total_balance.lstrip('-').isdigit() else 0,
        'payment_amount': extract_payment_amount(text),
        'ocr_text': text
    }


def is_similar_batch(b1, b2):
    if not b1 or not b2 or len(b1) != len(b2):
        return False
    diff = sum(c1 != c2 for c1, c2 in zip(b1, b2))
    return diff <= 2


def is_same_bill(info1, info2):
    batch1, shop1, time1 = info1
    batch2, shop2, time2 = info2
    if batch1 == batch2:
        return True
    if is_similar_batch(batch1, batch2):
        if shop1 and shop2 and shop1 == shop2:
            if time1 and time2 and time1 == time2:
                return True
    return False


def bill_completeness_score(text):
    score = 0
    if re.search(r'[金额合计本单][:：]?\s*\d+', text):
        score += 10
    if re.search(r'客户[:：]', text):
        score += 5
    if re.search(r'\d{11}', text):
        score += 3
    score += len(text) // 100
    return score


# ========== Frame Processing ==========

def extract_frames(video_path, interval=1.0):
    if not os.path.exists(video_path):
        print(f"[ERROR] Video not found: {video_path}")
        return []
    cap = cv2.VideoCapture(video_path)
    fps = cap.get(cv2.CAP_PROP_FPS)
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    duration = total / fps if fps > 0 else 0
    print(f"[FRAME] FPS={fps:.2f}, Total={total}, Duration={duration:.2f}s")
    frames = []
    idx = 0
    step = max(int(fps * interval), 1)
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        if idx % step == 0:
            frames.append((idx, idx / fps, frame))
        idx += 1
    cap.release()
    print(f"[FRAME] Extracted {len(frames)} frames")
    return frames


def blur_score(image):
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    return cv2.Laplacian(gray, cv2.CV_64F).var()


def detect_bill_region(image):
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(blurred, 50, 150)
    dilated = cv2.dilate(edges, np.ones((3, 3), np.uint8), iterations=2)
    contours, _ = cv2.findContours(dilated, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None
    largest = max(contours, key=cv2.contourArea)
    if cv2.contourArea(largest) < 1000:
        return None
    return cv2.boundingRect(largest)


def is_bill_complete(frame, bill_region, margin=20):
    """Check if bill is fully inside the frame (not cut at edges)."""
    if bill_region is None:
        return False, "no_region"
    x, y, w, h = bill_region
    h_frame, w_frame = frame.shape[:2]
    if x < margin or y < margin:
        return False, f"cut(x={x},y={y})"
    if (x + w) > (w_frame - margin) or (y + h) > (h_frame - margin):
        return False, f"cut(x+w={x+w},y+h={y+h})"
    return True, "complete"


def is_clear(image, region, threshold=50):
    roi = image
    if region:
        x, y, w, h = region
        if (y+h) <= image.shape[0] and (x+w) <= image.shape[1]:
            roi = image[y:y+h, x:x+w]
    score = blur_score(roi)
    return score > threshold, score


def save_screenshot(frame, output_dir, prefix):
    os.makedirs(output_dir, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    path = os.path.join(output_dir, f"{prefix}_{ts}.jpg")
    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    Image.fromarray(rgb).save(path, "JPEG", quality=95)
    return path


def copy_rename(src_path, dst_path):
    """复制文件到新路径，不删除原文件。返回 (success, error_msg)。"""
    try:
        import shutil
        shutil.copy2(src_path, dst_path)
        if not os.path.exists(dst_path):
            return False, f"目标文件未创建: {dst_path}"
        dst_size = os.path.getsize(dst_path)
        if dst_size == 0:
            os.remove(dst_path)
            return False, f"目标文件大小为0"
        return True, None
    except Exception as e:
        if os.path.exists(dst_path):
            try:
                os.remove(dst_path)
            except:
                pass
        return False, str(e)


# ========== Grouping & Selection ==========

def group_frames_by_bill(frames):
    """Group frames by bill completeness: incomplete -> complete -> incomplete = one bill."""
    groups = []
    current_group = []
    in_complete_zone = False

    for frame_idx, timestamp, frame in frames:
        region = detect_bill_region(frame)
        clear, blur_val = is_clear(frame, region)
        complete, reason = is_bill_complete(frame, region)

        # Must be clear and complete to be in "complete zone"
        is_complete_frame = clear and complete

        if is_complete_frame:
            if not in_complete_zone:
                # Start of new complete zone
                if current_group:
                    groups.append(current_group)
                current_group = []
                in_complete_zone = True
            current_group.append({
                'frame_idx': frame_idx,
                'timestamp': timestamp,
                'frame': frame.copy(),
                'blur_score': blur_val,
                'region': region
            })
        else:
            if in_complete_zone:
                # End of complete zone
                if current_group:
                    groups.append(current_group)
                current_group = []
                in_complete_zone = False

    # Don't forget the last group
    if current_group:
        groups.append(current_group)

    print(f"[GROUP] Found {len(groups)} bill groups")
    return groups


def select_best_frame(group):
    """Select the clearest frame from a group for OCR."""
    if not group:
        return None
    # Sort by blur_score (higher = clearer)
    best = max(group, key=lambda x: x['blur_score'])
    return best


# ========== Main ==========

def get_run_date(batch_info):
    """Get run date from bill time in OCR text, fallback to current date."""
    bill_time = batch_info[2] if len(batch_info) > 2 else None
    if bill_time:
        try:
            return datetime.strptime(bill_time[:10], '%Y-%m-%d').strftime('%Y%m%d')
        except:
            pass
    return datetime.now().strftime('%Y%m%d')

def process(video_path, interval=1.0, output_dir=None, existing_customers=None):
    print("=" * 50)
    print("[START] Video Bill Detection")
    print("[GROUP] By bill completeness: incomplete -> complete -> incomplete = one bill")
    print("[DEDUP] Similar batch + same shop + same time -> keep clearest")
    print("=" * 50)

    frames = extract_frames(video_path, interval)
    if not frames:
        return 0

    video_name = Path(video_path).stem
    if output_dir is None:
        output_dir = os.path.join(VIDEO_DIR, f"{video_name}_screenshots")
    os.makedirs(output_dir, exist_ok=True)

    # Group frames by bill
    groups = group_frames_by_bill(frames)

    # Select best frame from each group for OCR
    candidates = []
    for i, group in enumerate(groups):
        best = select_best_frame(group)
        if best:
            best['group_id'] = i + 1
            candidates.append(best)
            print(f"  Group {i+1}: {len(group)} frames, best blur={best['blur_score']:.0f} @ t={best['timestamp']:.1f}s")

    print(f"\n[OCR] Processing {len(candidates)} candidates...\n")

    # Load existing results for deduplication
    result_path = os.path.join(output_dir, "bills_result.json")
    valid_bills = []
    if os.path.exists(result_path):
        try:
            with open(result_path, encoding="utf-8") as f:
                valid_bills = json.load(f).get("bills", [])
            print(f"[RESUME] Loaded {len(valid_bills)} existing bills")
        except:
            valid_bills = []

    stats = dict(total=len(candidates), blur=0, no_text=0, no_batch=0, new=0)

    def save_results():
        """Save results immediately."""
        with open(result_path, "w", encoding="utf-8") as f:
            json.dump(dict(bills=valid_bills, stats=stats), f, ensure_ascii=False, indent=2)

    def check_and_add_bill(batch_info, text, frame, group_id):
        """录入一张票据，不检查重复。"""
        nonlocal valid_bills
        batch_num = batch_info[0]

        # New bill
        run_date = get_run_date(batch_info)
        seq = len(valid_bills) + 1
        new_name = f"p_{run_date}_{seq:03d}.jpg"
        print(f"[NEW] -> {new_name}")
        # 直接按标准命名保存截图，不用 save_screenshot 的时间戳后缀
        img_path = os.path.join(output_dir, new_name)
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        Image.fromarray(rgb).save(img_path, "JPEG", quality=95)

        # Upload screenshot first with retry
        print(f"-> Uploading screenshot...", end=" ", flush=True)
        screenshot_token = None
        for retry in range(5):
            screenshot_token = upload_file_to_feishu(img_path)
            if screenshot_token:
                break
            if retry < 4:
                print(f"failed, retry {retry+1}/5...", end=" ", flush=True)
                time.sleep(5)
        if not screenshot_token:
            print(f"FAILED: screenshot upload failed after 5 retries")
            return False

        # Prepare fields
        all_fields = extract_all_fields(text)

        bill_ts = None
        if all_fields['bill_time']:
            try:
                bill_ts = int(datetime.strptime(all_fields['bill_time'], '%Y/%m/%d %H:%M:%S').timestamp() * 1000)
            except:
                try:
                    bill_ts = int(datetime.strptime(all_fields['bill_time'], '%Y/%m/%d %H:%M').timestamp() * 1000)
                except:
                    try:
                        bill_ts = int(datetime.strptime(all_fields['bill_time'], '%Y-%m-%d %H:%M:%S').timestamp() * 1000)
                    except:
                        try:
                            bill_ts = int(datetime.strptime(all_fields['bill_time'], '%Y-%m-%d %H:%M').timestamp() * 1000)
                        except:
                            bill_ts = int(datetime.now().timestamp() * 1000)
        fields = {
            '单据时间': bill_ts if bill_ts else int(datetime.now().timestamp() * 1000),
            '档口名称': all_fields['shop'] or '',
            '批次号': all_fields['batch_number'],
            '付款金额': all_fields.get('payment_amount', 0) or 0,
            '上次结余': all_fields['last_balance'] if all_fields['last_balance'] is not None else 0,
            '累计结余': all_fields['total_balance'] if all_fields['total_balance'] is not None else 0,
            '客户': all_fields['customer'],
            '地址': all_fields['address'],
            '记录时间': int(time.time() * 1000),
            '单据内容': filter_qr_content(text)
        }
        fields['单据截图'] = [{
            "file_token": screenshot_token,
            "name": new_name
        }]

        # Write to Feishu with retry
        print(f"-> Writing to Feishu...", end=" ", flush=True)
        res = None
        for retry in range(5):
            res = create_bill_record(fields)
            if res.get('code') == 0:
                break
            if retry < 4:
                print(f"failed, retry {retry+1}/5...", end=" ", flush=True)
                time.sleep(5)
        if res and res.get('code') == 0:
            record_id = res.get('data', {}).get('record', {}).get('record_id', '')
            # 写入后验证客户名
            if record_id and existing_customers:
                has_err, err_msg = check_and_update_customer_error(record_id, existing_customers, FEISHU_TABLE_ID)
                if has_err:
                    print(f" [客户验证: {err_msg}]", end="")
            shop_err, shop_err_msg = check_and_update_shop_error(record_id, FEISHU_TABLE_ID)
            if shop_err:
                print(f" [档口验证: {shop_err_msg}]", end="")
            print(f"OK")
            # Only save to local after Feishu write succeeds
            valid_bills.append(dict(
                ocr_text=text,
                screenshot=img_path,
                timestamp=int(time.time()*1000),
                batch_number=batch_num,
                shop=batch_info[1],
                bill_time=batch_info[2]
            ))
            save_results()
        else:
            err_msg = res.get('msg') if res else 'unknown'
            print(f"FAILED after 5 retries: {err_msg}")
            return False

        return True

    for cand in candidates:
        frame_idx = cand['frame_idx']
        timestamp = cand['timestamp']
        frame = cand['frame']
        group_id = cand['group_id']

        print(f"[Group {group_id}] frame={frame_idx} t={timestamp:.1f}s", end=" ", flush=True)

        tmp_path = os.path.join(output_dir, f"_ocr_g{group_id}_{frame_idx}.jpg")
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        Image.fromarray(rgb).save(tmp_path, "JPEG", quality=90)

        text = ocr_doubao(tmp_path)
        if os.path.exists(tmp_path):
            os.remove(tmp_path)

        if not text:
            print("no_text SKIP")
            stats["no_text"] += 1
            continue

        print(f"ocr_len={len(text)}", end=" ")

        # Extract batch info
        batch_info = extract_batch_info(text)
        batch_num = batch_info[0]

        if not batch_num:
            print("no_batch SKIP")
            stats["no_batch"] += 1
            continue

        print(f"batch={batch_num}", end=" ")

        # Add bill (no dedup check)
        check_and_add_bill(batch_info, text, frame, group_id)
        stats["new"] += 1

    print("\n" + "=" * 50)
    print(f"[STATS] total={stats['total']} no_text={stats['no_text']} no_batch={stats['no_batch']} new={stats['new']}")
    print(f"[OUTPUT] {result_path}")
    print("=" * 50)
    print(f"\n[DONE] Detected {len(valid_bills)} valid bills")
    return len(valid_bills)


# ========== Image Scanning & Processing ==========

def is_valid_bill_image(text):
    """Check if OCR text looks like a bill."""
    if not text or len(text.strip()) < 15:
        return False
    t = text.lower()
    skip = any(k in t for k in ['no visible', 'cannot be identified', 'no readable', 'QR code', 'scannable QR', '支付成功', '无法提取'])
    if skip:
        return False
    bill_types = ['销售单', '退货单', '收据', '发票', '清单', '明细', '销售退货单', '销售单据', '单据', '客户联']
    has_bill_type = any(bt in t for bt in bill_types)
    has_amount = any(k in t for k in ['总额', '总价', '合计', '实付', '金额', '单价', '小计'])
    return has_bill_type or (('单' in t or '联' in t) and has_amount)


def check_is_bill(image_path):
    """
    判断一张图片是否为有效票据。
    返回 (is_bill, batch_info, ocr_text, error_msg)
    - is_bill: bool, 是否为票据
    - batch_info: tuple (batch_number, shop, bill_time) 或 None
    - ocr_text: str 原始OCR文本
    - error_msg: str 失败原因
    """
    if not os.path.exists(image_path):
        return False, None, None, "文件不存在"

    text = ocr_doubao(image_path, timeout=300)
    if not text:
        return False, None, None, "OCR识别失败"

    if not is_valid_bill_image(text):
        return False, None, text, "非有效票据"

    batch_info = extract_batch_info(text)
    batch_num = batch_info[0]
    if not batch_num:
        return False, None, text, "无批次号"

    return True, batch_info, text, None


def process_single_image(image_path, output_dir, batch_info_list, seq_start=1):
    """OCR a single image and rename it. Returns (success, new_name, batch_info)."""
    print(f"[IMAGE] Processing: {os.path.basename(image_path)}", end=" ", flush=True)

    # OCR (uses same rate-limited function)
    text = ocr_doubao(image_path, timeout=300)
    if not text:
        print("-> OCR failed SKIP")
        return False, None, None

    if not is_valid_bill_image(text):
        print("-> Not a bill SKIP")
        return False, None, None

    # Extract batch info
    batch_info = extract_batch_info(text)
    batch_num = batch_info[0]

    if not batch_num:
        print("-> No batch number SKIP")
        return False, None, None

    print(f"-> batch={batch_num} NEW")

    # Rename file: p_运行日期_序号
    run_date = get_run_date(batch_info)
    new_name = f"p_{run_date}_{seq_start:03d}.jpg"
    new_path = os.path.join(output_dir, new_name)

    # Copy and rename (preserve original)
    try:
        img = Image.open(image_path)
        img.convert('RGB').save(new_path, "JPEG", quality=95)
    except Exception as e:
        print(f"-> Save failed: {e}")
        return False, None, None

    return True, new_name, batch_info


def scan_and_process_images(video_dir, output_dir, existing_bills=None, existing_customers=None):
    """Scan video directory for bill images and process them.
    Returns list of processed bills and stats. Writes immediately after each image.
    """
    # Load existing results for deduplication
    result_path = os.path.join(output_dir, "bills_result.json")
    all_bills = []
    if existing_bills is not None:
        all_bills = existing_bills
    elif os.path.exists(result_path):
        try:
            with open(result_path, encoding="utf-8") as f:
                all_bills = json.load(f).get("bills", [])
        except:
            all_bills = []

    # Supported image extensions
    img_exts = {'.jpg', '.jpeg', '.png', '.bmp', '.webp'}

    # Find all image files (not from screenshots folders, not already processed)
    image_files = []

    for entry in os.scandir(video_dir):
        if entry.is_file():
            fname = entry.name
            ext = os.path.splitext(fname)[1].lower()
            if ext in img_exts:
                # Skip screenshots folders
                if '_screenshots' in fname:
                    continue
                # Skip already processed files
                if '_processed' in fname:
                    print(f"  [SKIP] Already processed: {fname}")
                    continue
                # Skip files already named with p_YYYYMMDD_XXX pattern
                if re.match(r'^p_\d{8}_\d{3}\.jpg$', fname, re.I):
                    print(f"  [SKIP] Already named: {fname}")
                    continue
                image_files.append(Path(entry.path))

    if not image_files:
        print("[IMAGE] No new images found")
        return [], {'total': 0, 'new': 0, 'skipped': 0}

    print(f"[IMAGE] Found {len(image_files)} images to process")

    # Process each image
    stats = {'total': len(image_files), 'new': 0, 'skipped': 0}
    seq = len(all_bills) + 1

    def save_results():
        with open(result_path, "w", encoding="utf-8") as f:
            json.dump({'bills': all_bills}, f, ensure_ascii=False, indent=2)

    for img_path in sorted(image_files):
        print(f"[IMAGE] Processing: {img_path.name}", end=" ", flush=True)

        # OCR
        text = ocr_doubao(str(img_path), timeout=300)
        error_flags = []

        if not text:
            error_flags.append('OCR识别失败')
        elif not is_valid_bill_image(text):
            error_flags.append('非有效票据')

        # Extract fields if we have text
        all_fields = {'shop': None, 'batch_number': None, 'bill_time': None, 'customer': '', 'address': '', 'last_balance': None, 'total_balance': None, 'payment_amount': 0}
        batch_num = None
        batch_info = (None, None, None)
        if text:
            batch_info = extract_batch_info(text)
            batch_num = batch_info[0]
            if not batch_num:
                error_flags.append('批次无法识别')
            all_fields = extract_all_fields(text)

        if not batch_num:
            error_flags.append('批次无法识别')

        print(f"batch={batch_num or '?'}", end=" ")

        # New bill - rename and save (no dedup for images)
        run_date = get_run_date(batch_info) if batch_info[2] else datetime.now().strftime('%Y%m%d')
        new_name = f"p_{run_date}_{seq:03d}.jpg"
        new_path = os.path.join(output_dir, new_name)

        # Save renamed image to target folder
        shutil.copy2(str(img_path), new_path)

        # Upload screenshot first (use renamed image)
        screenshot_token = None
        print(f"-> Uploading...", end=" ", flush=True)
        for retry in range(5):
            screenshot_token = upload_file_to_feishu(new_path)
            if screenshot_token:
                break
            if retry < 4:
                print(f"failed, retry {retry+1}/5...", end=" ", flush=True)
                time.sleep(5)
        if not screenshot_token:
            print(f"upload failed")
            error_flags.append('截图上传失败')

        # Prepare fields
        bill_ts = None
        if all_fields['bill_time']:
            for fmt in ['%Y/%m/%d %H:%M:%S', '%Y/%m/%d %H:%M', '%Y-%m-%d %H:%M:%S', '%Y-%m-%d %H:%M']:
                try:
                    bill_ts = int(datetime.strptime(all_fields['bill_time'], fmt).timestamp() * 1000)
                    break
                except:
                    pass
        # 单据时间不能晚于当前时间，否则记为时间读取错误
        if bill_ts and bill_ts > int(datetime.now().timestamp() * 1000):
            error_flags.append('时间读取错误')

        is_err = '; '.join(error_flags) if error_flags else ''

        fields = {
            '单据时间': bill_ts if bill_ts else int(datetime.now().timestamp() * 1000),
            '档口名称': all_fields['shop'] or '',
            '批次号': all_fields['batch_number'] or '',
            '付款金额': all_fields.get('payment_amount', 0) or 0,
            '上次结余': all_fields['last_balance'] if all_fields['last_balance'] is not None else 0,
            '累计结余': all_fields['total_balance'] if all_fields['total_balance'] is not None else 0,
            '客户': all_fields['customer'],
            '地址': all_fields['address'],
            '记录时间': int(time.time() * 1000),
            '单据内容': filter_qr_content(text) or '',
        }
        if is_err:
            fields['是否错误'] = is_err
        if screenshot_token:
            fields['单据截图'] = [{"file_token": screenshot_token, "name": new_path}]

        # Write to Feishu with retry
        print(f"-> Writing to Feishu...", end=" ", flush=True)
        res = None
        for retry in range(5):
            res = create_bill_record(fields)
            if res.get('code') == 0:
                break
            if retry < 4:
                print(f"failed, retry {retry+1}/5...", end=" ", flush=True)
                time.sleep(5)
        if res and res.get('code') == 0:
            record_id = res.get('data', {}).get('record', {}).get('record_id', '')
            # 写入后验证客户名
            cust_err_msg = ''
            if record_id and existing_customers:
                has_err, cust_err_msg = check_and_update_customer_error(record_id, existing_customers, FEISHU_TABLE_ID)
                if has_err:
                    print(f" [客户验证: {cust_err_msg}]", end="")
            shop_err, shop_err_msg = check_and_update_shop_error(record_id, FEISHU_TABLE_ID)
            if shop_err:
                print(f" [档口验证: {shop_err_msg}]", end="")
            print(f"OK (error={is_err or 'none'})")
            # 写入成功后，重命名原图为目标文件名
            if screenshot_token:
                try:
                    os.rename(str(img_path), str(new_path))
                except Exception as rename_err:
                    # 重命名失败可能是文件已存在，保留新文件（包含处理后的数据）
                    print(f" [rename failed: {rename_err}]", end="")
                    # 尝试删除原文件（如果还存在的话），避免重复
                    if os.path.exists(str(img_path)):
                        try:
                            os.remove(str(img_path))
                            print(f" [kept new file, removed duplicate original]", end="")
                        except:
                            print(f" [kept new file]", end="")
            all_bills.append({
                'ocr_text': text or '',
                'screenshot': new_path,
                'timestamp': int(time.time()*1000),
                'batch_number': batch_num,
                'shop': batch_info[1],
                'bill_time': batch_info[2],
                'source': 'image',
                'original_name': img_path.name
            })
            save_results()
        else:
            err_msg = res.get('msg') if res else 'unknown'
            print(f"FAILED after 5 retries: {err_msg}")
            # 只清理 rename 成功创建的目标文件
            if new_path and os.path.exists(new_path):
                try:
                    os.remove(new_path)
                except:
                    pass

        stats['new'] += 1
        seq += 1

    print(f"[IMAGE] Stats: new={stats['new']}, skipped={stats['skipped']}")
    return [], stats  # Return empty list since we already saved to file


# ========== CLI ==========

def main():
    global VIDEO_DIR

    # Initialize and get desktop dir (creates folder if needed)
    VIDEO_DIR = r"C:\Users\Administrator\Desktop\temp_bill"

    # Show usage hint if folder was created
    if _folder_created:
        show_usage_hint()

    p = argparse.ArgumentParser(description="Bill Detection & OCR")
    p.add_argument("input", nargs="?", default=VIDEO_DIR, help="Video file, image file, or directory")
    p.add_argument("--interval", "-i", type=float, default=1.0)
    p.add_argument("--output", "-o")
    p.add_argument("--app-token", default=None, help="Feishu app token")
    p.add_argument("--table-id", default=None, help="Feishu table ID")
    args = p.parse_args()

    # Override Feishu config if command-line args provided
    global FEISHU_APP_TOKEN, FEISHU_TABLE_ID
    if args.app_token:
        FEISHU_APP_TOKEN = args.app_token
    if args.table_id:
        FEISHU_TABLE_ID = args.table_id

    input_path = Path(args.input)
    output_dir = Path(args.output) if args.output else input_path.parent if input_path.is_file() else input_path
    os.makedirs(output_dir, exist_ok=True)

    # Fetch existing customers once for validation
    existing_customers = get_existing_customers()

    img_exts = {'.jpg', '.jpeg', '.png', '.bmp', '.webp'}
    video_exts = {'.mp4', '.avi', '.mov', '.mkv'}

    # Single image file
    if input_path.is_file() and input_path.suffix.lower() in img_exts:
        print("=" * 50)
        print("[IMAGE] Direct image processing")
        print("=" * 50)

        # Load existing results
        result_file = output_dir / "bills_result.json"
        existing_bills = []
        if result_file.exists():
            with open(result_file, encoding="utf-8") as f:
                existing_bills = json.load(f).get("bills", [])

        print(f"[IMAGE] Processing: {input_path.name}", end=" ", flush=True)

        # OCR
        text = ocr_doubao(str(input_path), timeout=300)
        error_flags = []

        if not text:
            error_flags.append('OCR识别失败')
        elif not is_valid_bill_image(text):
            error_flags.append('非有效票据')

        # Extract fields if we have text
        all_fields = {'shop': None, 'batch_number': None, 'bill_time': None, 'customer': '', 'address': '', 'last_balance': None, 'total_balance': None, 'payment_amount': 0}
        batch_num = None
        batch_info = (None, None, None)
        if text:
            batch_info = extract_batch_info(text)
            batch_num = batch_info[0]
            if not batch_num:
                error_flags.append('批次无法识别')
            all_fields = extract_all_fields(text)

        if not batch_num:
            error_flags.append('批次无法识别')

        print(f"-> batch={batch_num or '?'}", end=" ")

        # New bill - rename and save (no dedup for images)
        seq = len(existing_bills) + 1
        run_date = get_run_date(batch_info) if batch_info[2] else datetime.now().strftime('%Y%m%d')
        new_name = f"p_{run_date}_{seq:03d}.jpg"
        new_path = output_dir / new_name

        # Upload screenshot first (use original image, don't rename yet)
        screenshot_token = None
        print(f"-> Uploading...", end=" ", flush=True)
        for retry in range(5):
            screenshot_token = upload_file_to_feishu(str(input_path))
            if screenshot_token:
                break
            if retry < 4:
                print(f"failed, retry {retry+1}/5...", end=" ", flush=True)
                time.sleep(5)
        if not screenshot_token:
            print(f"upload failed")
            error_flags.append('截图上传失败')

        # Prepare fields
        bill_ts = None
        if all_fields['bill_time']:
            for fmt in ['%Y/%m/%d %H:%M:%S', '%Y/%m/%d %H:%M', '%Y-%m-%d %H:%M:%S', '%Y-%m-%d %H:%M']:
                try:
                    bill_ts = int(datetime.strptime(all_fields['bill_time'], fmt).timestamp() * 1000)
                    break
                except:
                    pass

        is_err = '; '.join(error_flags) if error_flags else ''

        fields = {
            '单据时间': bill_ts if bill_ts else int(datetime.now().timestamp() * 1000),
            '档口名称': all_fields['shop'] or '',
            '批次号': all_fields['batch_number'] or '',
            '付款金额': all_fields.get('payment_amount', 0) or 0,
            '上次结余': all_fields['last_balance'] if all_fields['last_balance'] is not None else 0,
            '累计结余': all_fields['total_balance'] if all_fields['total_balance'] is not None else 0,
            '客户': all_fields['customer'],
            '地址': all_fields['address'],
            '记录时间': int(time.time() * 1000),
            '单据内容': filter_qr_content(text) or '',
        }
        if is_err:
            fields['是否错误'] = is_err
        if screenshot_token:
            fields['单据截图'] = [{"file_token": screenshot_token, "name": new_name}]

        # Write to Feishu with retry
        print(f"-> Writing to Feishu...", end=" ", flush=True)
        res = None
        for retry in range(5):
            res = create_bill_record(fields)
            if res.get('code') == 0:
                break
            if retry < 4:
                print(f"failed, retry {retry+1}/5...", end=" ", flush=True)
                time.sleep(5)
        if res and res.get('code') == 0:
            record_id = res.get('data', {}).get('record', {}).get('record_id', '')
            # 写入后验证客户名
            if record_id and existing_customers:
                has_err, cust_err_msg = check_and_update_customer_error(record_id, existing_customers, FEISHU_TABLE_ID)
                if has_err:
                    print(f" [客户验证: {cust_err_msg}]", end="")
            shop_err, shop_err_msg = check_and_update_shop_error(record_id, FEISHU_TABLE_ID)
            if shop_err:
                print(f" [档口验证: {shop_err_msg}]", end="")
            print(f"OK (error={is_err or 'none'})")
            # 写入成功后，重命名原图为目标文件名
            if screenshot_token:
                try:
                    os.rename(str(input_path), str(new_path))
                except Exception as rename_err:
                    # 重命名失败可能是文件已存在，保留新文件（包含处理后的数据）
                    print(f" [rename failed: {rename_err}]", end="")
                    # 尝试删除原文件（如果还存在的话），避免重复
                    if os.path.exists(str(input_path)):
                        try:
                            os.remove(str(input_path))
                            print(f" [kept new file, removed duplicate original]", end="")
                        except:
                            print(f" [kept new file]", end="")
            existing_bills.append({
                'ocr_text': text or '',
                'screenshot': str(new_path),
                'timestamp': int(time.time()*1000),
                'batch_number': batch_num,
                'shop': batch_info[1],
                'bill_time': batch_info[2],
                'source': 'image',
                'original_name': input_path.name
            })
            with open(result_file, "w", encoding="utf-8") as f:
                json.dump({'bills': existing_bills}, f, ensure_ascii=False, indent=2)
        else:
            err_msg = res.get('msg') if res else 'unknown'
            print(f"FAILED after 5 retries: {err_msg}")
            # 只清理 rename 成功创建的目标文件
            if new_path and os.path.exists(str(new_path)):
                try:
                    os.remove(str(new_path))
                except:
                    pass

        print(f"\n[DONE] {new_name}")

    # Single video file
    elif input_path.is_file() and input_path.suffix.lower() in video_exts:
        if not os.path.exists(args.input):
            print(f"[ERROR] File not found: {args.input}")
            return
        existing_customers = get_existing_customers()
        process(args.input, interval=args.interval, output_dir=str(output_dir), existing_customers=existing_customers)

    # Directory: scan for videos and images
    elif input_path.is_dir():
        print("=" * 50)
        print("[DIR] Scanning for videos and images")
        print("=" * 50)

        video_files = list(input_path.glob("*.mp4")) + list(input_path.glob("*.avi")) + list(input_path.glob("*.mov"))
        image_files = [Path(entry.path) for entry in os.scandir(args.input)
                       if entry.is_file()
                       and os.path.splitext(entry.name)[1].lower() in img_exts
                       and '_screenshots' not in entry.name]

        print(f"Found {len(video_files)} videos, {len(image_files)} images")

        all_bills = []
        existing_customers = get_existing_customers()

        # Process videos
        for vf in video_files:
            n = process(str(vf), interval=args.interval, output_dir=str(output_dir), existing_customers=existing_customers)
            print(f"[VIDEO] {vf.name}: {n} bills")
            result_file = output_dir / f"{vf.stem}_screenshots" / "bills_result.json"
            if result_file.exists():
                with open(result_file, encoding="utf-8") as f:
                    all_bills.extend(json.load(f).get("bills", []))

        # Load existing results and process new images
        result_file = output_dir / "bills_result.json"
        if result_file.exists():
            with open(result_file, encoding="utf-8") as f:
                all_bills = json.load(f).get("bills", [])

        if image_files:
            print(f"\n[IMAGE] Processing {len(image_files)} images...")
            image_bills, stats = scan_and_process_images(str(input_path), str(output_dir), all_bills, existing_customers=existing_customers)
            all_bills.extend(image_bills)

            # Save merged results
            with open(result_file, "w", encoding="utf-8") as f:
                json.dump({'bills': all_bills}, f, ensure_ascii=False, indent=2)

        print(f"\n[DONE] Total: {len(all_bills)} bills")

    else:
        print(f"[ERROR] Unknown input type: {args.input}")


if __name__ == "__main__":
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument('--check', help='Image path to check if it is a bill')
    args, _ = p.parse_known_args()
    if args.check:
        is_bill, batch_info, ocr_text, err = check_is_bill(args.check)
        if is_bill:
            print(f"BILL: shop={batch_info[1]} batch={batch_info[0]} time={batch_info[2]}")
        else:
            print(f"NOT_BILL: {err or 'not a valid bill'}")
            if ocr_text:
                print(f"OCR preview: {ocr_text[:200]}")
        exit(0 if is_bill else 1)
    else:
        main()