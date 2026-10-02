# Relay Web · 实例桌面 Phase B(macOS ARD)实施计划(草案)

> 状态:**草案,未启动。** 需先完成设计评审(见 2026-10-02 design 文档 §5 的三个未决决策)。
>
> 日期:2026-10-02。
>
> 设计依据:docs/superpowers/specs/2026-10-02-relay-web-desktop-phase-b-macos-ard-design.md
>
> 上游:docs/superpowers/plans/2026-09-24-relay-web-desktop-rfb.md(Phase A 计划及其 §12 占位)

## 0. 此文档的定位

这是**排期与分解草案**,不是可执行工单。三个前置决策未定稿前不要开工:

1. capability 表达(`desktop.ard.v1` vs prepare result `security: "ard"`);
2. handshake 重放范围;
3. 凭据输入通道形态。

每一条对应 design 文档 §5。开工前按 design §5 逐条取得 review 结论,并把结论回填到本文档,
再进入 Task 划分。

## 1. 建议的分解(取决于上面三个决策)

按 Phase A 的同类分层,预计为:

~~~text
Task 1  协议与 DTO补充(credential 生命周期字段、ARD 错误码归类)
Task 2  desktop stream gateway(单 stream 预约与 owner 状态机,与 Phase A 同构)
Task 3  channel-relay:ARD 握手(core 之外),loopback/dedicated credential handling
Task 4  relay-web:ARD credential UI 与 noVNC 对已认证 stream 的续接
Task 5  硬用例集成测试(含 secret redaction)
Task 6  macOS/docs:平台 setup 文档与"Windows lock/UAC、macOS ARD"边界说明
~~~

Task 边界与 Phase A §1–§7 一一对应,并把 Task 3 的安全审查单列。

## 2. 安全审查必须覆盖的点

- connector-side ARD 握手(security type 相关代码)单独 review;
- 凭据不落盘/不入 URL/不入 log/不入 audit/不入 RPC result,每一点都有测试;
- 凭据单次使用与短生命周期(与 prepare deadline 对齐);
- 失败路径:凭据被拒 vs 平台权限不足必须分开归类;
- macOS 权限(如 Screen Recording)缺口的诊断可读;
- 已认证的 RFB stream 之后,原 Phase A 的 banner revalidation 与 socket 生命周期 guard 继续成立。

## 3. 明确推迟 / 不做

- multi-view(Phase C,需 server-side RFB view-only parser/filter);
- managed setup;
- 自动 clipboard 同步、文件传输、framebuffer 录像;
- 任意 TCP tunnel / 公网端口暴露。

## 4. Phase A 回归要求

Phase B 合并前必须满足 Phase A 的验收标准不变:

- Phase A 的 `tests/unit/packages/channel-relay/desktop*` 全部为绿;
- hardgate(instance-offline 重启清理、大流量隔离)不回归;
- Linux/Windows VncAuth 流程逐字节不变。

## 5. 上线顺序风险

macOS ARD 依赖 RFB handshake 重写,是 Phase A 设计中明确标记为"必须单独 review"的
最高风险项。建议先只交付 design 层面共识,再开 implementation PR;不要在未取得三项
决策结论的情况下带 runtime code 进 review。
