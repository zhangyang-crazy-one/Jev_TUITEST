# Jev_TUITEST

DeepSeek Harness 的独立 TUI Plugins、HUD 和 PTY 回归测试包。测试代码依赖 deepseek-harness 的源码、工作区依赖和测试配置；它不是单独发布的 npm 包。

## 本地运行

先准备一个包含 TUI Plugins/HUD 实现的 deepseek-harness 源码检出，并安装它的依赖。再从本仓库运行：

```sh
./scripts/test.sh /path/to/deepseek-harness
```

脚本会把 `overlay/` 下的测试和快照文件复制到源码检出，然后运行控制器/渲染器、PTY 和录制会话测试。请把干净、可丢弃的源码检出作为参数；同路径文件会被测试 overlay 覆盖。

## GitHub Actions

在 Actions 中手动运行 **TUI regression suite**，并填写 `source_ref`，指向包含 Plugins/HUD 实现的 `zhangyang-crazy-one/deepseek-harness` 分支或提交。工作流会检出源码、安装锁定依赖、应用测试 overlay 并运行同一组命令。测试使用 mock LLM 和录制 Session，不需要 API 密钥。

`overlay-files.txt` 是测试 overlay 的文件清单。涉及代码变更时，请从 `deepseek-harness` 更新对应文件，并保留上游的 MIT 许可与测试快照脱敏规则。
