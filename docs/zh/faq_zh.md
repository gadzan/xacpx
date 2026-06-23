# 常见问题

## `/ss new` 失败怎么办？

如果你在微信里创建会话失败，最常见的情况不是 `xacpx` 命令格式错了，而是底层会话没有成功创建。

你可以先试这两步：

1. 在终端里确认当前项目目录和 agent 本身可用
2. 如果你熟悉 `acpx`，先手动创建一个会话，再在微信里挂回去

例如，你可以先在本地创建一个会话：

```bash
./node_modules/.bin/acpx --verbose --cwd /absolute/workspace/path codex sessions new --name existing-demo
```

然后在微信里把它挂回来：

```text
/ss attach demo -a codex --ws backend --name existing-demo
```

## `/mode <id>` 里的 `<id>` 是什么？

`/mode` 的可用值取决于你当前使用的 agent，`xacpx` 不会替你统一转换这些值。

当前比较明确的已知值：

- `codex`: `plan`
- `cursor`: `agent`、`plan`、`ask`

如果你不确定某个值能不能用，优先查对应 agent 的文档；如果填错，通常会直接收到无效参数之类的报错。
