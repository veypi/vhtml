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
	Verbose bool `json:"verbose" desc:"显示所有结果，不省略"`
}{
	Verbose: false,
}

func init() {
	cmdScan := cmdMain.SubCommand("scan", "扫描代码中的 i18n key，自动排序、清理并报告缺失")
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

	// 获取所有已存在的 keys（基于默认语言）
	existingKeys := getAllKeys(translations, config.DefaultLanguage)

	// 分析差异：代码中有但 translations 中没有的 key
	missingKeys := findMissingKeys(foundKeys, existingKeys)
	unusedKeys := findUnusedKeys(foundKeys, existingKeys)

	// 获取值为空的 keys（在 foundKeys 范围内）
	emptyKeys := make(map[string]map[string]bool)
	for _, lang := range config.Languages {
		emptyKeys[lang] = getEmptyKeysInFoundKeys(translations, lang, foundKeys)
	}

	// 自动清理：删除未使用的 key
	if len(unusedKeys) > 0 {
		for _, key := range unusedKeys {
			for _, lang := range config.Languages {
				delete(translations[lang], key)
			}
		}
	}

	// 自动清理：删除值为空的 key
	for _, lang := range config.Languages {
		for key := range emptyKeys[lang] {
			delete(translations[lang], key)
		}
	}

	// 自动清理：删除代码中不存在的 key（即不在 foundKeys 中）
	for _, lang := range config.Languages {
		if items, ok := translations[lang]; ok {
			for key := range items {
				if !foundKeys[key] && !isParentKeyUsed(key, foundKeys) {
					delete(items, key)
				}
			}
		}
	}

	// 清理后重新计算已存在的 keys 和缺失的 keys
	existingKeys = getAllKeys(translations, config.DefaultLanguage)
	missingKeys = findMissingKeys(foundKeys, existingKeys)

	// 输出统计信息（基于清理后的 translations）
	printStatsTable(foundKeys, translations, config)

	// 收集各语言缺失的 key（包括默认语言）
	langMissing := make(map[string][]string)
	for _, lang := range config.Languages {
		for key := range foundKeys {
			if _, exists := translations[lang][key]; !exists {
				langMissing[lang] = append(langMissing[lang], key)
			}
		}
	}

	// 输出缺失的 key 或 add 指令
	if len(missingKeys) > 0 {
		fmt.Printf("\n缺失 %d 个 key\n", len(missingKeys))
		limit := 10
		if scanOpts.Verbose {
			limit = len(missingKeys)
		}
		for i, key := range missingKeys {
			if i >= limit {
				fmt.Printf("  ... 还有 %d 个\n", len(missingKeys)-limit)
				break
			}
			fmt.Printf("  - %s\n", key)
		}
		fmt.Println()
		printAddCommand(missingKeys, translations, config)
	}

	// 报告各语言单独缺失的情况（默认语言已包含在 missingKeys 中）
	hasLangMissing := false
	for _, lang := range config.Languages {
		if lang == config.DefaultLanguage {
			continue
		}
		if len(langMissing[lang]) > 0 {
			hasLangMissing = true
			fmt.Printf("\n⚠️  [%s] 缺失 %d 个 key\n", lang, len(langMissing[lang]))
			limit := 10
			if scanOpts.Verbose {
				limit = len(langMissing[lang])
			}
			for i, key := range langMissing[lang] {
				if i >= limit {
					fmt.Printf("  ... 还有 %d 个\n", len(langMissing[lang])-limit)
					break
				}
				fmt.Printf("  - %s\n", key)
			}
		}
	}

	// 如果有语言缺失，输出 add 命令
	if len(missingKeys) == 0 && hasLangMissing {
		fmt.Println()
		// 合并所有语言缺失的 key
		allMissing := make(map[string]bool)
		for _, lang := range config.Languages {
			for _, key := range langMissing[lang] {
				allMissing[key] = true
			}
		}
		var mergedMissing []string
		for key := range allMissing {
			mergedMissing = append(mergedMissing, key)
		}
		printAddCommand(mergedMissing, translations, config)
	}

	if len(missingKeys) == 0 && !hasLangMissing {
		fmt.Println("\n✅ 所有语言翻译完整")
	}

	// 确保所有语言都存在
	for _, lang := range config.Languages {
		if _, ok := translations[lang]; !ok {
			translations[lang] = make(map[string]interface{})
		}
	}

	// 保存文件（自动排序）
	if err := SaveTranslations(config.Output, translations, config.Format, config.DefaultLanguage); err != nil {
		return fmt.Errorf("保存翻译文件失败: %w", err)
	}

	return nil
}

