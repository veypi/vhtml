//
// serve.go
// Copyright (C) 2026 veypi <i@veypi.com>
//
// Distributed under terms of the MIT license.
//

package main

import (
	"bytes"
	"fmt"
	"html/template"
	"net/http"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/veypi/vhtml"
	"github.com/veypi/vigo"
	"github.com/veypi/vigo/contrib/proxy"
)

func serve(cfg *Config) error {
	uiDir, err := filepath.Abs(cfg.UI)
	if err != nil {
		return err
	}
	st, err := os.Stat(uiDir)
	if err != nil || !st.IsDir() {
		return fmt.Errorf("前端目录 %s 不存在（先执行 vhtml init 创建项目骨架）", uiDir)
	}

	root := vigo.NewRouter()

	// vhtml 框架运行时资源：/vhtml/vhtml.min.js + src 模块（--src 模式）
	root.Extend("vhtml", vhtml.FrameworkRouter(cfg.Src))
	// 兼容 root.html 以 {{.scoped}}/vhtml.min.js（scoped 为空）引用框架的场景
	root.Get("vhtml.min.js", vhtml.MinJSHandler(cfg.Src))

	// live reload
	var hub *reloadHub
	if cfg.Reload {
		hub = newReloadHub()
		root.Get("__vhtml_dev_events", hub.serveHTTP)
		if err := hub.watch(uiDir); err != nil {
			return fmt.Errorf("启动文件监听失败: %w", err)
		}
	}

	// API 代理（路径前缀 → 后端）
	prefixes := make([]string, 0, len(cfg.Proxy))
	for p := range cfg.Proxy {
		prefixes = append(prefixes, p)
	}
	sort.Strings(prefixes)
	for _, p := range prefixes {
		h, err := proxy.New(cfg.Proxy[p])
		if err != nil {
			return fmt.Errorf("proxy %s: %w", p, err)
		}
		pp := "/" + strings.Trim(p, "/")
		root.Get(pp+"/{path:*}", h)
		root.Get(pp, h)
	}

	// 用户前端目录：静态文件 + SPA 回退
	root.Get("/{path:*}", uiHandler(uiDir, hub != nil))

	server, err := vigo.NewServer(vigo.WithHost(cfg.Host), vigo.WithPort(cfg.Port))
	if err != nil {
		return err
	}
	server.SetRouter(root)

	printBanner(cfg, uiDir, prefixes)
	if cfg.Open {
		go openBrowser(fmt.Sprintf("http://%s/", server.Addr()))
	}
	return server.Run()
}

// uiHandler 静态服务 ui 目录；浏览器 HTML 请求 miss 时回退渲染 root.html（SPA）。
// 所有内容每次请求直读磁盘（dev server 语义），root.html 变更即时生效。
func uiHandler(uiDir string, reload bool) func(*vigo.X) {
	fileServer := http.FileServer(http.Dir(uiDir))
	return func(x *vigo.X) {
		w, r := x.ResponseWriter(), x.Request
		upath := path.Clean("/" + strings.TrimPrefix(r.URL.Path, "/"))
		full := filepath.Join(uiDir, filepath.FromSlash(upath))

		st, err := os.Stat(full)
		switch {
		case err == nil && !st.IsDir():
			fileServer.ServeHTTP(w, r)
		case err == nil && st.IsDir():
			if _, ierr := os.Stat(filepath.Join(full, "index.html")); ierr == nil {
				// 目录自带 index.html
				fileServer.ServeHTTP(w, r)
			} else if acceptsHTML(r) {
				serveRootHTML(w, uiDir, reload)
			} else {
				// 目录列表（dev 场景方便浏览）
				fileServer.ServeHTTP(w, r)
			}
		case acceptsHTML(r):
			serveRootHTML(w, uiDir, reload)
		default:
			http.NotFound(w, r)
		}
	}
}

func acceptsHTML(r *http.Request) bool {
	return strings.Contains(r.Header.Get("Accept"), "text/html")
}

// 内置兜底 root.html：用户未提供时使用，最小项目只需 routes.js + page/。
const builtinRootHTML = `<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>vhtml app</title>
</head>
<body>
  <vrouter></vrouter>
</body>
<script type="module">
  import VHTML from "/vhtml/vhtml.min.js"
  window.$vhtml = new VHTML(document.body, "")
</script>
</html>
`

// serveRootHTML 每次请求直读 ui/root.html 并渲染（scoped="" + reload 脚本注入）。
func serveRootHTML(w http.ResponseWriter, uiDir string, reload bool) {
	data, err := os.ReadFile(filepath.Join(uiDir, "root.html"))
	if err != nil {
		data = []byte(builtinRootHTML)
	}
	data = renderRoot(data, reload)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = w.Write(data)
}

// renderRoot 执行 Go 模板（提供 {{.scoped}}），随后按需注入 reload 脚本。
// 模板解析/执行失败时回落为原始内容（root.html 中可能含 vhtml 的 {{ }} 语法）。
func renderRoot(data []byte, reload bool) []byte {
	if tmpl, err := template.New("root.html").Parse(string(data)); err == nil {
		var buf bytes.Buffer
		if err := tmpl.Execute(&buf, map[string]any{"scoped": ""}); err == nil {
			data = buf.Bytes()
		}
	}
	if reload {
		data = injectReloadScript(data)
	}
	return data
}

// reloadScript 经 SSE 接收 reload 事件并刷新页面。
const reloadScript = `<script>(function(){var es=new EventSource("/__vhtml_dev_events");es.onmessage=function(e){if(e.data==="reload")location.reload()};})();</script>`

// injectReloadScript 把 reload 脚本注入到最后一个 </body> 前，无 </body> 则追加到末尾。
func injectReloadScript(data []byte) []byte {
	s := string(data)
	idx := strings.LastIndex(strings.ToLower(s), "</body>")
	if idx < 0 {
		return []byte(s + reloadScript)
	}
	return []byte(s[:idx] + reloadScript + s[idx:])
}

func printBanner(cfg *Config, uiDir string, prefixes []string) {
	host := cfg.Host
	if host == "0.0.0.0" {
		host = "127.0.0.1"
	}
	fmt.Printf("\n  vhtml %s  dev server\n\n", version)
	fmt.Printf("  ➜ Local:  http://%s:%d/\n", host, cfg.Port)
	fmt.Printf("  ➜ UI:     %s\n", uiDir)
	if cfg.Reload {
		fmt.Printf("  ➜ Reload: live reload enabled\n")
	}
	for _, p := range prefixes {
		fmt.Printf("  ➜ Proxy:  %s → %s\n", p, cfg.Proxy[p].Target)
	}
	fmt.Println()
}

func openBrowser(url string) {
	time.Sleep(300 * time.Millisecond)
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	_ = cmd.Start()
}
