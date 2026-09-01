//
// init.go
// Copyright (C) 2026 veypi <i@veypi.com>
//
// Distributed under terms of the MIT license.
//

package vhtml

import (
	"crypto/sha1"
	"embed"
	"fmt"
	"io/fs"
	"os"
	"path"

	"github.com/veypi/vigo"
	"github.com/veypi/vigo/contrib/ufs"
	"github.com/veypi/vigo/utils"
)

var Router = vigo.NewRouter()

// embedETags 预计算 FS 的内容哈希 etag 表（path → quoted etag）。
// go:embed 文件 mtime 恒为零 → vigo 默认 etag（size+mtime）退化为尺寸函数，
// 同尺寸改动 304 假命中、发旧缓存内容（生产构建升级后浏览器不更新）。
// 启动时对 FS 全量哈希一次（文件在内存，成本可忽略），静态文件全部内容寻址。
func embedETags(fsys fs.FS) map[string]string {
	out := make(map[string]string)
	_ = fs.WalkDir(fsys, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		data, err := fs.ReadFile(fsys, p)
		if err != nil {
			return nil
		}
		out["/"+p] = fmt.Sprintf(`"%x"`, sha1.Sum(data))
		return nil
	})
	return out
}

//go:embed ui/*
var uifs embed.FS

//go:embed src/*
var srcfs embed.FS

//go:embed dist/vhtml.min.js
var vhtmljs string

// 为引用该库的提供vhtml.js静态服务
// 使用方法:
// 1. 后端扩充路由 Router.Extend("vhtml",vhtml.Router)
// 2. 前端引用: <script type="module" key='vhtml' src="/vhtml/vhtml.min.js"></script>
func init() {
	current := utils.CurrentDir(0)
	debug := os.Getenv("debug")
	renderEnv := func(x *vigo.X) {
		x.Header().Set("vhtml-scoped", Router.String())
		x.Header().Set("vhtml-debug", debug)
	}
	var lfs fs.FS
	if debug != "" && current != "" {
		Router.Get("vhtml.min.js", func(x *vigo.X) { _ = x.File(path.Join(utils.CurrentDir(0), "src", "index.js")) })
		srcfs, _ := ufs.NewLocalFS(path.Join(current, "src"))
		uifs, _ := ufs.NewLocalFS(path.Join(current, "ui"))
		lfs = ufs.NewMultiFS(srcfs, uifs)
	} else {
		Router.Get("vhtml.min.js", func(x *vigo.X) {
			x.Header().Set("content-type", "text/javascript; charset=utf-8")
			_, _ = x.Write([]byte(vhtmljs))
		})
		srcfs, _ := ufs.NewEmbedFS(srcfs, "src")
		uifs, _ := ufs.NewEmbedFS(uifs, "ui")
		lfs = ufs.NewMultiFS(srcfs, uifs)
		Router.Get("/{path:*}", renderEnv, ufs.NewHandler(&lfs, ufs.WithSpa("root.html", nil, func() map[string]any { return map[string]any{"scoped": Router.String()} }), ufs.WithETagCache(embedETags(lfs))))
		return
	}
	Router.Get("/{path:*}", renderEnv, ufs.NewHandler(&lfs, ufs.WithSpa("root.html", nil, func() map[string]any { return map[string]any{"scoped": Router.String()} })))
}

