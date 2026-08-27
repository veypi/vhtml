//
// scaffold.go
// Copyright (C) 2026 veypi <i@veypi.com>
//
// Distributed under terms of the MIT license.
//

package main

import (
	"embed"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

//go:embed scaffold
var scaffoldFS embed.FS

// runInit 在 dir 下生成 vhtml 项目骨架。已存在的文件跳过（不覆盖用户内容）。
func runInit(dir string) error {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return err
	}
	count := 0
	err = fs.WalkDir(scaffoldFS, "scaffold", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel("scaffold", p)
		target := filepath.Join(abs, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		if _, err := os.Stat(target); err == nil {
			fmt.Printf("  skip (exists): %s\n", rel)
			return nil
		}
		data, err := scaffoldFS.ReadFile(p)
		if err != nil {
			return err
		}
		if err := os.WriteFile(target, data, 0o644); err != nil {
			return err
		}
		fmt.Printf("  create: %s\n", rel)
		count++
		return nil
	})
	if err != nil {
		return err
	}
	fmt.Printf("\n✅ 项目骨架已就绪 (%d 个文件)\n\n  cd %s\n  vhtml\n\n", count, abs)
	return nil
}
