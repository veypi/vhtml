//
// config.go
// Copyright (C) 2026 veypi <i@veypi.com>
//
// Distributed under terms of the MIT license.
//

package main

import (
	"github.com/veypi/vhtml/cli/vhtml/i18n"
	"github.com/veypi/vigo/contrib/proxy"
)

// configFile 项目配置文件名，固定从当前工作目录读取（约定优于配置）。
const configFile = "vhtml.config.json"

// Config vhtml.config.json 的根结构。
//
// 配置加载遵循 vigo/flags 原生协议，优先级：flag > 环境变量 > 配置文件 > default 标签。
// 已知限制：default 为 true 的 bool 字段（reload）无法经配置文件关闭，
// 请用 --reload=false 或环境变量 RELOAD=false（flags 包默认值注册语义所致）。
type Config struct {
	Port   int                    `json:"port" desc:"dev server 监听端口" default:"3000" short:"p"`
	Host   string                 `json:"host" desc:"dev server 监听地址" default:"127.0.0.1"`
	UI     string                 `json:"ui" desc:"前端目录（静态服务根）" default:"./ui"`
	Reload bool                   `json:"reload" desc:"文件变更自动刷新页面（live reload）" default:"true"`
	Src    bool                   `json:"src" desc:"vhtml 框架走 src 模块直读（框架调试）"`
	Open   bool                   `json:"open" desc:"启动后自动打开浏览器" short:"o"`
	Proxy  map[string]*proxy.Rule `json:"proxy" desc:"API 代理表：路径前缀 → 后端地址或规则对象"`
	I18n   i18n.Config            `json:"i18n"`
}
