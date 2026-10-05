//
// dev.go
// Copyright (C) 2026 veypi <i@veypi.com>
//
// Distributed under terms of the MIT license.
//

package vhtml

import (
	"embed"
	"io/fs"
	"os"
	"path"

	"github.com/veypi/vigo"
	"github.com/veypi/vigo/contrib/ufs"
	"github.com/veypi/vigo/utils"
)

// FrameworkRouter 返回 vhtml 运行时资源路由，供 vhtml CLI dev server 挂载（如 /vhtml 前缀）：
//
//	vhtml.min.js   框架入口。srcMode=false → 内嵌 dist 打包版；srcMode=true → src/index.js（模块直读调试）
//	/{path:*}      dist 分块与依赖；srcMode 另提供 src 目录下的模块文件
//
// srcMode 下优先读本地 src/dist，目录不存在时回落内嵌资源。
func FrameworkRouter(srcMode bool) vigo.Router {
	r := vigo.NewRouter()
	r.Get("vhtml.min.js", MinJSHandler(srcMode))
	fsys := frameworkFS(srcMode, utils.CurrentDir(0))
	r.Get("/{path:*}", ufs.NewHandler(&fsys, ufs.WithCacheControl("no-cache")))
	return r
}

func resourceFS(embedded embed.FS, dir, current string) fs.FS {
	if current != "" {
		local := path.Join(current, dir)
		if st, err := os.Stat(local); err == nil && st.IsDir() {
			if lfs, err := ufs.NewLocalFS(local); err == nil {
				return lfs
			}
		}
	}
	fsys, err := fs.Sub(embedded, dir)
	if err != nil {
		panic(err)
	}
	return fsys
}

func frameworkFS(srcMode bool, current string) fs.FS {
	if !srcMode {
		return resourceFS(distfs, "dist", "")
	}
	// Built vendor entries must precede the npm-facing source wrappers. Keep
	// framework modules live from src, while browsers only see relative imports.
	return ufs.NewMultiFS(resourceFS(distfs, "dist", current), resourceFS(srcfs, "src", current))
}

// MinJSHandler 输出框架入口 JS（srcMode 语义同 FrameworkRouter）。
func MinJSHandler(srcMode bool) func(*vigo.X) {
	fsys := frameworkFS(srcMode, utils.CurrentDir(0))
	entry := "vhtml.min.js"
	if srcMode {
		entry = "index.js"
	}
	return func(x *vigo.X) {
		x.Header().Set("cache-control", "no-cache")
		data, err := fs.ReadFile(fsys, entry)
		if err != nil {
			x.WriteHeader(404)
			return
		}
		x.Header().Set("content-type", "text/javascript; charset=utf-8")
		_, _ = x.Write(data)
	}
}
