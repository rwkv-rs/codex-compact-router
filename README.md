# codex-compact-router

`codex-compact-router` 是一个本地 OpenAI/Codex 请求路由器。它的主要用途是让 Codex 的远程上下文压缩请求更激进地走快速通道，并在压缩失败时自动换模型重试。

它默认只特殊处理：

```text
POST /responses/compact
POST /v1/responses/compact
```

其它请求会原样转发到上游，便于把 `~/.codex/config.toml` 的 `openai_base_url` 指向本地路由器。

## 功能

- 压缩请求优先设置 `service_tier = "fast"`。
- 如果上游返回 `Unsupported service_tier: fast`，同一个模型会自动去掉 `service_tier` 重试，并且本轮后续 fallback 也不再带 `service_tier`。
- 压缩请求强制设置 `reasoning.effort = "low"`。
- 压缩失败时按模型顺序自动重试。
- 默认模型顺序：

```text
gpt-5.3-codex
gpt-5.3-codex-spark
gpt-5.4-mini
gpt-5.2
```

- `gpt-5.3-codex-spark` 默认只在估算输入不超过 `105000` tokens 时尝试，避免大上下文请求先撞 128k 上下文上限。
- 不记录 Authorization、请求体或响应体。
- 透明代理 Codex 的 WebSocket `/responses` 连接，避免本地 HTTP provider 导致 WebSocket 先失败再降级。
- 支持 systemd 常驻和失败自动重启。
- 支持 ChatGPT 登录的 Codex，默认上游是 `https://chatgpt.com/backend-api/codex`。

## 环境要求

- Linux 或启用了 systemd 的 WSL。
- Node.js 20 或更新版本。
- Codex CLI。
- 如果使用 ChatGPT 登录的 Codex，保持默认上游即可。
- 如果使用 `OPENAI_API_KEY` 模式，需要把上游改成 `https://api.openai.com/v1`。
- 如果使用 Clash Verge，推荐开启 TUN/增强模式，让 Node 进程的直连流量也被接管。
- 如果只使用 HTTP 代理环境变量，可以设置 `CODEX_COMPACT_ROUTER_PROXY`，例如 `http://127.0.0.1:7890`。

## 安装

```bash
git clone https://github.com/rwkv-rs/codex-compact-router.git
cd codex-compact-router
./scripts/install-linux-systemd.sh
```

安装脚本会：

- 安装 npm 依赖。
- 生成 `/etc/systemd/system/codex-compact-router.service`。
- 启动并启用 `codex-compact-router.service`。

检查状态：

```bash
./scripts/status.sh
curl http://127.0.0.1:18181/healthz
```

如果你已经把当前 Codex 会话的 `openai_base_url` 指到了 `127.0.0.1:18181`，不要在这个会话里直接停掉正在承载它的旧代理服务。建议另开一个终端完成服务切换，或者先启动新会话再切换。

## 配置 Codex

编辑 `~/.codex/config.toml`，加入：

```toml
openai_base_url = "http://127.0.0.1:18181"
```

推荐同时设置：

```toml
service_tier = "fast"
model_auto_compact_token_limit = 217600
```

`217600` 是 `272000` 上下文窗口的 80%。如果你的主模型上下文窗口不是 `272000`，按实际窗口乘以 `0.8` 计算。

配置改完后必须重启 Codex，或者重新 `codex resume`。Codex 的 provider base URL 是会话级配置，已有会话进程不会热重载。

## ChatGPT 登录和 API key 登录

默认配置面向 ChatGPT 登录：

```bash
CODEX_COMPACT_ROUTER_UPSTREAM=https://chatgpt.com/backend-api/codex
```

如果你使用 API key 登录，把 systemd 服务里的环境变量改成：

```ini
Environment=CODEX_COMPACT_ROUTER_UPSTREAM=https://api.openai.com/v1
```

然后重启服务：

```bash
sudo systemctl daemon-reload
sudo systemctl restart codex-compact-router.service
```

## Clash Verge

推荐方式是打开 Clash Verge 的 TUN/增强模式。这样 `codex-compact-router` 访问 `chatgpt.com` 或 `api.openai.com` 时会被系统网络层接管。

如果你只想显式走 Clash HTTP 代理，可以给 systemd 服务加：

```ini
Environment=CODEX_COMPACT_ROUTER_PROXY=http://127.0.0.1:7890
```

然后执行：

```bash
sudo systemctl daemon-reload
sudo systemctl restart codex-compact-router.service
```

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CODEX_COMPACT_ROUTER_HOST` | `127.0.0.1` | 监听地址 |
| `CODEX_COMPACT_ROUTER_PORT` | `18181` | 监听端口 |
| `CODEX_COMPACT_ROUTER_UPSTREAM` | `https://chatgpt.com/backend-api/codex` | 上游 Codex/OpenAI base URL |
| `CODEX_COMPACT_ROUTER_MODELS` | `gpt-5.3-codex,gpt-5.3-codex-spark,gpt-5.4-mini,gpt-5.2` | 压缩 fallback 模型顺序 |
| `CODEX_COMPACT_ROUTER_SMALL_CONTEXT_MODELS` | `gpt-5.3-codex-spark` | 小上下文模型集合 |
| `CODEX_COMPACT_ROUTER_SMALL_MODEL_TOKEN_LIMIT` | `105000` | 小上下文模型的估算 token 上限 |
| `CODEX_COMPACT_ROUTER_REASONING_EFFORT` | `low` | 压缩请求 reasoning effort |
| `CODEX_COMPACT_ROUTER_SERVICE_TIER` | `fast` | 压缩请求优先使用的 service tier，设为 `none` 可完全不发送 |
| `CODEX_COMPACT_ROUTER_AUTO_OMIT_UNSUPPORTED_SERVICE_TIER` | `true` | 上游拒绝 service tier 时自动去掉并重试 |
| `CODEX_COMPACT_ROUTER_PROXY` | 空 | 显式上游 HTTP/HTTPS 代理 |
| `CODEX_COMPACT_ROUTER_TIMEOUT_MS` | `1200000` | 单次上游请求超时 |
| `CODEX_COMPACT_ROUTER_MAX_BODY_BYTES` | `268435456` | 最大请求体大小 |

## 日志

systemd 默认写入：

```bash
/var/log/codex-compact-router.log
```

成功命中压缩路由时会看到类似：

```text
compact model=gpt-5.3-codex tier=fast estimated_tokens=90000 -> 400 1234ms
compact upstream rejected service_tier=fast; retrying without service_tier
compact model=gpt-5.3-codex tier=omitted estimated_tokens=90000 -> 200 2345ms
```

如果 Codex 报错里仍然显示：

```text
https://chatgpt.com/backend-api/codex/responses/compact
```

说明当前 Codex 进程没有走本地路由器。重启 Codex 后再试。

如果错误 URL 是：

```text
http://127.0.0.1:18181/responses/compact
```

说明请求已经进入路由器，可以查看 `/var/log/codex-compact-router.log` 判断 fallback 是否发生。

如果看到：

```text
Falling back from WebSockets to HTTPS transport
```

通常说明当前运行的路由器版本没有代理 WebSocket upgrade，或者服务还没有重启到新版本。更新后执行：

```bash
sudo systemctl restart codex-compact-router.service
```

新版本会把 `ws://127.0.0.1:18181/responses` 透明转发到上游的 WebSocket 端点。

## 卸载

```bash
./scripts/uninstall-linux-systemd.sh
```

然后从 `~/.codex/config.toml` 移除：

```toml
openai_base_url = "http://127.0.0.1:18181"
```

再重启 Codex。
