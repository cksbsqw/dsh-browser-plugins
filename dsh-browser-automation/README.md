# dsh-browser-automation

一个面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Host 插件：通过 Chrome DevTools Protocol（CDP）驱动一个**真实的、可登录的 Edge/Chrome 窗口**，让智能体能够读取页面、点击、输入、截图、切换标签、上传和下载。

它使用独立的持久化用户配置目录，首次登录后 Cookie 会保留，因此后续调用不需要重复登录。验证码、短信验证等必须由人工在可见窗口中完成。

## 能力

| 工具 | 说明 |
|---|---|
| `browser_goto` | 打开 URL 并等待加载，可新开标签 |
| `browser_read` | 读取页面可见文字，包含 iframe |
| `browser_snapshot` | 列出标题与可交互元素，返回稳定 ref（如 `f1r2`） |
| `browser_click` | 按 ref、CSS 选择器或视口坐标 x/y 点击 |
| `browser_type` | 向 input/textarea/contenteditable 输入，可回车提交 |
| `browser_press` | Enter、Tab、Esc、方向键、PageDown 等 |
| `browser_scroll` | 在视口中心发送滚轮事件，支持嵌套 iframe |
| `browser_screenshot` | 截图保存到工作区 `.dsh-browser/screenshots` |
| `browser_tabs` | 列出 / 切换 / 关闭 / 新建标签 |
| `browser_upload` | 给 `<input type="file">` 附加本地文件 |
| `browser_download` | 带登录 Cookie 下载到配置的下载目录 |

## 环境要求

- Windows（当前实现使用 Edge/Chrome 的 Windows 安装路径）
- DeepSeek Harness Desktop / 带 Host 的 DSH profile
- Microsoft Edge 或 Google Chrome
- Node.js 22+（Host 内置即可，插件无第三方依赖）

## 安装

作为 bundle 安装到当前 DSH profile：

```text
plugin_manager install_bundle
target: <本目录的绝对路径>
```

或在 `cordis.patch.yml` 中插入：

```yaml
- insert:
    - id: browser-automation
      name: dsh-browser-automation
      config:
        port: 9333
        # userDataDir: 'C:\Users\<you>\AppData\Local\dsh-browser-profile'
        # downloadDir: 'C:\Users\<you>\Downloads\dsh-browser'
        # browserPath: 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
        # headless: false
```

插件没有声明严格的 Config schema，以上字段都可省略，使用默认值。

## 配置

| 字段 | 默认值 | 说明 |
|---|---|---|
| `port` | `9333` | 本机 CDP 调试端口 |
| `userDataDir` | `%LOCALAPPDATA%\dsh-browser-profile` | 独立的浏览器配置目录，保存登录态 |
| `downloadDir` | `%USERPROFILE%\Downloads\dsh-browser` | 自动化下载目录 |
| `browserPath` | 自动查找 Edge/Chrome | 浏览器可执行文件 |
| `headless` | `false` | 无头模式（首次登录不建议） |

## 安全与限制

- CDP 端口只绑定 `127.0.0.1`，但**本机任意进程**都能连接并控制该浏览器；不用时请关闭自动化窗口。
- 启动参数**没有**使用 `--remote-allow-origins=*`，网页无法通过 localhost WebSocket 接管浏览器。
- 自动化配置目录中的 Cookie 等同于一份登录会话，请不要把该目录拷贝给他人。
- 平台可能对自动化访问有风控或条款限制；请遵守目标网站的使用规则。
- 验证码、滑块、短信验证必须人工完成。
- Canvas 内容或跨进程 iframe 可能只能通过截图 + 坐标点击处理。

## 开发

纯 ESM、无构建步骤、无运行时依赖：

```
index.js            # 插件入口与 11 个工具
cordis.patch.yml    # bundle 插入行
locale/zh.json      # 中英文元数据
locale/en.json
icon.svg
```

修改后重载插件（或在 DSH 中重新安装）即可生效。

## License

未指定。使用前请与仓库所有者确认授权范围。
