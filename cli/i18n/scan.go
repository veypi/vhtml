//
// scan.go
// Copyright (C) 2026 veypi <i@veypi.com>
//
// Distributed under terms of the MIT license.
//

package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var scanOpts = struct {
	Fix          bool   `json:"fix"`
	RemoveUnused bool   `json:"removeUnused"`
	Output       string `json:"output"`
	Format       string `json:"format"`
	Fill         string `json:"fill"`
}{
	Fix:          false,
	RemoveUnused: false,
	Output:       "",
	Format:       "console",
	Fill:         "",
}

func init() {
	cmdScan := cmdMain.SubCommand("scan", "扫描代码中的 i18n key")
	cmdScan.AutoRegister(&scanOpts)
	cmdScan.Command = runScan
}

func runScan() error {
	config, err := LoadConfig("")
	if err != nil {
		return err
	}

	// 加载现有翻译
	translations, err := LoadTranslations(config.Output)
	if err != nil {
		return err
	}

	// 扫描代码中的 keys
	foundKeys, err := scanFiles(config)
	if err != nil {
		return err
	}

	// 获取所有已存在的 keys
	existingKeys := getAllKeys(translations, config.DefaultLanguage)

	// 分析差异
	missingKeys := findMissingKeys(foundKeys, existingKeys)
	unusedKeys := findUnusedKeys(foundKeys, existingKeys)

	// 输出结果
	if scanOpts.Output != "" {
		return outputReport(foundKeys, missingKeys, unusedKeys, config)
	}

	// 控制台输出
	printScanResult(foundKeys, missingKeys, unusedKeys, config)

	// 自动修复
	if scanOpts.Fix && len(missingKeys) > 0 {
		if err := fixMissingKeys(translations, missingKeys, config); err != nil {
			return fmt.Errorf("修复缺失 key 失败: %w", err)
		}
		fmt.Printf("\n✅ 已自动添加 %d 个缺失的 key\n", len(missingKeys))
	}

	// 删除未使用的 keys
	if scanOpts.RemoveUnused && len(unusedKeys) > 0 {
		if err := removeUnusedKeys(translations, unusedKeys, config); err != nil {
			return fmt.Errorf("删除未使用 key 失败: %w", err)
		}
		fmt.Printf("\n✅ 已删除 %d 个未使用的 key\n", len(unusedKeys))
	}

	return nil
}

// scanFiles 扫描文件中的 i18n keys
func scanFiles(config *Config) (map[string]bool, error) {
	keys := make(map[string]bool)

	// 编译正则表达式
	pattern := config.Scan.Pattern
	if pattern == "" {
		pattern = `\$t\(['"]([^'"]+)['"]`
	}
	re, err := regexp.Compile(pattern)
	if err != nil {
		return nil, fmt.Errorf("编译正则表达式失败: %w", err)
	}

	// 遍历文件
	err = filepath.Walk(config.Entry, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}

		if info.IsDir() {
			// 检查是否在排除列表中
			for _, exclude := range config.Scan.Exclude {
				matched, _ := filepath.Match(exclude, filepath.Base(path))
				if matched {
					return filepath.SkipDir
				}
			}
			return nil
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

		// 读取文件内容
		content, err := os.ReadFile(path)
		if err != nil {
			return err
		}

		// 查找匹配的 keys
		matches := re.FindAllSubmatch(content, -1)
		for _, match := range matches {
			if len(match) > 1 {
				key := string(match[1])
				keys[key] = true
			}
		}

		return nil
	})

	return keys, err
}

// getAllKeys 获取所有已存在的 keys
func getAllKeys(translations map[string]map[string]interface{}, lang string) map[string]bool {
	keys := make(map[string]bool)
	if items, ok := translations[lang]; ok {
		extractKeys(items, "", keys)
	}
	return keys
}

func extractKeys(data map[string]interface{}, prefix string, keys map[string]bool) {
	for k, v := range data {
		key := k
		if prefix != "" {
			key = prefix + "." + k
		}
		if nested, ok := v.(map[string]interface{}); ok {
			extractKeys(nested, key, keys)
		} else {
			keys[key] = true
		}
	}
}

// findMissingKeys 找到缺失的 keys
func findMissingKeys(found, existing map[string]bool) []string {
	var missing []string
	for key := range found {
		if !existing[key] {
			missing = append(missing, key)
		}
	}
	return missing
}

// findUnusedKeys 找到未使用的 keys
func findUnusedKeys(found, existing map[string]bool) []string {
	var unused []string
	for key := range existing {
		if !found[key] {
			unused = append(unused, key)
		}
	}
	return unused
}

