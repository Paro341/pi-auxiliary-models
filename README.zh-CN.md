# pi-auxiliary-models（辅助模型扩展）

> 给 [Pi](https://github.com/earendil-works/pi-coding-agent) 雇两位「专职外援」：一位**看图**，一位**压长文**。只读、显式、成本可见。
>
> [English README](./README.md)

---

## 这是什么？

你的 Pi 主模型不是样样精通：它可能是**纯文本模型**（看不了图），也可能**吃上下文**（长文档把窗口撑爆）。本扩展在不改动主模型的前提下，随时请一位外援补位。

- ✅ **只读**——外援没有工具，读不了你的文件、不能执行命令，只接收你交给它的图片/文本
- ✅ **显式**——每次调用都要你点名或预先配置，绝不偷偷运行
- ✅ **可控**——目录策略、调用次数、超时、大小上限，全部可配置
- ✅ **可见**——状态条实时显示用了谁、花了多少

## 快速上手

```text
/aux status             # 查看当前配置与路由
/aux vision             # 看图（跟随主模型；主模型不能看则自动回退）
/aux extract            # 压长文（把长文本压缩成摘要）
```

固定模型时会弹出选择器：输入 `>` 加关键词实时搜索（如 `> deepseek`），按 Tab 切换「全部模型 / 会话可用」。

## 安装

从 GitHub 安装（需有本私有仓访问权限）：

```bash
pi install git:github.com/Paro341/pi-auxiliary-models
```

或让 Pi 直接指向本地源码（如在开发阶段）：

```jsonc
// ~/.pi/agent/settings.json  或  <项目>/.pi/settings.json
{ "extensions": ["D:/FSCode/AgentEPS/pi/extensions/pi-auxiliary-models/extensions/auxiliary-models.ts"] }
```

## 命令一览

| 命令 | 作用 |
|---|---|
| `/aux` | 打开可视化配置向导 |
| `/aux status` | 查看配置、路由、有效模型 |
| `/aux vision <provider>/<id>` | 固定看图模型（如 `ollama-cloud/gemma4:31b`） |
| `/aux vision`（无参） | 看图恢复跟随主模型 |
| `/aux extract <provider>/<id>` | 固定压长文模型 |
| `/aux extract`（无参） | 压长文恢复跟随主模型 |
| `/aux allow <目录>` / `/aux disallow <目录>` | 管理允许的图片目录 |
| `/aux policy roots` / `/aux policy unrestricted` | 限目录 / 不限目录（默认） |

## 核心概念

### 角色（Roles）

两个互不干扰的「岗位」：

| 角色 | 命令 | 干什么 | 默认路由 |
|---|---|---|---|
| **看图**（Vision） | `/aux vision` | 描述图片、识别内容 | 跟随主模型；主模型不能看则回退 |
| **压长文**（Extract） | `/aux extract` | 把长文本压缩成摘要 | 跟随主模型 |

### 目录策略（pathPolicy）

看图前会检查图片路径：

- **`unrestricted`（不限，默认）**——任何路径都能看；与主模型的全盘访问对齐
- **`roots`（限目录）**——只允许当前工作目录 + `allowedRoots` 里列的目录；目录外的图每次需你确认

> 这是一道「防手滑」护栏，不是安全边界——主模型本来就能读全盘。

## 配置

文件：`~/.pi/agent/auxiliary-models.json`（用户目录优先；仅当无用户配置时才用包目录）。

```jsonc
{
  "enabled": true,                     // 总开关
  "defaults": {
    "timeoutMs": 60000,                // 单次调用超时
    "maxOutputTokens": 2048,           // 单次输出上限
    "maxInputChars": 50000,            // 单次输入上限
    "maxCallsPerTurn": 2               // 每轮最多调用外援次数
  },
  "roles": {
    "vision": {
      "mode": "default",               // "default"=跟随 / "pinned"=固定
      "model": null,                   // pinned 时填 {provider, id}
      "assertImageCapable": false,     // 固定时是否强制校验「能看图」
      "fallbacks": [                   // 主模型看不了图时的回退
        { "provider": "ollama-cloud", "id": "gemma4:31b" }
      ],
      "maxImageBytes": 8388608,        // 图片大小上限（缩放后）
      "pathPolicy": "unrestricted",    // "unrestricted" | "roots"
      "allowedRoots": []               // roots 模式下的允许目录
    },
    "extract": { "mode": "default", "model": null }
  }
}
```

## 错误码

| 错误码 | 含义 |
|---|---|
| `IMAGE_NOT_FOUND` | 路径不存在/读不了 |
| `IMAGE_OUT_OF_ROOT` | 不在允许目录内（roots 模式） |
| `IMAGE_UNSUPPORTED_TYPE` | 不是受支持的图片格式 |
| `IMAGE_TOO_LARGE` | 缩放后仍超上限 |
| `ROLE_DISABLED` | 看图角色被关闭 |
| `PINNED_MODEL_UNAVAILABLE` | 固定模型不可用/未鉴权 |
| `PINNED_MODEL_NOT_VISION` | 固定的模型不能看图 |
| `NO_VISION_FALLBACK` | 主模型不能看图且无回退 |
| `BUDGET_EXCEEDED` | 本轮调用次数超限 |
| `INPUT_TOO_LARGE` | 文本超输入上限 |
| `TIMEOUT` / `ABORTED` | 超时 / 取消 |
| `UPSTREAM_ERROR` | 模型提供商出错 |
| `CONFIG_INVALID` | 配置无效（保留上一份有效配置） |

## 已知限制

- 辅助调用**不触发** Pi 的 `before_provider_request` 等审计事件（直连 `modelRegistry.complete()`）
- 某些网关（如 `opencode-go`）会**丢图**（2/2 视觉模型失败）；建议走原厂网关
- 个别模型路由返回**空内容**（如 `openrouter/google/gemini-3.6-flash`）——属上游问题
- 扩展入口 `.ts` 无回归测试；可测逻辑在 `lib/*.mjs`（42/42 测试）

## 目录与开发

```
extensions/auxiliary-models.ts   入口（UI/footer/向导/命令）
lib/auxiliary-models-core.mjs    校验/路由/错误码（单一事实源）
lib/auxiliary-models-runner.mjs  调用封装（超时/预算/并发闸）
lib/auxiliary-models-image.mjs   图片校验链
lib/auxiliary-models-command.mjs 命令解析/状态文本/补全
docs/                           中英使用说明书
sync-to-global.sh               同步源码到 ~/.pi/agent（parse gate + 备份 + 复制）
```

- 路由决策一律走 `resolveValidatedRole`（core.mjs）
- 配置读写走 `resolveConfigPath`：用户目录优先，包目录兜底
- 每次改 `.ts` 后必须跑 parse gate（防止半成品扩展拖垮所有新窗口）
- 测试：`node --test tests/*.test.mjs`

## 特别鸣谢
- GPT 5.6 Terra
- DeepSeek V4 Flash:0731
- Gemma4 31B

## License

MIT