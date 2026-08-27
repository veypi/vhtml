//
// dev.go
// Copyright (C) 2026 veypi <i@veypi.com>
//
// Distributed under terms of the MIT license.
//

package vhtml

import (
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
//	/{path:*}      仅 srcMode：src 目录下的模块文件（component.js 等，供 index.js 的相对导入）
//
// srcMode 下优先读包源目录（vhtml 本地开发实时生效），源目录不存在时回落内嵌 src。
func FrameworkRouter(srcMode bool) vigo.Router {
	r := vigo.NewRouter()
	r.Get("vhtml.min.js", MinJSHandler(srcMode))
	if srcMode {
		var fsys fs.FS
		if current := utils.CurrentDir(0); current != "" {
			if st, err := os.Stat(path.Join(current, "src")); err == nil && st.IsDir() {
				if lfs, err := ufs.NewLocalFS(path.Join(current, "src")); err == nil {
					fsys = lfs
				}
			}
		}
		if fsys == nil {
			efs, err := ufs.NewEmbedFS(srcfs, "src")
			if err != nil {
				panic(err)
			}
			fsys = efs
		}
		r.Get("/{path:*}", ufs.NewHandler(&fsys, ufs.WithCacheControl("no-cache")))
	}
	return r
}

// MinJSHandler 输出框架入口 JS（srcMode 语义同 FrameworkRouter）。
func MinJSHandler(srcMode bool) func(*vigo.X) {
	if !srcMode {
		return func(x *vigo.X) {
			x.Header().Set("content-type", "text/javascript; charset=utf-8")
			x.Header().Set("cache-control", "no-cache")
			_, _ = x.Write([]byte(vhtmljs))
		}
	}
	return func(x *vigo.X) {
		x.Header().Set("cache-control", "no-cache")
		if current := utils.CurrentDir(0); current != "" {
			p := path.Join(current, "src", "index.js")
			if _, err := os.Stat(p); err == nil {
				_ = x.File(p)
				return
			}
		}
		data, err := srcfs.ReadFile("src/index.js")
		if err != nil {
			x.WriteHeader(404)
			return
		}
		x.Header().Set("content-type", "text/javascript; charset=utf-8")
		_, _ = x.Write(data)
	}
}
