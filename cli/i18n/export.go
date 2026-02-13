//
// export.go
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
	"strings"
)

var exportOpts = struct {
	Format      string   `json:"format"`
	Languages   []string `json:"languages"`
	Flat        bool     `json:"flat"`
	OnlyMissing bool     `json:"onlyMissing"`
}{
	Format:      "csv",
	Languages:   []string{},
	Flat:        false,
	OnlyMissing: false,
}

func init() {
	cmdExport := cmdMain.SubCommand("export", "导出翻译文件")
	cmdExport.AutoRegister(&exportOpts)
	cmdExport.Command = runExport
}

func runExport() error {
	config, err := LoadConfig("")
	if err != nil {
		return err
	}

	translations, err := LoadTranslations(config.Output)
	if err != nil {
		return err
	}

	// 确定要导出的语言
	langs := exportOpts.Languages
	if len(langs) == 0 {
		langs = config.Languages
	}

	// 确定输出文件
	output := "translations.csv"
	if len(os.Args) > 2 && !strings.HasPrefix(os.Args[2], "-") {
		output = os.Args[2]
	}

	switch exportOpts.Format {
	case "csv":
		return exportCSV(output, translations, langs, config)
	case "json":
		return exportJSON(output, translations, langs, config)
	default:
		return fmt.Errorf("不支持的格式: %s", exportOpts.Format)
	}
}

func exportCSV(output string, translations map[string]map[string]interface{}, langs []string, config *Config) error {
	file, err := os.Create(output)
	if err != nil {
		return err
	}
	defer file.Close()

	writer := csv.NewWriter(file)
	defer writer.Flush()

	// 写入表头
	headers := []string{"key"}
	headers = append(headers, langs...)
	headers = append(headers, "context")
	writer.Write(headers)

	// 获取所有 keys
	allKeys := getAllKeysFlat(translations[config.DefaultLanguage])

	for _, key := range allKeys {
		// 如果只导出缺失项，检查是否所有目标语言都缺失
		if exportOpts.OnlyMissing {
			allMissing := true
			for _, lang := range langs {
				if lang == config.DefaultLanguage {
					continue
				}
				if items, ok := translations[lang]; ok {
					if getValueByKey(items, key) != nil {
						allMissing = false
						break
					}
				}
			}
			if !allMissing {
				continue
			}
		}

		row := []string{key}
		for _, lang := range langs {
			value := ""
			if items, ok := translations[lang]; ok {
				if v := getValueByKey(items, key); v != nil {
					if s, ok := v.(string); ok {
						value = s
					} else {
						value = fmt.Sprintf("%v", v)
					}
				}
			}
			row = append(row, value)
		}
		row = append(row, "") // context 列
		writer.Write(row)
	}

	fmt.Printf("✅ 已导出到: %s\n", output)
	return nil
}

func exportJSON(output string, translations map[string]map[string]interface{}, langs []string, config *Config) error {
	result := make(map[string]interface{})

	for _, lang := range langs {
		if items, ok := translations[lang]; ok {
			if exportOpts.Flat {
				result[lang] = flattenKeys(items)
			} else {
				result[lang] = items
			}
		}
	}

	data, err := json.MarshalIndent(result, "", "  ")
	if err != nil {
		return err
	}

	if err := os.WriteFile(output, data, 0644); err != nil {
		return err
	}

	fmt.Printf("✅ 已导出到: %s\n", output)
	return nil
}

func flattenKeys(data map[string]interface{}) map[string]string {
	result := make(map[string]string)
	flattenRecursive(data, "", result)
	return result
}

func flattenRecursive(data map[string]interface{}, prefix string, result map[string]string) {
	for k, v := range data {
		key := k
		if prefix != "" {
			key = prefix + "." + k
		}
		if nested, ok := v.(map[string]interface{}); ok {
			flattenRecursive(nested, key, result)
		} else if s, ok := v.(string); ok {
			result[key] = s
		} else {
			result[key] = fmt.Sprintf("%v", v)
		}
	}
}
