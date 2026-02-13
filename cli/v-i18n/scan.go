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
	Fix          bool   `json:"fix" desc:"自动修复，为缺失的 key 添加空翻译"`
	RemoveUnused bool   `json:"removeUnused" desc:"删除未使用的 key"`
	ReportOutput string `json:"reportOutput" desc:"报告输出文件路径"`
	ReportFormat string `json:"reportFormat" desc:"报告格式：console、json"`
	Fill         string `json:"fill" desc:"自动填充的值，用于修复时填充新 key"`
	CheckEmpty   bool   `json:"checkEmpty" desc:"检查值为空的翻译项"`
	Verbose      bool   `json:"verbose" desc:"显示所有结果，不省略"`
}{
	Fix:          false,
	RemoveUnused: false,
	ReportOutput: "",
	ReportFormat: "console",
	Fill:         "",
	CheckEmpty:   true,
	Verbose:      false,
}

func init() {
	cmdScan := cmdMain.SubCommand("scan", "扫描代码中的 i18n key")
	cmdScan.AutoRegister(&globalOpts)
	cmdScan.AutoRegister(&scanOpts)
	cmdScan.Command = runScan
}

func runScan() error {
	config := GetConfig()

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

	// 获取值为空的 keys（如果开启检查）
	var emptyKeys map[string]map[string]bool // lang -> key -> bool
	if scanOpts.CheckEmpty {
		emptyKeys = make(map[string]map[string]bool)
		for _, lang := range config.Languages {
			emptyKeys[lang] = getEmptyKeys(translations, lang)
		}
	}

	// 输出结果
	if scanOpts.ReportOutput != "" {
		return outputReport(foundKeys, missingKeys, unusedKeys, emptyKeys, config)
	}
	// 如果指定了 reportFormat=json 但没有指定输出文件，输出 JSON 到控制台
	if scanOpts.ReportFormat == "json" {
		return outputJSONToConsole(foundKeys, missingKeys, unusedKeys, emptyKeys, config)
	}

	// 控制台输出
	printScanResult(foundKeys, missingKeys, unusedKeys, emptyKeys, config)

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
			base := filepath.Base(path)
			for _, exclude := range config.Scan.Exclude {
				if matched, _ := filepath.Match(exclude, base); matched {
					return filepath.SkipDir
				}
				// 检查完全匹配
				if exclude == base || strings.HasSuffix(path, exclude) {
					return filepath.SkipDir
				}
			}
			return nil
		}

		// 检查是否匹配包含模式
		matched := false
		ext := filepath.Ext(path)
		for _, include := range config.Scan.Include {
			// 处理 **/*.ext 模式
			if strings.HasPrefix(include, "**/*") {
				// include[3:] 会得到 *.html, 我们需要 .html
				if ext != "" && strings.HasSuffix(include, ext) {
					matched = true
					break
				}
			}
			// 基本 glob 匹配
			if matched, _ = filepath.Match(include, filepath.Base(path)); matched {
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
			// 检查是否为复数格式（包含 zero/one/other 的对象）
			if isPluralObject(nested) {
				// 复数对象本身也是合法键（如 $t("apples")）
				keys[key] = true
			}
			extractKeys(nested, key, keys)
		} else {
			keys[key] = true
		}
	}
}

// isPluralObject 检查对象是否为复数格式
// 复数对象包含 zero/one/other 中的至少一个键
func isPluralObject(obj map[string]interface{}) bool {
	pluralKeys := []string{"zero", "one", "other"}
	for _, pk := range pluralKeys {
		if _, ok := obj[pk]; ok {
			return true
		}
	}
	return false
}

// getEmptyKeys 获取所有值为空的 keys
func getEmptyKeys(translations map[string]map[string]interface{}, lang string) map[string]bool {
	emptyKeys := make(map[string]bool)
	if items, ok := translations[lang]; ok {
		extractEmptyKeys(items, "", emptyKeys)
	}
	return emptyKeys
}

func extractEmptyKeys(data map[string]interface{}, prefix string, emptyKeys map[string]bool) {
	for k, v := range data {
		key := k
		if prefix != "" {
			key = prefix + "." + k
		}
		if nested, ok := v.(map[string]interface{}); ok {
			// 复数对象本身不检查空值，只检查其子键
			extractEmptyKeys(nested, key, emptyKeys)
		} else {
			// 检查值是否为空
			if isEmptyValue(v) {
				emptyKeys[key] = true
			}
		}
	}
}

// isEmptyValue 检查值是否为空
func isEmptyValue(v interface{}) bool {
	if v == nil {
		return true
	}
	if s, ok := v.(string); ok {
		return s == ""
	}
	return false
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
			// 检查父键是否被使用（处理复数对象的情况）
			// 例如：apples.zero 的父键 apples 如果被使用，则 apples.zero 不算未使用
			if isParentKeyUsed(key, found) {
				continue
			}
			unused = append(unused, key)
		}
	}
	return unused
}

