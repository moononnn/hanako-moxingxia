# 模型匣测试说明

## 运行

在插件目录执行：

```powershell
npm test
```

发布前另外执行：

```powershell
node --check index.js
node --check lib/failwatch.js
node --check lib/failwatch-guard.js
node --check lib/page.js
node --check routes/ui.js
```

## 覆盖范围

- `tests/failwatch.test.js`：失败信号识别、三槽位归因、明确故障/临时波动分级、思考耗尽豁免、窗口计数、手动恢复计划、旧状态迁移、备用配置比较、供应商占用保护、日志尾随基线与消耗统计。
- `tests/guard.test.js`：小工具/大工具/识图独立切换、主模型与备用模型故障、备用缺失、配置写入对账、手动接管、默认不自动恢复、提个醒通知失败隔离及 `backup-failed` 状态。
- `tests/catalog.test.js`：供应商/模型快照、隐藏与恢复、排序、运行时顺序对账和本地供应商模型补齐。

当前基线：`npm test` 共 134 项，全部通过。

另已用隔离 HANA_HOME + 本地 HTTP 假服务做 handler smoke：真实加载 `routes/ui.js`，覆盖 failwatch status/reset/backup，以及备用供应商占用拦截；共注册 14 条路由。
