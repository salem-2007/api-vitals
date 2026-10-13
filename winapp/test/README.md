# 测试说明

三层测试，全部自研轻量脚本，无测试框架依赖（免安装、免配置）。

## 分层

| 层 | 文件 | 作用 |
|---|---|---|
| mock 后端 | `mock-api.mjs` | 静态服务 wwwroot + OpenAI 兼容接口（/v1/models、/v1/chat/completions、视觉裁判），所有测试的共同底座 |
| CDP 驱动 | `cdp.mjs` | 零依赖 CDP 客户端：启动本机浏览器、求值、截图（WSL 下自动用 Windows 侧 Chrome/Edge） |
| 引擎单元 | `test-engine.mjs` | 直接 import `engine.js`：判分规格、SVG 抽取/净化、裁判 JSON 解析、统计报告、并发池、HTTP 全链路、7 层 20 项指纹探针与数值指纹归因 |
| UI 端到端 | `e2e-ui.mjs` | 真实浏览器 + CDP：`?e2e=1` 钩子自动建端点、跑检测，断言时间轴/成绩单/画廊/题库/指纹鉴定/答题记录浏览器真实 DOM |
| UI 审计 | `audit.mjs` | 计算样式审计：双主题对比度 ≥4.5、键盘焦点可见、`prefers-reduced-motion`、无横向滚动、触达尺寸 ≥24px、图表 aria |

## mock 后端能力

- `/v1/models`：返回去重后排序的模型列表
- 学科题：按请求里的「题目：」原文查表回答案（默认全对，便于断言 100%）
- `mock-429`：第一次返回 429，验证退避重试
- `mock-truncate`：返回 `finish_reason=length`，验证自动抬 `max_tokens`
- `mock-nofinal`：只给推理不给最终答案，验证「补答」链路
- 视觉裁判：识别含图像块的请求，返回严格 JSON 评分
- 指纹探针：两套人设 —— `claude-opus-4-6`（干净官方模型，全部探针通过）
  与 `claude-sonnet-4-6` / `deepseek-r1`（套壳降智：泄露 x-ollama 头、控制符注入 400、
  无 usage、身份自述不符、JSON 污染、无 tool_calls、签名被改写）
- 数值指纹：从真实指纹库的分布里采样整数序列，模拟「真模型」与「换底模型」（外壳 Claude / 底层 GPT）
- SVG 生成：返回带 SMIL 动画的 SVG，用于帧捕获与画廊渲染

## 运行

```bash
cd winapp
node test/test-engine.mjs    # 引擎单测（无前置依赖）
node test/e2e-ui.mjs         # 端到端（自带静态服务与 mock，无需手工起服务）
node test/audit.mjs          # UI 审计（出深浅主题截图到 test/shots/）
```

浏览器自动探测：WSL 找 `/mnt/c/.../chrome.exe|msedge.exe`，Linux 找 chrome/chromium；也可用 `BROWSER_PATH` 指定。

## 约定

- 断言用自写 `t(name, cond, info)` 累加 pass/fail，末尾 `process.exit(fail ? 1 : 0)`，退出码可直接用于 CI。
- `engine.js` 不碰 DOM —— 保持这个边界，别把 DOM 逻辑塞进引擎层。
- e2e 用 `?e2e=1&base=...&qs=...&tasks=...` 钩子种子数据并自动开跑，断言打在真实 DOM 上。
- 截图落在 `test/shots/`，CI 失败时作为 artifact 上传。
