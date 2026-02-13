//
// manage.go
// Copyright (C) 2026 veypi <i@veypi.com>
//
// Distributed under terms of the MIT license.
//

package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// ========== add 命令 ==========
var addOpts = struct {
	Key    string `json:"key"`
	Value  string `json:"value"`
	Values string `json:"values"`
	Nested bool   `json:"nested"`
}{
	Key:    "",
	Value:  "",
	Values: "",
	Nested: true,
}

func init() {
	cmdAdd := cmdMain.SubCommand("add", "添加翻译 key")
	cmdAdd.AutoRegister(&globalOpts)
	cmdAdd.AutoRegister(&addOpts)
	cmdAdd.Command = runAdd
}

func runAdd() error {
	config := GetConfig()

	// 获取 key 参数
	key := addOpts.Key

	// 如果没有提供 key，尝试从管道读取
	if key == "" {
		stat, _ := os.Stdin.Stat()
		if (stat.Mode() & os.ModeCharDevice) == 0 {
			// 有管道输入
			scanner := bufio.NewScanner(os.Stdin)
			var keys []string
			for scanner.Scan() {
				k := strings.TrimSpace(scanner.Text())
				if k != "" {
					keys = append(keys, k)
				}
			}
			if len(keys) > 0 {
				return addKeys(keys, config)
			}
		}
		return fmt.Errorf("请提供要添加的 key，使用 -key 参数指定")
	}

	return addKeys([]string{key}, config)
}

func addKeys(keys []string, config *Config) error {
	translations, err := LoadTranslations(config.Output)
	if err != nil {
		return err
	}

	// 解析多语言值
	var values map[string]string
	if addOpts.Values != "" {
		if err := json.Unmarshal([]byte(addOpts.Values), &values); err != nil {
			return fmt.Errorf("解析 values 失败: %w", err)
		}
	}

	for _, key := range keys {
		for _, lang := range config.Languages {
			if _, ok := translations[lang]; !ok {
				translations[lang] = make(map[string]interface{})
			}

			var value interface{}
			if v, ok := values[lang]; ok {
				value = v
			} else if addOpts.Value != "" {
				value = addOpts.Value
			} else {
				value = ""
			}

			setNestedKey(translations[lang], key, value)
		}
		fmt.Printf("✅ 已添加 key: %s\n", key)
	}

	return SaveTranslations(config.Output, translations, config.Format)
}

// ========== remove 命令 ==========
var removeOpts = struct {
	Key         string `json:"key"`
	Yes         bool   `json:"yes"`
	UsePattern  bool   `json:"usePattern"`
}{
	Key:        "",
	Yes:        false,
	UsePattern: false,
}

func init() {
	cmdRemove := cmdMain.SubCommand("remove", "删除翻译 key")
	cmdRemove.AutoRegister(&globalOpts)
	cmdRemove.AutoRegister(&removeOpts)
	cmdRemove.Command = runRemove
}

func runRemove() error {
	config := GetConfig()

	// 获取 key 参数
	pattern := removeOpts.Key

	if pattern == "" {
		return fmt.Errorf("请提供要删除的 key 或模式，使用 -key 参数指定")
	}

	translations, err := LoadTranslations(config.Output)
	if err != nil {
		return err
	}

	// 找到匹配的 keys
	var keysToRemove []string
	if removeOpts.UsePattern {
		re, err := regexp.Compile(pattern)
		if err != nil {
			return fmt.Errorf("正则表达式无效: %w", err)
		}
		for _, lang := range config.Languages {
			if items, ok := translations[lang]; ok {
				keys := getAllKeysFlat(items)
				for _, key := range keys {
					if re.MatchString(key) && !contains(keysToRemove, key) {
						keysToRemove = append(keysToRemove, key)
					}
				}
			}
		}
	} else {
		keysToRemove = []string{pattern}
	}

	if len(keysToRemove) == 0 {
		fmt.Println("没有找到匹配的 key")
		return nil
	}

	// 确认删除
	if !removeOpts.Yes {
		fmt.Printf("将删除以下 %d 个 key:\n", len(keysToRemove))
		for i, key := range keysToRemove {
			if i >= 5 {
				fmt.Printf("  ... 还有 %d 个\n", len(keysToRemove)-5)
				break
			}
			fmt.Printf("  - %s\n", key)
		}
		fmt.Print("确认删除? [y/N]: ")
		reader := bufio.NewReader(os.Stdin)
		input, _ := reader.ReadString('\n')
		if strings.ToLower(strings.TrimSpace(input)) != "y" {
			fmt.Println("已取消")
			return nil
		}
	}

	// 执行删除
	for _, lang := range config.Languages {
		if items, ok := translations[lang]; ok {
			for _, key := range keysToRemove {
				deleteNestedKey(items, key)
			}
		}
	}

	fmt.Printf("✅ 已删除 %d 个 key\n", len(keysToRemove))
	return SaveTranslations(config.Output, translations, config.Format)
}

