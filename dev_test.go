package vhtml

import (
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/veypi/vigo"
)

func checkRuntimeAssets(t *testing.T, runtime vigo.Router, sourceMode bool) {
	t.Helper()
	root := vigo.NewRouter()
	root.Extend("nested/vhtml", runtime)
	want := map[string][]byte{}
	// Include source modules in source mode, then overlay browser-ready vendors.
	for _, dir := range []string{"src", "dist"} {
		if dir == "src" && !sourceMode {
			continue
		}
		var files fs.FS = distfs
		if dir == "src" {
			files = srcfs
		}
		err := fs.WalkDir(files, dir, func(name string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() || !strings.HasSuffix(name, ".js") {
				return err
			}
			data, err := fs.ReadFile(files, name)
			want[strings.TrimPrefix(name, dir+"/")] = data
			return err
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	if sourceMode {
		want["vhtml.min.js"] = want["index.js"]
	}
	for name, data := range want {
		w := httptest.NewRecorder()
		r := httptest.NewRequest(http.MethodGet, "/nested/vhtml/"+name, nil)
		root.ServeHTTP(w, r)
		if w.Code != http.StatusOK || !strings.Contains(w.Header().Get("Content-Type"), "javascript") || w.Body.String() != string(data) {
			t.Errorf("%s: status=%d type=%q; expected JavaScript asset (%d bytes), got %d bytes", name, w.Code, w.Header().Get("Content-Type"), len(data), w.Body.Len())
		}
	}
}

func TestFrameworkRouterAssets(t *testing.T) {
	t.Run("dist", func(t *testing.T) { checkRuntimeAssets(t, FrameworkRouter(false), false) })
	t.Run("source", func(t *testing.T) { checkRuntimeAssets(t, FrameworkRouter(true), true) })
}

func TestApplicationRouterAssets(t *testing.T) {
	// Run with and without debug=true to cover the router embedded by AIC.
	checkRuntimeAssets(t, Router, os.Getenv("debug") != "")
}

func TestSourceModeEmbeddedFallback(t *testing.T) {
	files := frameworkFS(true, t.TempDir())
	for _, name := range []string{"index.js", "vendor/acorn.js", "vendor/quickjs.js"} {
		got, err := fs.ReadFile(files, name)
		if err != nil {
			t.Fatal(err)
		}
		var want []byte
		if strings.HasPrefix(name, "vendor/") {
			want, err = distfs.ReadFile("dist/" + name)
		} else {
			want, err = srcfs.ReadFile("src/" + name)
		}
		if err != nil || string(got) != string(want) {
			t.Errorf("embedded fallback returned wrong module for %s: %v", name, err)
		}
	}
}
