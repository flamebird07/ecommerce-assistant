#!/usr/bin/env python3
"""拼音首字母转换工具"""
import sys

def get_pinyin_initials(chinese):
    """将中文转换为拼音首字母大写，如'东琴'->'DQ'，'湘微'->'XM'"""
    if not chinese:
        return ''
    # 档口缩写特例
    if chinese == '巴芘仑':
        return 'BBL'
    if chinese == '欣焯怡':
        return 'XZY'
    if chinese == '靓点红怡纯':
        return 'LDHYC'
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

if __name__ == '__main__':
    if len(sys.argv) > 1:
        print(get_pinyin_initials(sys.argv[1]), end='')