// ========== rename 命令 ==========
var renameOpts = struct {
	OldKey       string `json:"oldKey"`
	NewKey       string `json:"newKey"`
	UpdateSource bool   `json:"updateSource"`
	DryRun       bool   `json:"dryRun"`
}{
	OldKey:       "",
	NewKey:       "",
	UpdateSource: true,
	DryRun:       false,
}

func init() {
	cmdRename := cmdMain.SubCommand("rename", "重命名翻译 key")
	cmdRename.AutoRegister(&globalOpts)
	cmdRename.AutoRegister(&renameOpts)
	cmdRename.Command = runRename
}

func runRename() error {
	config := GetConfig()

	// 获取 oldKey 和 newKey 参数
	oldKey := renameOpts.OldKey
	newKey := renameOpts.NewKey

	if oldKey == "" || newKey == "" {
		return fmt.Errorf("用法: v-i18n rename -oldKey <oldKey> -newKey <newKey>")
	}

	translations, err := LoadTranslations(config.Output)
	if err != nil {
		return err
	}

	if renameOpts.DryRun {
		fmt.Printf("[预览模式] 将重命名: %s -> %s\n", oldKey, newKey)
	}

	// 执行重命名
	for _, lang := range config.Languages {
		if items, ok := translations[lang]; ok {
			value := getValueByKey(items, oldKey)
			if value != nil {
				if !renameOpts.DryRun {
					deleteNestedKey(items, oldKey)
					setNestedKey(items, newKey, value)
				}
			}
		}
	}

	if renameOpts.DryRun {
		fmt.Println("预览完成，没有实际修改")
		return nil
	}

	// 更新源代码中的引用
	if renameOpts.UpdateSource {
		if err := updateSourceKeys(config, oldKey, newKey); err != nil {
			fmt.Printf("⚠️ 更新源代码失败: %v\n", err)
		}
	}

	fmt.Printf("✅ 已重命名: %s -> %s\n", oldKey, newKey)
	return SaveTranslations(config.Output, translations, config.Format)
}

// updateSourceKeys 更新源代码中的 key 引用
func updateSourceKeys(config *Config, oldKey, newKey string) error {
	// 遍历所有匹配的文件
	return filepath.Walk(config.Entry, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return err
		}

		// 检查是否匹配包含模式
		matched := false
		for _, include := range config.Scan.Include {
			matched, _ = filepath.Match(include, filepath.Base(path))
			if matched {
				break
			}
		}
		if !matched {
			return nil
		}

		content, err := os.ReadFile(path)
		if err != nil {
			return err
		}

		// 替换 key 引用
		oldPattern := fmt.Sprintf(`$t('%s')`, oldKey)
		newPattern := fmt.Sprintf(`$t('%s')`, newKey)
		oldPattern2 := fmt.Sprintf(`$t("%s")`, oldKey)
		newPattern2 := fmt.Sprintf(`$t("%s")`, newKey)

		newContent := strings.ReplaceAll(string(content), oldPattern, newPattern)
		newContent = strings.ReplaceAll(newContent, oldPattern2, newPattern2)

		if string(content) != newContent {
			if err := os.WriteFile(path, []byte(newContent), info.Mode()); err != nil {
				return err
			}
			fmt.Printf("  已更新: %s\n", path)
		}

		return nil
	})
}