// isParentKeyUsed 检查 key 的父键是否被使用
// 例如 key = "apples.zero", 父键 "apples" 如果在 found 中，则返回 true
func isParentKeyUsed(key string, found map[string]bool) bool {
	parts := strings.Split(key, ".")
	for i := len(parts) - 1; i > 0; i-- {
		parentKey := strings.Join(parts[:i], ".")
		if found[parentKey] {
			return true
		}
	}
	return false
}

// printScanResult 打印扫描结果
func printScanResult(foundKeys map[string]bool, missingKeys, unusedKeys []string, emptyKeys map[string]map[string]bool, config *Config) {
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
		if scanOpts.Verbose {
			fmt.Println("│ 缺失 key 列表:                                      │")
		} else {
			fmt.Println("│ 缺失 key 列表 (前 10 个):                           │")
		}
		for i, key := range missingKeys {
			if !scanOpts.Verbose && i >= 10 {
				fmt.Printf("│   ... 还有 %d 个                                   │\n", len(missingKeys)-10)
				break
			}
			fmt.Printf("│   - %s\n", key)
		}
	}

	// 显示值为空的 keys
	if scanOpts.CheckEmpty && emptyKeys != nil {
		hasEmpty := false
		for _, keys := range emptyKeys {
			if len(keys) > 0 {
				hasEmpty = true
				break
			}
		}
		if hasEmpty {
			fmt.Println("├─────────────────────────────────────────────────────┤")
			fmt.Println("│ 空值翻译                                            │")
			for _, lang := range config.Languages {
				if keys, ok := emptyKeys[lang]; ok && len(keys) > 0 {
					fmt.Printf("│   ⚠️  %s: %d 个\n", lang, len(keys))
				}
			}
			// 显示空值 key 列表（仅默认语言）
			if defaultEmpty, ok := emptyKeys[config.DefaultLanguage]; ok && len(defaultEmpty) > 0 {
				fmt.Println("├─────────────────────────────────────────────────────┤")
				if scanOpts.Verbose {
					fmt.Println("│ 空值 key 列表:                                      │")
				} else {
					fmt.Println("│ 空值 key 列表 (前 10 个):                           │")
				}
				count := 0
				for key := range defaultEmpty {
					if !scanOpts.Verbose && count >= 10 {
						fmt.Printf("│   ... 还有 %d 个                                   │\n", len(defaultEmpty)-10)
						break
					}
					fmt.Printf("│   - %s\n", key)
					count++
				}
			}
		}
	}

	// 显示未使用的 keys
	if len(unusedKeys) > 0 {
		fmt.Println("├─────────────────────────────────────────────────────┤")
		if scanOpts.Verbose {
			fmt.Printf("│ 未使用 key (%d):                                    │\n", len(unusedKeys))
		} else {
			fmt.Printf("│ 未使用 key (%d, 前 5 个):                           │\n", len(unusedKeys))
		}
		for i, key := range unusedKeys {
			if !scanOpts.Verbose && i >= 5 {
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
func outputReport(foundKeys map[string]bool, missingKeys, unusedKeys []string, emptyKeys map[string]map[string]bool, config *Config) error {
	// 简化实现，先支持 JSON 格式
	if scanOpts.ReportFormat == "json" {
		data := map[string]interface{}{
			"found":      len(foundKeys),
			"missing":    missingKeys,
			"unused":     unusedKeys,
			"empty":      emptyKeys,
			"emptyCount": countEmptyKeys(emptyKeys),
		}
		return os.WriteFile(scanOpts.ReportOutput, mustMarshalJSON(data), 0o644)
	}
	return nil
}

// countEmptyKeys 统计空值 key 数量
func countEmptyKeys(emptyKeys map[string]map[string]bool) map[string]int {
	result := make(map[string]int)
	for lang, keys := range emptyKeys {
		result[lang] = len(keys)
	}
	return result
}

// outputJSONToConsole 输出 JSON 到控制台
func outputJSONToConsole(foundKeys map[string]bool, missingKeys, unusedKeys []string, emptyKeys map[string]map[string]bool, config *Config) error {
	data := map[string]interface{}{
		"found":      len(foundKeys),
		"missing":    missingKeys,
		"unused":     unusedKeys,
		"empty":      emptyKeys,
		"emptyCount": countEmptyKeys(emptyKeys),
	}
	fmt.Println(string(mustMarshalJSON(data)))
	return nil
}

func mustMarshalJSON(v interface{}) []byte {
	b, _ := jsonMarshal(v)
	return b
}

func jsonMarshal(v interface{}) ([]byte, error) {
	return json.MarshalIndent(v, "", "  ")
}