// printStatsTable 输出统计表格
// totalKeys: 代码中扫描到的所有 key（作为总数基准）
func printStatsTable(totalKeys map[string]bool, translations map[string]map[string]interface{}, config *Config) {
	total := len(totalKeys)

	fmt.Println("┌──────────┬────────┬────────┬──────────┐")
	fmt.Println("│ Language │ Total  │ Done   │ Coverage │")
	fmt.Println("├──────────┼────────┼────────┼──────────┤")
	for _, lang := range config.Languages {
		items, ok := translations[lang]
		done := 0
		if ok && total > 0 {
			for key := range totalKeys {
				if value, exists := items[key]; exists {
					if v, ok := value.(string); ok && v != "" {
						done++
					}
				}
			}
		}
		coverage := float64(0)
		if total > 0 {
			coverage = float64(done) / float64(total) * 100
		}
		fmt.Printf("│ %-8s │ %-6d │ %-6d │ %6.1f%%  │\n",
			lang, total, done, coverage)
	}
	fmt.Println("└──────────┴────────┴────────┴──────────┘")
}

// printAddCommand 输出建议执行的 add 命令
func printAddCommand(missingKeys []string, translations map[string]map[string]interface{}, config *Config) {
	// 判断每种语言的缺失情况
	langMissing := make(map[string][]string)
	for _, lang := range config.Languages {
		for _, key := range missingKeys {
			if _, exists := translations[lang][key]; !exists {
				langMissing[lang] = append(langMissing[lang], key)
			}
		}
	}

	// 确定需要包含哪些语言
	// 如果只有英文缺失，只输出英文；如果都缺失，输出所有语言
	langsToInclude := []string{}
	for _, lang := range config.Languages {
		if len(langMissing[lang]) > 0 {
			langsToInclude = append(langsToInclude, lang)
		}
	}

	if len(langsToInclude) == 0 {
		return
	}

	// 构建 JSON：一级 key 是语言，二级 key 是翻译项，值为 ""
	data := make(map[string]map[string]string)
	for _, lang := range langsToInclude {
		data[lang] = make(map[string]string)
		for _, key := range missingKeys {
			if _, exists := translations[lang][key]; !exists {
				data[lang][key] = ""
			}
		}
	}

	jsonBytes, err := json.Marshal(data)
	if err != nil {
		return
	}
	fmt.Printf("添加请执行: v-i18n add -json '%s'\n", string(jsonBytes))
	fmt.Println("\n⚠️  注意：上述命令中的 \"\" 为占位符，请替换为实际翻译内容后再执行。")
}

// scanFiles 扫描文件中的 i18n keys
func scanFiles(config *Config) (map[string]bool, error) {
	keys := make(map[string]bool)

	pattern := config.Scan.Pattern
	if pattern == "" {
		pattern = `\$t\(['"]([^'"]+)['"]`
	}
	re, err := regexp.Compile(pattern)
	if err != nil {
		return nil, fmt.Errorf("编译正则表达式失败: %w", err)
	}

	err = filepath.Walk(config.Entry, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}

		if info.IsDir() {
			base := filepath.Base(path)
			for _, exclude := range config.Scan.Exclude {
				if matched, _ := filepath.Match(exclude, base); matched {
					return filepath.SkipDir
				}
				if exclude == base || strings.HasSuffix(path, exclude) {
					return filepath.SkipDir
				}
			}
			return nil
		}

		matched := false
		ext := filepath.Ext(path)
		for _, include := range config.Scan.Include {
			if strings.HasPrefix(include, "**/*") {
				if ext != "" && strings.HasSuffix(include, ext) {
					matched = true
					break
				}
			}
			if matched, _ = filepath.Match(include, filepath.Base(path)); matched {
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
		for key := range items {
			keys[key] = true
		}
	}
	return keys
}

// getEmptyKeysInFoundKeys 获取在 foundKeys 范围内值为空的 keys
func getEmptyKeysInFoundKeys(translations map[string]map[string]interface{}, lang string, foundKeys map[string]bool) map[string]bool {
	emptyKeys := make(map[string]bool)
	if items, ok := translations[lang]; ok {
		for key, value := range items {
			if foundKeys[key] && isEmptyValue(value) {
				emptyKeys[key] = true
			}
		}
	}
	return emptyKeys
}

// isEmptyValue 检查值是否为空
func isEmptyValue(v interface{}) bool {
	if v == nil {
		return true
	}
	if s, ok := v.(string); ok {
		return s == ""
	}
	if obj, ok := v.(map[string]interface{}); ok {
		if isPluralObject(obj) {
			if other, has := obj["other"]; has {
				return isEmptyValue(other)
			}
			if one, has := obj["one"]; has {
				return isEmptyValue(one)
			}
			return true
		}
	}
	return false
}

// isPluralObject 检查是否为复数格式对象
func isPluralObject(obj map[string]interface{}) bool {
	pluralKeys := []string{"zero", "one", "other"}
	for _, k := range pluralKeys {
		if _, ok := obj[k]; ok {
			return true
		}
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
			if isParentKeyUsed(key, found) {
				continue
			}
			unused = append(unused, key)
		}
	}
	return unused
}

// isParentKeyUsed 检查 key 的父键是否被使用
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
