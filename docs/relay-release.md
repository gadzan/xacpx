# Relay 包发布 Runbook

面向维护者：把 relay 这套包从源码发到 npm 的顺序与命令。模块说明见
[relay-module.md](relay-module.md)，自托管部署见 [relay-deployment.md](relay-deployment.md)。

## 包与依赖拓扑

```
@ganglion/xacpx-relay-protocol   (零依赖；线协议 + DTO)
        ▲                 ▲
        │                 │
@ganglion/xacpx-relay     @ganglion/xacpx-channel-relay
  (hub，bin: xacpx-relay；   (连接器；peerDep xacpx >= 0.11.0)
   已内嵌看板 relay-web)

@ganglion/xacpx           (core；channel-relay 的 peer 依赖，独立发布)
```

- **`@ganglion/xacpx-relay-web` 不单独发布**（`private: true`）。它的 `dist/` 在
  `bun run build:relay` 时被拷进 `@ganglion/xacpx-relay` 的 `dist/relay-web`，随 hub 包一起出厂。
  因此 `xacpx-relay` 单包安装即自带看板，无需 `--web-root`。

## 当前发布状态（核对后更新）

| 包 | npm | repo | 说明 |
|---|---|---|---|
| `@ganglion/xacpx` | 0.10.1 | 0.11.0 | **需先发 0.11.0**（channel-relay 的 peer 前置） |
| `@ganglion/xacpx-relay-protocol` | 未发布 | 0.1.0 | 首发 |
| `@ganglion/xacpx-relay` | 未发布 | 0.1.0 | 首发（内嵌看板） |
| `@ganglion/xacpx-channel-relay` | 未发布 | 0.1.0 | 首发 |

> 用 `npm view <pkg> version` 随时核对线上版本。

## 发布顺序

1. **core `@ganglion/xacpx` 0.11.0** —— channel-relay 声明 `peerDependencies.xacpx >= 0.11.0`，
   用户侧得能装到 0.11.0。
2. **`@ganglion/xacpx-relay-protocol`** —— relay 和 channel-relay 都依赖它（`^0.1.0`）。
3. **`@ganglion/xacpx-relay` + `@ganglion/xacpx-channel-relay`** —— 两者都依赖已发布的 protocol。

`bun run publish:relay-stack` 已按 2→3 的拓扑顺序串好。

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
# 确认 root package.json 的 version 是 0.11.0
git tag v0.11.0
git push origin v0.11.0
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
npm i -g @ganglion/xacpx@0.11.0        # 或更高
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
