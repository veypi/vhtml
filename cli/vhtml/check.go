//
// check.go
// Copyright (C) 2024 veypi <i@veypi.com>
//
// Distributed under terms of the MIT license.
//

package main

import (
	_ "embed"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/veypi/vigo/flags"
)

// check.mjs 静态检查器（node 端执行），嵌入二进制随取随用
//
//go:embed check.mjs
var checkScript string

// checkOpts check 子命令选项（--json 输出 findings 数组）
type checkOpts struct {
	JSON bool `json:"json" desc:"JSON 输出 findings 数组（默认 text 每行一条）"`
}

// 编译核解析顺序：env 显式指定 → 从 cwd 向上找 vhtml 仓库 src/compile.js
func findCompileCore() string {
	if p := os.Getenv("VHTML_COMPILE_CORE"); p != "" {
		return p
	}
	wd, err := os.Getwd()
	if err != nil {
		return ""
	}
	for d := wd; ; d = filepath.Dir(d) {
		p := filepath.Join(d, "src", "compile.js")
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p
		}
		if parent := filepath.Dir(d); parent == d {
			break
		}
	}
	return ""
}

// 收集 .html 文件（跳过 node_modules/dist/.git），文件参数直接收录
func collectHTML(root string, out *[]string) {
	fi, err := os.Stat(root)
	if err != nil {
		fmt.Fprintf(os.Stderr, "vhtml check: %v\n", err)
		return
	}
	if !fi.IsDir() {
		if strings.HasSuffix(root, ".html") {
			*out = append(*out, root)
		}
		return
	}
	filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			switch d.Name() {
			case "node_modules", "dist", ".git":
				return filepath.SkipDir
			}
			return nil
		}
		if strings.HasSuffix(p, ".html") {
			*out = append(*out, p)
		}
		return nil
	})
}

// runCheck 模板静态检查：Go 收集文件 + 探测 node/编译核，检查语义在 node 检查器内
//（复用任务 0 剥离的纯编译核，保证检查语义 = 运行时语义）。
// 退出码透传：0 = 无发现；1 = 有发现；2 = 工具故障（node/编译核缺失）。
func runCheck(cmd *flags.Flags, opts *checkOpts) error {
	node, err := exec.LookPath("node")
	if err != nil {
		return fmt.Errorf("vhtml check 需要 node（未找到，请安装 Node.js）")
	}
	core := findCompileCore()
	if core == "" {
		return fmt.Errorf("找不到编译核 src/compile.js（设置 VHTML_COMPILE_CORE 或在 vhtml 仓库内运行）")
	}

	dir, err := os.MkdirTemp("", "vhtml-check-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	script := filepath.Join(dir, "check.mjs")
	if err := os.WriteFile(script, []byte(checkScript), 0o644); err != nil {
		return err
	}

	var paths []string
	for i := 0; i < cmd.NArg(); i++ {
		paths = append(paths, cmd.Arg(i))
	}
	if len(paths) == 0 {
		paths = []string{"."}
	}
	var files []string
	for _, p := range paths {
		collectHTML(p, &files)
	}
	if len(files) == 0 {
		fmt.Fprintln(os.Stderr, "vhtml check: no .html files found")
		return nil
	}

	argv := []string{script}
	if opts.JSON {
		argv = append(argv, "--json")
	}
	argv = append(argv, files...)
	c := exec.Command(node, argv...)
	c.Env = append(os.Environ(), "VHTML_COMPILE_CORE="+core)
	c.Stdout = os.Stdout
	c.Stderr = os.Stderr
	c.Stdin = os.Stdin
	err = c.Run()
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		// 检查器退出码语义契约（check.mjs 头注释）：透传保持
		os.Exit(ee.ExitCode())
	}
	return err
}
