# Share Chat

临时聊天室 -- 创建房间，分享链接和密码，发送文字、图片、文件，无活动后自动销毁。

无需注册，阅后即焚。

[English](./README.md) | 中文

## 功能特性

- **临时房间** -- 6位房间号 + 4位密码，支持 1h / 6h / 12h / 24h 有效期，无活动自动销毁
- **聊天式消息** -- 文字、图片（内联预览）、文件（最大 100 MB），Ctrl+V 粘贴图片，选择文件后自动上传
- **房间分享** -- 二维码生成，一键复制链接和密码到剪贴板
- **房间浏览** -- 首页展示活跃房间列表，包含成员数、消息数和到期时间
- **速率限制** -- 密码错误渐进式冷却（3次后延迟，6次后封禁30分钟），创建房间限制（10分钟内3次，超过10次封禁60分钟）
- **Cloudflare Turnstile** -- 可选验证码，在触发速率限制后自动启用
- **多语言** -- 自动检测浏览器语言，支持：中文、英语、德语、法语、日语、西班牙语
- **自动命名** -- 根据 IP 自动分配用户名（Alice, Bob, Charlie...），无需登录

## 快速开始（本地运行）

```bash
npm install
node server.js
```

服务启动在 `http://localhost:3456`，同时绑定 `0.0.0.0` 并打印局域网 IP，方便同网络下其他设备访问。

自定义端口：

```bash
PORT=8080 node server.js
```

## 部署到 Cloudflare Workers

Cloudflare Worker 版本使用 KV 存储房间数据，R2 存储文件。

### 前置条件

1. Cloudflare 账号
2. 已安装并登录 [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)

### 配置

```bash
cd cloudflare-worker

# 创建 KV 命名空间
wrangler kv namespace create ROOMS

# 创建 R2 存储桶
wrangler r2 bucket create share-chat-files
```

修改 `wrangler.toml`，填入你的 KV 命名空间 ID 和 R2 存储桶名称：

```toml
name = "share-chat"
main = "src/worker.js"
compatibility_date = "2024-01-01"

[[kv_namespaces]]
binding = "ROOMS"
id = "你的KV命名空间ID"

[[r2_buckets]]
binding = "FILES"
bucket_name = "share-chat-files"
```

### 部署

```bash
wrangler deploy
```

### 可选：Turnstile 验证码

在 Cloudflare 控制台或通过 wrangler 设置环境变量：

```bash
wrangler secret put TURNSTILE_SITE_KEY
wrangler secret put TURNSTILE_SECRET_KEY
```

## 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `PORT` | 否 | `3456` | 服务端口（仅本地模式） |
| `TURNSTILE_SITE_KEY` | 否 | -- | Cloudflare Turnstile 站点密钥 |
| `TURNSTILE_SECRET_KEY` | 否 | -- | Cloudflare Turnstile 秘密密钥 |

## API 接口

所有房间操作需要在 URL 路径中包含房间 ID。消息和文件操作需要提供 PIN 密码。

| 方法 | 路径 | 认证 | 说明 |
|------|------|------|------|
| `POST` | `/api/room/create` | -- | 创建房间。Body: `{ "ttl": 1 }` |
| `POST` | `/api/room/:id/join` | -- | 加入房间。Body: `{ "pin": "1234" }` |
| `GET` | `/api/room/:id/info` | -- | 房间信息（无需密码） |
| `POST` | `/api/room/:id/send` | PIN | 发送消息。FormData: `pin`, `sender`, `text`, `file` |
| `GET` | `/api/room/:id/messages` | PIN | 获取消息。Query: `pin`, `since` |
| `GET` | `/api/room/:id/file/:msgId` | PIN | 下载文件 |
| `DELETE` | `/api/room/:id/message/:msgId` | PIN | 删除消息 |
| `GET` | `/api/rooms` | -- | 获取活跃房间列表 |
| `GET` | `/api/turnstile/config` | -- | 获取 Turnstile 配置 |

## 项目结构

```
.
├── server.js                  # Node.js Express 服务端（本地模式）
├── public/
│   └── index.html             # SPA 前端（本地模式）
├── package.json
└── cloudflare-worker/
    ├── wrangler.toml           # Wrangler 配置
    ├── package.json
    └── src/
        └── worker.js           # Cloudflare Worker（内嵌 HTML）
```

## 开源协议

MIT
