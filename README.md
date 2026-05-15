# 电商助手

电商运营辅助工具集合，包含抖店数据采集和票据管理两大模块。

## 模块说明

### 1. douyin-scraper（抖音数据抓取）

自动化采集抖店电商罗盘商品数据，分析退货率、利润等指标，写入飞书多维表格。

- `douyin-shop-analyzer.js` — 主采集脚本（Playwright浏览器自动化）
- `server.js` — HTTP服务端，提供Web界面和API
- `index.html` — Web管理界面
- `login-shop.js` — 抖店登录脚本

### 2. bill-manager（票据整理）

票据图片识别、数据录入和整理工具。

- `bill_image.py` — 票据图片处理
- `arrange2.js` — 票据整理
- `bill_check.py` — 票据校验
- `server.js` — HTTP服务端
