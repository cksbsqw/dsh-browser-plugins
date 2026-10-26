# DSH 浏览器插件集

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的两个 Host 插件，让智能体能够使用你的浏览器。

| 插件 | 能力 | 适用场景 |
|---|---|---|
| [`dsh-browser-automation`](dsh-browser-automation/) | 通过 CDP 驱动一个可登录的 Edge/Chrome 窗口：读取页面、快照、点击、输入、截图、标签、上传、下载 | 需要读取/操作登录后的页面，例如课程平台、后台系统 |
| [`dsh-user-browser`](dsh-user-browser/) | 在系统默认浏览器中打开新标签页和执行搜索 | 只想把某个页面或搜索结果展示给用户 |

## 环境要求

- Windows 10/11（自动化插件的浏览器路径发现逻辑面向 Windows）
- 已安装 Microsoft Edge 或 Google Chrome
- DeepSeek Harness Desktop，或带 Host 的 DSH profile
- Node.js 22+（DSH 内置运行时即可；两个插件都没有第三方依赖）

## 安装

分别把插件目录作为 bundle 安装到当前 DSH profile：

```text
plugin_manager install_bundle
target: <仓库目录>/dsh-browser-automation
```

```text
plugin_manager install_bundle
target: <仓库目录>/dsh-user-browser
```

安装后按提示重启或刷新；插件会注册对应的 `browser_*` 工具。

## 目录结构

```
dsh-browser-automation/
  index.js            # CDP 自动化与 11 个工具
  cordis.patch.yml
  locale/{zh,en}.json
  icon.svg
  README.md
dsh-user-browser/
  index.js            # 默认浏览器标签页与搜索
  cordis.patch.yml
  locale/{zh,en}.json
  icon.svg
  README.md
```

## 安全提示

- 自动化插件会在本机 `127.0.0.1:9333` 开启 CDP 端口；本机任意进程都能连接并控制该浏览器。不用时请关闭自动化窗口。
- 自动化插件使用独立的浏览器配置目录保存登录态；该目录中的 Cookie 等同于登录会话，不要拷贝给他人。
- 两个插件都不会绕过验证码；需要人工在可见窗口中完成。
- 请遵守目标网站的服务条款和自动化政策。

## License

未指定。使用前请与仓库所有者确认授权范围。