// printScanResult 打印扫描结果
func printScanResult(foundKeys map[string]bool, missingKeys, unusedKeys []string, config *Config) {
	fmt.Println("┌─────────────────────────────────────────────────────┐")
	fmt.Println("│ 扫描结果                                            │")
	fmt.Println("├─────────────────────────────────────────────────────┤")
	fmt.Printf("│ 发现 key: %-5d 个                                  │\n", len(foundKeys))
	fmt.Printf("│ 现有 key: %-5d 个                                  │\n", len(getAllKeysFromConfig(config)))
	fmt.Println("├─────────────────────────────────────────────────────┤")

	// 按语言显示缺失
	translations, _ := LoadTranslations(config.Output)
	fmt.Println("│ 缺失翻译                                            │")
	for _, lang := range config.Languages {
		langMissing := 0
		for _, key := range missingKeys {
			if !keyExists(translations, lang, key) {
				langMissing++
			}
		}
		if langMissing > 0 {
			fmt.Printf("│   ❌ %s: %d 个\n", lang, langMissing)
		} else {
			fmt.Printf("│   ✅ %s: 0 个\n", lang)
		}
	}

	// 显示缺失的 key 列表
	if len(missingKeys) > 0 {
		fmt.Println("├─────────────────────────────────────────────────────┤")
		fmt.Println("│ 缺失 key 列表 (前 10 个):                           │")
		for i, key := range missingKeys {
			if i >= 10 {
				fmt.Printf("│   ... 还有 %d 个                                   │\n", len(missingKeys)-10)
				break
			}
			fmt.Printf("│   - %s\n", key)
		}
	}

	// 显示未使用的 keys
	if len(unusedKeys) > 0 {
		fmt.Println("├─────────────────────────────────────────────────────┤")
		fmt.Printf("│ 未使用 key (%d):                                    │\n", len(unusedKeys))
		for i, key := range unusedKeys {
			if i >= 5 {
				fmt.Printf("│   ... 还有 %d 个                                   │\n", len(unusedKeys)-5)
				break
			}
			fmt.Printf("│   ⚠️  %s\n", key)
		}
	}

	fmt.Println("└─────────────────────────────────────────────────────┘")
}

// getAllKeysFromConfig 从配置获取所有 keys
func getAllKeysFromConfig(config *Config) map[string]bool {
	translations, _ := LoadTranslations(config.Output)
	return getAllKeys(translations, config.DefaultLanguage)
}

// keyExists 检查 key 是否存在于指定语言
func keyExists(translations map[string]map[string]interface{}, lang, key string) bool {
	items, ok := translations[lang]
	if !ok {
		return false
	}

	parts := strings.Split(key, ".")
	current := items
	for i, part := range parts {
		if i == len(parts)-1 {
			_, exists := current[part]
			return exists
		}
		if nested, ok := current[part].(map[string]interface{}); ok {
			current = nested
		} else {
			return false
		}
	}
	return false
}

// fixMissingKeys 修复缺失的 keys
func fixMissingKeys(translations map[string]map[string]interface{}, missingKeys []string, config *Config) error {
	for _, lang := range config.Languages {
		if _, ok := translations[lang]; !ok {
			translations[lang] = make(map[string]interface{})
		}
	}

	for _, key := range missingKeys {
		for _, lang := range config.Languages {
			setNestedKey(translations[lang], key, scanOpts.Fill)
		}
	}

	return SaveTranslations(config.Output, translations, config.Format)
}

// setNestedKey 设置嵌套 key
func setNestedKey(data map[string]interface{}, key string, value interface{}) {
	parts := strings.Split(key, ".")
	current := data
	for i, part := range parts {
		if i == len(parts)-1 {
			current[part] = value
			return
		}
		if _, ok := current[part]; !ok {
			current[part] = make(map[string]interface{})
		}
		if nested, ok := current[part].(map[string]interface{}); ok {
			current = nested
		} else {
			// 如果已存在但不是对象，需要替换
			current[part] = make(map[string]interface{})
			current = current[part].(map[string]interface{})
		}
	}
}

// removeUnusedKeys 删除未使用的 keys
func removeUnusedKeys(translations map[string]map[string]interface{}, unusedKeys []string, config *Config) error {
	for _, key := range unusedKeys {
		for _, lang := range config.Languages {
			deleteNestedKey(translations[lang], key)
		}
	}
	return SaveTranslations(config.Output, translations, config.Format)
}

// deleteNestedKey 删除嵌套 key
func deleteNestedKey(data map[string]interface{}, key string) {
	parts := strings.Split(key, ".")
	current := data
	for i, part := range parts {
		if i == len(parts)-1 {
			delete(current, part)
			return
		}
		if nested, ok := current[part].(map[string]interface{}); ok {
			current = nested
		} else {
			return
		}
	}
}

// outputReport 输出报告到文件
func outputReport(foundKeys map[string]bool, missingKeys, unusedKeys []string, config *Config) error {
	// 简化实现，先支持 JSON 格式
	if scanOpts.Format == "json" {
		data := map[string]interface{}{
			"found":   len(foundKeys),
			"missing": missingKeys,
			"unused":  unusedKeys,
		}
		return os.WriteFile(scanOpts.Output, mustMarshalJSON(data), 0644)
	}
	return nil
}

func mustMarshalJSON(v interface{}) []byte {
	b, _ := jsonMarshal(v)
	return b
}

func jsonMarshal(v interface{}) ([]byte, error) {
	return json.MarshalIndent(v, "", "  ")
}
