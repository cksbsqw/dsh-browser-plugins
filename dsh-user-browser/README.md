# dsh-user-browser

一个轻量的 DeepSeek Harness Host 插件：在用户的**默认浏览器**中打开新标签页和执行网页搜索。

它与 [`dsh-browser-automation`](../dsh-browser-automation/) 的区别：

- 本插件调用系统默认浏览器（尊重用户已有的登录态、扩展和设置），但不读取页面内容；
- `dsh-browser-automation` 驱动一个独立的自动化窗口，能读取和操作页面。

## 工具

| 工具 | 说明 |
|---|---|
| `browser_open` | 在默认浏览器中打开 1–10 个 URL，每个一个新标签页 |
| `browser_search` | 打开搜索结果页，支持 Bing、百度、Google、DuckDuckGo、搜狗 |

只接受 `http(s)` URL；裸域名会自动补 `https://`。

## 安装

```text
plugin_manager install_bundle
target: <本目录的绝对路径>
```

`cordis.patch.yml`：

```yaml
- insert:
    - id: user-browser
      name: dsh-user-browser
```

## 配置

插件没有声明严格的 Config schema，以下字段可选：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `browserPath` | 系统默认浏览器 | 指定浏览器可执行文件 |
| `defaultEngine` | `bing` | `browser_search` 的默认引擎 |

示例：

```yaml
- insert:
    - id: user-browser
      name: dsh-user-browser
      config:
        defaultEngine: baidu
```

## 实现

- 通过 `rundll32 url.dll,FileProtocolHandler` 把 URL 交给系统默认浏览器（Windows）；
- macOS 使用 `open`，Linux 使用 `xdg-open`；
- 不读取页面、不注入脚本。

## License

未指定。使用前请与仓库所有者确认授权范围。
