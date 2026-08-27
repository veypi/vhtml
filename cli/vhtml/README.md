# vhtml CLI

vhtml 命令行工具：零构建前端开发服务器 + i18n 管理。只需前端文件（root.html / routes.js / page/*.html），无需写任何 Go 代码即可起服务。

## 安装

```bash
go install github.com/veypi/vhtml/cli/vhtml@latest
```

## 快速开始

```bash
vhtml init my-app    # 生成项目骨架
cd my-app
vhtml                # = vhtml serve，启动 dev server
```

打开 http://127.0.0.1:3000/ 即可。修改 `ui/` 下任意文件，浏览器自动刷新（live reload）。

## 命令

### serve（默认命令）

```bash
vhtml            # 等同 vhtml serve
vhtml serve -p 8080 --open
```

- 静态服务 `./ui` 目录（直读磁盘，改动即生效）
- 浏览器 HTML 请求 miss 时回退渲染 `ui/root.html`（SPA，`{{.scoped}}` = `""`）
- `/vhtml/vhtml.min.js` 提供框架运行时（内嵌于二进制）；`--src` 切换为 src 模块直读（vhtml 框架自身调试用）
- 文件变更经 SSE 推送 reload，脚本自动注入 root.html，对用户文件零侵入

### i18n

```bash
vhtml i18n scan                      # 扫描 $t key、排序、报告缺失/未引用（--autoremove 自动清理）
vhtml i18n add -json '{"zh-CN":{"k":"v"},"en-US":{"k":"v"}}'
echo '{"zh-CN":{"k":"v"}}' | vhtml i18n add
```

### init

```bash
vhtml init [dir]     # 生成 vhtml.config.json + ui/ 骨架，已存在的文件跳过
```

## 配置 vhtml.config.json

固定从当前目录读取，全部字段可选：

```json
{
  "port": 3000,
  "host": "127.0.0.1",
  "ui": "./ui",
  "reload": true,
  "proxy": {
    "/api": "http://127.0.0.1:8000",
    "/auth": { "target": "http://127.0.0.1:9000", "rewrite": { "^/auth": "" } }
  },
  "i18n": {
    "languages": ["zh-CN", "en-US"],
    "defaultLanguage": "zh-CN"
  }
}
```

- i18n 的扫描入口直接复用全局 `ui`（子命令可用 `-ui` 单次覆盖），翻译文件默认写到 `{ui}/langs.json`，只有特殊场景才需要配置 `i18n.output` 覆盖。

- proxy 值为字符串时等价于 `{"target": "..."}`；`rewrite` 为正则 → 替换（按 key 字典序依次应用），例：`{"^/api": ""}` 去除前缀。WebSocket 自动支持，无需配置。
- 配置优先级：flag > 环境变量（字段名大写，如 `PORT`、`I18N_ENTRY`）> `vhtml.config.json` > 内置默认。
- 已知限制：`reload` 默认 true，无法经配置文件关闭（vigo/flags 默认值注册语义），请用 `--reload=false` 或 `RELOAD=false`。

## 项目结构（init 生成）

```
my-app/
  vhtml.config.json
  ui/
    root.html        # 入口 HTML（引用 /vhtml/vhtml.min.js）
    routes.js        # 路由表
    langs.json       # 翻译文件
    page/
      index.html
      404.html
```
