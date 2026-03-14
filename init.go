//
// init.go
// Copyright (C) 2026 veypi <i@veypi.com>
//
// Distributed under terms of the MIT license.
//

package vhtml

import (
	"embed"
	"net/http"
	"os"
	"path"
	"strings"

	"github.com/veypi/vigo"
	"github.com/veypi/vigo/contrib/ufs"
	"github.com/veypi/vigo/utils"
)

var Router = vigo.NewRouter()

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
	vdev := os.Getenv("vdev")
	renderEnv := func(x *vigo.X) {
		pathParam := x.PathParams.Get("path")
		requestPath := x.Request.URL.Path
		if pathParam == "" && !strings.HasSuffix(requestPath, "/") {
			http.Redirect(x.ResponseWriter(), x.Request, requestPath+"/", http.StatusMovedPermanently)
			x.Stop()
			return
		}
		x.Header().Set("vhtml-scoped", Router.String())
		x.Header().Set("vhtml-vdev", vdev)
	}
	var lfs ufs.ReadOnlyFS
	if vdev != "" && current != "" {
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
	}
	Router.Get("/{path:*}", renderEnv, ufs.NewHandlerWithDefault(lfs, "root.html"))
}

func WrapUI(router vigo.Router, uiFS embed.FS, args ...string) vigo.Router {
	current := utils.CurrentDir(1)
	vdev := os.Getenv("vdev")
	renderEnv := func(x *vigo.X) {
		pathParam := x.PathParams.Get("path")
		requestPath := x.Request.URL.Path
		if pathParam == "" && !strings.HasSuffix(requestPath, "/") {
			http.Redirect(x.ResponseWriter(), x.Request, requestPath+"/", http.StatusMovedPermanently)
			x.Stop()
			return
		}
		x.Header().Set("vhtml-scoped", router.String())
		x.Header().Set("vhtml-vdev", vdev)
		for i := 0; i < len(args); i += 2 {
			x.Header().Set("vhtml-"+args[i], args[i+1])
		}
		if vdev != "" {
			x.Header().Set("Cache-Control", "no-cache")
		}
	}
	var lfs ufs.ReadOnlyFS
	var err error
	if vdev != "" && current != "" {
		lfs, err = ufs.NewLocalFS(path.Join(current, "ui"))
	} else {
		lfs, err = ufs.NewEmbedFS(uiFS, "ui")
	}
	if err != nil {
		panic(err)
	}
	router.Get("/{path:*}", renderEnv, ufs.NewHandlerWithDefault(lfs, "root.html"))
	return router
}
