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

## 发布 relay 三包（暂无 workflow → 本地手动）

relay 三包目前**没有 tag 触发 workflow**（只有 core/feishu/yuanbao 有）。先本地发：

```bash
npm login                 # 需要 @ganglion scope 的发布权限
bun run verify:publish    # 再确认一次
bun run publish:relay-stack
```

`publish:relay-stack` = `publish:relay-protocol` → `publish:relay` → `publish:channel-relay`
（均 `bun publish --access public`）。需要单独发某一个时用对应的 `publish:relay-*` 脚本。

> 想要和其它包一致的 tag 触发体验，可仿照 `publish-channel-feishu.yml` 为 relay 三包各加一个
> workflow（建议 tag 前缀 `relay-protocol-v*` / `relay-v*` / `channel-relay-v*`）。尚未添加。

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
| relay 三包 | （暂无）手动 `publish:relay-stack` | — |

预发布用 npm dist-tag（如 `--tag beta`）；CI workflow 已按 tag 里的 `-beta`/`-rc` 后缀自动选 dist-tag。
