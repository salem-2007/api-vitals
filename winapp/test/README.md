# 测试说明

四层测试，全部是自研轻量脚本，无测试框架依赖（免安装、免配置）。

## 分层

| 层 | 文件 | 作用 |
|---|---|---|
| mock 后端 | `mock.mjs` | 四类协议的本地模拟服务器，所有测试的共同底座 |
| 引擎单元 | `test-engine.mjs` | 直接 import `engine.js` 打真实 HTTP，不开浏览器 |
| UI 端到端 | `e2e-ui.mjs` | headless Edge + CDP 驱动真实 DOM |
| 样式审计 | `audit.mjs` | 读 `getComputedStyle` 验证字体/对比度/浮层定位 |
| 截图 | `shot.mjs` | 生成深浅主题截图（无断言） |

## mock 后端

`mock.mjs` 模拟四类协议，并提供**确定性的失败样本**：

| 模型 | 行为 | 用途 |
|---|---|---|
| `mock-fast` | 正常返回 `436` | 正常路径 |
| `mock-chat` | 正常返回中文长文 | 正常路径 |
| `mock-down` | 固定 500 | 失败路径 / 可重试判定 |
| `mock-empty-reasoning` | 200 但正文在 `reasoning_content` | 复现推理模型空正文 |
| `mock-truncated` | `finish_reason=length` 正文为空 | 复现 max_tokens 截断 |
| `mock-flaky` | 前 2 次 500，之后成功 | 验证自动重试 |

并发守卫：同时请求数 `> 3` 返回 429，用于验证并发测试与上限判定。

这些失败样本来自真实使用中跑出的报告，不是凭空构造的。

## 运行

```bash
cd winapp

# 引擎单元测试（无前置依赖）
node test/test-engine.mjs

# 端到端（需先起静态服务）
cd wwwroot && python3 -m http.server 18099 --bind 127.0.0.1 &
cd .. && node test/e2e-ui.mjs

# 样式审计（打印 JSON + 出局部截图）
node test/audit.mjs

# 截图
node test/shot.mjs
```

## 约定

- 断言用自写的 `t(name, cond, info)` 累加 pass/fail，末尾 `process.exit(fail ? 1 : 0)`，退出码可用于 CI。
- `engine.js` 不碰 DOM，所以能在 Node 里直接跑 —— 保持这个边界，别把 DOM 逻辑塞进引擎层。
- e2e 用 `localStorage` 种子数据绕过 UI 输入，再用 `Page.reload` 让应用读入；断言打在真实 DOM 上。
- 浏览器模式下 `navigator.clipboard` 用打桩，走原生桥的回退路径。