// SPAHandler 构建 SPA 壳 handler（root.html 模板 + scoped 注入 + env 响应头 +
// embed 内容哈希 etag）。两个用途：WrapUI 的 /{path:*} fallback；UI 属主包直接
// 取得后注入动态文件路由做文档导航回落（如 aic/skills 包文件：页面 URL 与文件
// URL 同址，直达/刷新时发壳，组件 loader 带 X-No-Fallback 重取走原样分支）。
//
// 调用约定同 WrapUI：须由 UI 属主包直接调用（debug 模式按调用方目录磁盘直读
// ui/，CurrentDir(1) 取的是本函数的调用方）。
func SPAHandler(router vigo.Router, uiFS embed.FS, args ...string) func(*vigo.X) {
	return spaHandler(router, uiFS, utils.CurrentDir(1), args...)
}
// SpaConfig 导出 SPA 壳的 ufs.WithSpa 三元配置（壳文件名、壳内容、scoped 注入
// resolver），供需要"文件优先 + 目录/缺失对浏览器导航成壳"协商语义的 UFS handler
// 直接挂载（如 aic /fs/cloud 文件服务：文件直出不变；目录/缺失的导航回落壳，raw
// 仍 JSON/404）。SPAHandler 是其成品 handler 封装（含 env 响应头）。content 非 nil
// 时 handler 不读自身 FS——/fs/cloud 的 FS 是用户 UFS，里面没有 root.html。
//
// 调用约定同 SPAHandler：须由 UI 属主包直接调用（debug 模式按调用方目录磁盘直读
// ui/，CurrentDir(1) 取的是本函数的调用方）。壳内容在配置构建时一次性读入（与
// UFS handler 首次请求 resolveSpa 等价）；debug 下改 root.html 需重启才反映到
// 该挂载点（WrapUI 本体走 handler FS 直读，不受影响）。
func SpaConfig(router vigo.Router, uiFS embed.FS) (string, []byte, func() map[string]any) {
	attrsFn := func() map[string]any { return map[string]any{"scoped": router.String()} }
	debug := os.Getenv("debug")
	current := utils.CurrentDir(1)
	if debug != "" && current != "" {
		if b, err := os.ReadFile(path.Join(current, "ui", "root.html")); err == nil {
			return "root.html", b, attrsFn
		}
	}
	if b, err := fs.ReadFile(uiFS, "ui/root.html"); err == nil {
		return "root.html", b, attrsFn
	}
	// 保守回落：content=nil 交还 handler 从自身 FS 读（找不到则 warn 关闭 SPA）。
	return "root.html", nil, attrsFn
}

func WrapUI(router vigo.Router, uiFS embed.FS, args ...string) vigo.Router {
	router.Get("/{path:*}", spaHandler(router, uiFS, utils.CurrentDir(1), args...))
	return router
}

func spaHandler(router vigo.Router, uiFS embed.FS, current string, args ...string) func(*vigo.X) {
	debug := os.Getenv("debug")
	renderEnv := func(x *vigo.X) {
		x.Header().Set("vhtml-scoped", router.String())
		x.Header().Set("vhtml-debug", debug)
		for i := 0; i < len(args); i += 2 {
			x.Header().Set("vhtml-"+args[i], args[i+1])
		}
		if debug != "" {
			x.Header().Set("Cache-Control", "no-cache")
		}
	}
	var lfs fs.FS
	var err error
	var fileHandler func(*vigo.X)
	if debug != "" && current != "" {
		// debug：磁盘直读，mtime 真实，默认 etag（size+mtime）即可——
		// 且文件实时编辑，内容哈希表反而会冻住 etag。
		lfs, err = ufs.NewLocalFS(path.Join(current, "ui"))
		if err != nil {
			panic(err)
		}
		fileHandler = ufs.NewHandler(&lfs, ufs.WithSpa("root.html", nil, func() map[string]any {
			return map[string]any{"scoped": router.String()}
		}))
	} else {
		lfs, err = ufs.NewEmbedFS(uiFS, "ui")
		if err != nil {
			panic(err)
		}
		// embed：mtime 恒为零 → 内容哈希 etag（embedETags 注释见函数头）。
		fileHandler = ufs.NewHandler(&lfs, ufs.WithSpa("root.html", nil, func() map[string]any {
			return map[string]any{"scoped": router.String()}
		}), ufs.WithETagCache(embedETags(lfs)))
	}
	// 路由链上的多个 handler 本就是顺序调用，包成单闭包等价（renderEnv 写响应头，
	// fileHandler 写体）。
	return func(x *vigo.X) {
		renderEnv(x)
		fileHandler(x)
	}
}
