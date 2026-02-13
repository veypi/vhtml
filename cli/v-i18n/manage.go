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
	Key    string `json:"key" desc:"要添加的翻译 key"`
	Value  string `json:"value" desc:"翻译值（所有语言使用相同值）"`
	Values string `json:"values" desc:"多语言值，JSON 格式如：{\"zh-CN\":\"中文\",\"en-US\":\"English\"}"`
	Nested bool   `json:"nested" desc:"是否支持嵌套 key"`
	Input  string `json:"input" desc:"从文件批量添加 key，每行一个"`
}{
	Key:    "",
	Value:  "",
	Values: "",
	Nested: true,
	Input:  "",
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

	// 优先从文件读取
	if addOpts.Input != "" {
		keys, err := readKeysFromFile(addOpts.Input)
		if err != nil {
			return err
		}
		if len(keys) > 0 {
			return addKeys(keys, config)
		}
		return fmt.Errorf("文件为空: %s", addOpts.Input)
	}

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
		return fmt.Errorf("请提供要添加的 key，使用 -key 参数指定或 -input 指定文件")
	}

	return addKeys([]string{key}, config)
}

// readKeysFromFile 从文件读取 key 列表
func readKeysFromFile(filename string) ([]string, error) {
	file, err := os.Open(filename)
	if err != nil {
		return nil, fmt.Errorf("打开文件失败: %w", err)
	}
	defer file.Close()

	var keys []string
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		k := strings.TrimSpace(scanner.Text())
		if k != "" && !strings.HasPrefix(k, "#") {
			keys = append(keys, k)
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("读取文件失败: %w", err)
	}
	return keys, nil
}

func addKeys(keys []string, config *Config) error {
	translations, err := LoadTranslations(config.Output)
	if err != nil {
		return err
	}

	// 解析多语言值（支持字符串或复数对象）
	var values map[string]interface{}
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
				// 尝试解析为 JSON 对象（复数格式）
				var obj interface{}
				if err := json.Unmarshal([]byte(addOpts.Value), &obj); err == nil {
					value = obj
				} else {
					value = addOpts.Value
				}
			} else {
				value = ""
			}

			// 扁平化直接设置
			translations[lang][key] = value
		}
		fmt.Printf("✅ 已添加 key: %s\n", key)
	}

	return SaveTranslations(config.Output, translations, config.Format)
}

// ========== remove 命令 ==========
var removeOpts = struct {
	Key        string `json:"key" desc:"要删除的 key 或正则模式"`
	Yes        bool   `json:"yes" desc:"跳过确认直接删除"`
	UsePattern bool   `json:"usePattern" desc:"将 key 视为正则表达式模式"`
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
				for key := range items {
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

	// 执行删除（扁平化）
	for _, lang := range config.Languages {
		if items, ok := translations[lang]; ok {
			for _, key := range keysToRemove {
				delete(items, key)
			}
		}
	}

	fmt.Printf("✅ 已删除 %d 个 key\n", len(keysToRemove))
	return SaveTranslations(config.Output, translations, config.Format)
}

// ========== rename 命令 ==========
var renameOpts = struct {
	OldKey       string `json:"oldKey" desc:"原 key 名称"`
	NewKey       string `json:"newKey" desc:"新 key 名称"`
	UpdateSource bool   `json:"updateSource" desc:"是否更新源代码中的引用"`
	DryRun       bool   `json:"dryRun" desc:"预览模式，不实际修改"`
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

	// 执行重命名（扁平化）
	for _, lang := range config.Languages {
		if items, ok := translations[lang]; ok {
			if value, exists := items[oldKey]; exists {
				if !renameOpts.DryRun {
					delete(items, oldKey)
					items[newKey] = value
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
