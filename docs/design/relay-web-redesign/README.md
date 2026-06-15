# relay-web 重设计 · 设计探索存档

xacpx 品牌化看板重设计的高保真 mockup 探索（2026-06-15）。

- **规范（唯一依据）**：[`docs/superpowers/specs/2026-06-15-relay-web-redesign-design.md`](../../superpowers/specs/2026-06-15-relay-web-redesign-design.md)
- **对比页**：本地浏览器打开 `index.html`（顶部切换方案，右上角切暗/浅）。

## 方案

| | 文件 | 方向 |
|---|---|---|
| A | `variant-a-terminal.html` | Terminal / OLED（ui-ux-pro-max 推荐，Fira Code，运行绿辉光） |
| B | `variant-b-linear.html` | Linear / Product（Inter，靛蓝，柔阴影精致 SaaS） |
| C | `variant-c-focused.html` | Focused / Calm（暖中性 + 青，对话为中心） |
| D | `variant-d-converged.html` | B 结构 + C 暖青配色 + 收紧密度 |
| **E ★** | `variant-e-xacpx.html` | **最终方向**：D 结构 + xacpx 品牌蓝绿（冷调近黑/清透白，蓝=交互、调暗绿=运行），SVG X logo，更紧 |

`xacpx-brand-banner.png` 为品牌取色来源（蓝 `#4F9BF5` → 绿 `#69D689`）。

> mockup 为 Tailwind-CDN 静态原型，仅用于视觉定稿；实现走项目 Vue 3 + Tailwind 组件 + token 体系。实现时 **Send 按钮改纯蓝实色（去渐变），渐变仅留 logo**。
