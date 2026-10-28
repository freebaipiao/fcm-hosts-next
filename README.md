# FCM Hosts Next

自动维护 Google Firebase Cloud Messaging (FCM) 优选 Hosts。项目在中国大陆双栈机器上直接采集、实测、发布，目标是给 Android / microG / Google Play services 提供更稳定的 FCM 长连接入口。

## 架构

当前生产架构是单机流水线：

1. **Harvest**：使用 EDNS Client Subnet (ECS) 查询 `mtalk.google.com`，采集候选 IPv4/IPv6。
2. **Seed**：读取仓库内上一轮成功的 `fcm_*.hosts`，把历史可用 IP 继续作为种子。
3. **Verify**：在大陆双栈 self-hosted runner 上对候选 IP 执行 TCP `5228` 连接测速。
4. **Expand**：对已成功 IP 做小范围邻近扩展，再次实测。
5. **Publish**：生成并提交 `fcm_ipv4.hosts`、`fcm_ipv6.hosts`、`fcm_dual.hosts`。

核心实现是 Go 单二进制，无 Python runtime、无 pip 依赖、无跨 runner artifact 搬运。

## 产物

- [fcm_dual.hosts](fcm_dual.hosts)：推荐。双栈输出；若某次只选出单栈，会自动降级。
- [fcm_ipv6.hosts](fcm_ipv6.hosts)：纯 IPv6 输出。
- [fcm_ipv4.hosts](fcm_ipv4.hosts)：纯 IPv4 输出。

默认每天更新 4 次；临时刷新可手动触发 GitHub Actions。

## 使用

服务器分发地址：

```text
https://fcm-hosts.cagedbird.cn/fcm_dual.hosts
```

向后兼容地址（旧路径，仍可用）：

```text
https://cagedbird.cn/fcm-hosts-next/fcm_dual.hosts
```

可用于：

- 系统 hosts 定时拉取并原子覆盖。
- sing-box / Clash 的 hosts 数据源。

## Fork 附加功能：静态 DoH Worker

`worker/` 提供 `/dns-query`，支持标准 DoH GET/POST。
`mtalk.google.com` 的 A/AAAA 记录从上游已发布的双栈 Hosts 生成；
该域名的其他查询类型返回空答案。其他域名优先使用 Cloudflare DoH，
传输、HTTP 或报文错误时使用 Google DoH；正常 NXDOMAIN 不重试。

新增工作流 [Update FCM DoH](.github/workflows/deploy-doh.yml) 每 6 小时检查一次数据。
数据变化时部署；手动运行会强制部署。部署成功后才提交数据，失败时保留旧版本。
此工作流使用 GitHub 托管 runner，无需上游的探测服务器或 SSH 密钥。

首次部署：

1. 在仓库的 Settings → Secrets and variables → Actions 中添加
   `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID`。
2. 在 Actions 中启用并运行 **Update FCM DoH**，保持 `deploy` 勾选。
3. 使用部署日志显示的 Worker 地址，并在末尾添加 `/dns-query`。

取消勾选 `deploy` 可以只运行数据、DoH 行为与 Worker 构建验证。
下载失败或上游无有效记录时不会覆盖数据，也不会部署。

本地验证新增功能：

```bash
python scripts/update_fcm.py
python -m unittest discover -s scripts -p 'test_*.py'
cd worker
npm ci
npm test
npm run build
```

## 本地运行

```bash
go test ./...
go run ./cmd/fcmhost run -workdir .
```

常用调试：

```bash
go run ./cmd/fcmhost run -workdir . -dns=false -v
```

`-dns=false` 只使用现有 hosts/raw seeds 做验证，适合快速确认当前网络能否连通 FCM `5228`。

---

_Status: Automated / Mainland dual-stack verified_

## Agent-native Skills

### Start here

- 自动化运行 / runner 发布 / 本地验证 -> [.agents/skills/runner-publish/SKILL.md](.agents/skills/runner-publish/SKILL.md)

### Skills

- [.agents/skills/runner-publish/SKILL.md](.agents/skills/runner-publish/SKILL.md): 管理 FCM hosts 更新流水线、SSH 秘钥配置与本地运行验证。Trigger: 修改 GitHub Actions 工作流、排查 hosts 刷新/服务器发布故障或验证业务代码。

### Deep docs

- [README.md](README.md): 架构、产物列表与基本用法

### Do not read everything

Agent 应该首先读取 [AGENTS.md](AGENTS.md) 了解项目级硬规则与定位，随后根据任务选择读取对应的 skill 或文档，禁止无序扫描整个仓库。
