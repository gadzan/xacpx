# Relay 包发布 Runbook

面向维护者：把 relay 这套包从源码发到 npm 的顺序与命令。模块说明见
[relay-module.md](relay-module.md)，自托管部署见 [relay-deployment.md](relay-deployment.md)。

## 包与依赖拓扑

```
@ganglion/xacpx-relay-protocol   (零依赖；线协议 + DTO)
        ▲                 ▲
        │                 │
@ganglion/xacpx-relay     @ganglion/xacpx-channel-relay
  (hub，bin: xacpx-relay；   (连接器；peerDep xacpx >= 0.17.0-beta.6)
   已内嵌看板 relay-web)

@ganglion/xacpx           (core；channel-relay 的 peer 依赖，独立发布)
```

- **`@ganglion/xacpx-relay-web` 不单独发布**（`private: true`）。它的 `dist/` 在
  `bun run build:relay` 时被拷进 `@ganglion/xacpx-relay` 的 `dist/relay-web`，随 hub 包一起出厂。
  因此 `xacpx-relay` 单包安装即自带看板，无需 `--web-root`。

## 当前发布状态（核对后更新）

| 包 | npm | repo | 说明 |
|---|---|---|---|
| `@ganglion/xacpx` | 用 `npm view` 核对 | 0.18.0 | 含会话热度（warmth）后端：`transport.isSessionWarm` + `SessionWarmthTracker` |
| `@ganglion/xacpx-relay-protocol` | 用 `npm view` 核对 | 0.1.17 | `SessionDto.warm?` 可选字段 |
| `@ganglion/xacpx-relay` | 用 `npm view` 核对 | 0.9.17 | 内嵌看板（尾部缓存绑定 incarnation，同名重建不复活旧尾部） |
| `@ganglion/xacpx-channel-relay` | 用 `npm view` 核对 | 0.3.4 | 连接器 |

> 用 `npm view <pkg> version` 随时核对线上版本。

## 发布顺序

完整能力（含 RMUX 终端）上线时的固定顺序：

1. **RMUX SDK / daemon**（上游；本仓库不内嵌 SDK 源码）
2. **Sidecar platform packages**（checksum manifest；Task 27）
3. **core `@ganglion/xacpx`** —— `SessionResourceCatalog` / plugin-api；channel-relay `minXacpxVersion` / peer
4. **`@ganglion/xacpx-relay-protocol`**
5. **`@ganglion/xacpx-relay`（含内嵌 relay-web）**
6. **`@ganglion/xacpx-channel-relay`**（最后发）

当前 tag 触发的 npm 发布顺序仍是：

1. **core `@ganglion/xacpx` 0.17.0-beta.6** —— channel-relay 声明
   `peerDependencies.xacpx >= 0.17.0-beta.6`，必须先发布含 deadline-aware `setSessionModel` 的 core。
2. **`@ganglion/xacpx-relay-protocol`** —— relay 和 channel-relay 都依赖它（`^0.1.0`）。
3. **`@ganglion/xacpx-relay` + `@ganglion/xacpx-channel-relay`** —— 两者都依赖已发布的 protocol。

`bun run publish:relay-stack` 已按 2→3 的拓扑顺序串好。半截升级时旧 hub/connector/web 组合会安全隐藏终端 UI（缺 capability），属预期。

### RMUX terminal smoke（opt-in）

真实 RMUX daemon + sidecar 验收**不**进入默认 `npm test`。platform packages 就绪后按 design spec §22.6
与后续 smoke harness 执行；orphan 消失时间须 ≤ `ownerLeaseTtl` + bounded retry/grace。

## 发布前自检（必跑）

```bash
bun run verify:publish
```

它会 `build:packages`（含把看板嵌进 relay 包）再校验每个包的 tarball。relay 包这一项会断言
`dist/relay-web/index.html` 在 tarball 里——**没有它就等于发了个没看板的 hub**，校验会直接失败。

## 发布 core（tag 触发，已有 CI）

`@ganglion/xacpx` 走 `.github/workflows/publish-xacpx.yml`：推 `v*` tag → 自动 test +
`verify:publish` + tag/版本一致性校验 + `npm publish`（用 `secrets.NPM_TOKEN`）+ 发 weacpx-compat shim。

```bash
# 确认 root package.json 的 version 与目标 tag 一致（本轮为 0.17.0-beta.6）
git tag v0.17.0-beta.6
git push origin v0.17.0-beta.6
```

## 发布 relay 三包（tag 触发，已有 CI）

relay 三包各有 tag 触发 workflow（`publish-relay-protocol.yml` / `publish-relay.yml` /
`publish-channel-relay.yml`，结构与频道包一致：test + `verify:publish` + tag/版本一致性校验 +
`npm publish`（`secrets.NPM_TOKEN`）+ GitHub release）。按拓扑顺序推 tag：

```bash
# 2. protocol 先发（确认 packages/relay-protocol/package.json version=0.1.0）
git tag relay-protocol-v0.1.0 && git push origin relay-protocol-v0.1.0

# 3. protocol 发布完成后，再发 hub 和连接器
git tag relay-v0.1.0          && git push origin relay-v0.1.0
git tag channel-relay-v0.1.0  && git push origin channel-relay-v0.1.0
```

每个 workflow 会校验 tag 必须精确等于 `<pkg>-v<package.json 的 version>`，对不上直接失败。
预发布版本号（含 `-beta`/`-rc`）自动走 npm `next` dist-tag。

### 本地手动发布（备用）

无 CI / 本地直接发时：

```bash
npm login                 # 需要 @ganglion scope 的发布权限
bun run verify:publish
bun run publish:relay-stack   # publish:relay-protocol → publish:relay → publish:channel-relay
```

需要单独发某一个时用对应的 `publish:relay-*` 脚本。

## 发布后验证

```bash
npm i -g @ganglion/xacpx-relay
xacpx-relay start
#   预期输出含：dashboard: /…/@ganglion/xacpx-relay/dist/relay-web
#   若是 dashboard: (none) → 看板没打进包，回头查 build:relay 的 bundle:relay-web 步骤
```

连接器侧：
```bash
npm i -g @ganglion/xacpx@0.17.0-beta.6  # 或更高
xacpx channel add relay --url <host> --token <access-token>
```

## Tag 约定汇总

| 包 | tag 前缀 | 触发 workflow |
|---|---|---|
| `@ganglion/xacpx` | `v<X.Y.Z>` | publish-xacpx.yml |
| `@ganglion/xacpx-channel-feishu` | `channel-feishu-v<X.Y.Z>` | publish-channel-feishu.yml |
| `@ganglion/xacpx-channel-yuanbao` | `channel-yuanbao-v<X.Y.Z>` | publish-channel-yuanbao.yml |
| `@ganglion/xacpx-relay-protocol` | `relay-protocol-v<X.Y.Z>` | publish-relay-protocol.yml |
| `@ganglion/xacpx-relay` | `relay-v<X.Y.Z>` | publish-relay.yml |
| `@ganglion/xacpx-channel-relay` | `channel-relay-v<X.Y.Z>` | publish-channel-relay.yml |

预发布走 npm `next` dist-tag；CI workflow 按 tag 里的 `-beta`/`-rc` 等后缀自动选 dist-tag。

> tag 前缀互不冲突：`relay-v*` 不匹配 `relay-protocol-v*`（后者以 `relay-p` 开头），
> `channel-relay-v*` 也独立于 `channel-feishu-v*` / `channel-yuanbao-v*`。
