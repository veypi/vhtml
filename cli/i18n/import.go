//
// import.go
// Copyright (C) 2026 veypi <i@veypi.com>
//
// Distributed under terms of the MIT license.
//

package main

import (
	"encoding/csv"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

var importOpts = struct {
	Format    string `json:"format"`
	Language  string `json:"language"`
	Overwrite bool   `json:"overwrite"`
	DryRun    bool   `json:"dryRun"`
}{
	Format:    "auto",
	Language:  "",
	Overwrite: false,
	DryRun:    false,
}

func init() {
	cmdImport := cmdMain.SubCommand("import", "从文件导入翻译")
	cmdImport.AutoRegister(&importOpts)
	cmdImport.Command = runImport
}

func runImport() error {
	config, err := LoadConfig("")
	if err != nil {
		return err
	}

	// 获取输入文件
	if len(os.Args) < 3 {
		return fmt.Errorf("用法: v-i18n import <input-file>")
	}
	input := os.Args[2]

	translations, err := LoadTranslations(config.Output)
	if err != nil {
		return err
	}

	// 自动检测格式
	format := importOpts.Format
	if format == "auto" {
	ext := filepath.Ext(input)
		switch ext {
		case ".csv":
			format = "csv"
		case ".json":
			format = "json"
		default:
			return fmt.Errorf("无法自动检测格式，请使用 --format 指定")
		}
	}

	if importOpts.DryRun {
		fmt.Println("[预览模式]")
	}

	switch format {
	case "csv":
		err = importCSV(input, translations, config)
	case "json":
		err = importJSON(input, translations, config)
	default:
		return fmt.Errorf("不支持的格式: %s", format)
	}

	if err != nil {
		return err
	}

	if importOpts.DryRun {
		fmt.Println("预览完成，没有实际修改")
		return nil
	}

	fmt.Printf("✅ 导入完成，已保存到 %s\n", config.Output)
	return SaveTranslations(config.Output, translations, config.Format)
}

func importCSV(input string, translations map[string]map[string]interface{}, config *Config) error {
	file, err := os.Open(input)
	if err != nil {
		return err
	}
	defer file.Close()

	reader := csv.NewReader(file)
	records, err := reader.ReadAll()
	if err != nil {
		return err
	}

	if len(records) < 2 {
		return fmt.Errorf("CSV 文件为空或格式错误")
	}

	// 解析表头
	headers := records[0]
	keyIndex := 0
	langIndices := make(map[string]int)

	for i, h := range headers {
		h = strings.TrimSpace(h)
		if h == "key" {
			keyIndex = i
		} else if h != "context" {
			// 假设其他列是语言代码
			langIndices[h] = i
		}
	}

	// 导入数据
	imported := 0
	for _, record := range records[1:] {
		if len(record) <= keyIndex {
			continue
		}

		key := strings.TrimSpace(record[keyIndex])
		if key == "" {
			continue
		}

		for lang, idx := range langIndices {
			if idx >= len(record) {
				continue
			}

			// 如果指定了语言，只导入该语言
			if importOpts.Language != "" && lang != importOpts.Language {
				continue
			}

			value := strings.TrimSpace(record[idx])

			// 检查是否已存在
			if items, ok := translations[lang]; ok {
				if existing := getValueByKey(items, key); existing != nil && !importOpts.Overwrite {
					continue
				}
			}

			if _, ok := translations[lang]; !ok {
				translations[lang] = make(map[string]interface{})
			}

			if !importOpts.DryRun {
				setNestedKey(translations[lang], key, value)
			}
			imported++
		}
	}

	fmt.Printf("✅ 已导入 %d 条翻译\n", imported)
	return nil
}

func importJSON(input string, translations map[string]map[string]interface{}, config *Config) error {
	data, err := os.ReadFile(input)
	if err != nil {
		return err
	}

	var imported map[string]map[string]interface{}
	if err := json.Unmarshal(data, &imported); err != nil {
		return fmt.Errorf("解析 JSON 失败: %w", err)
	}

	importedCount := 0
	for lang, items := range imported {
		// 如果指定了语言，只导入该语言
		if importOpts.Language != "" && lang != importOpts.Language {
			continue
		}

		if _, ok := translations[lang]; !ok {
			translations[lang] = make(map[string]interface{})
		}

		for key, value := range items {
			// 检查是否已存在
			if existing := getValueByKey(translations[lang], key); existing != nil && !importOpts.Overwrite {
				continue
			}

			if !importOpts.DryRun {
				setNestedKey(translations[lang], key, value)
			}
			importedCount++
		}
	}

	fmt.Printf("✅ 已导入 %d 条翻译\n", importedCount)
	return nil
}
