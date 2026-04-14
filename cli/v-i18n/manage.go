//
// manage.go
// Copyright (C) 2026 veypi <i@veypi.com>
//
// Distributed under terms of the MIT license.
//

package main

import (
	"encoding/json"
	"fmt"
	"os"
)

// ========== add 命令 ==========
var addOpts = struct {
	JSON string `json:"json" desc:"JSON 格式翻译数据，如: {\"zh-CN\":{\"key\":\"value\"}}"`
}{
	JSON: "",
}

func init() {
	cmdAdd := cmdMain.SubCommand("add", "添加翻译 key，接收 JSON 格式数据")
	cmdAdd.AutoRegister(&globalOpts)
	cmdAdd.AutoRegister(&addOpts)
	cmdAdd.Command = runAdd
}

func runAdd() error {
	config := GetConfig()

	// 读取 JSON 输入
	var input map[string]map[string]interface{}
	var raw string

	stat, _ := os.Stdin.Stat()
	if (stat.Mode() & os.ModeCharDevice) == 0 {
		// 有管道输入
		decoder := json.NewDecoder(os.Stdin)
		if err := decoder.Decode(&input); err != nil {
			return fmt.Errorf("解析 stdin JSON 失败: %w", err)
		}
	} else if addOpts.JSON != "" {
		raw = addOpts.JSON
	} else if len(os.Args) > 2 {
		// 尝试从剩余参数拼接（支持 v-i18n add '{"zh-CN":{...}}'）
		raw = os.Args[len(os.Args)-1]
	}

	if raw != "" {
		if err := json.Unmarshal([]byte(raw), &input); err != nil {
			return fmt.Errorf("解析 JSON 失败: %w", err)
		}
	}

	if len(input) == 0 {
		return fmt.Errorf("请提供 JSON 数据，可通过管道、-json 参数或位置参数传入，格式: {\"zh-CN\":{\"key\":\"value\"},\"en-US\":{\"key\":\"value\"}}")
	}

	translations, err := LoadTranslations(config.Output)
	if err != nil {
		return err
	}

	// 确保所有语言都存在
	for _, lang := range config.Languages {
		if _, ok := translations[lang]; !ok {
			translations[lang] = make(map[string]interface{})
		}
	}

	addedCount := 0
	for lang, items := range input {
		for key, value := range items {
			if _, ok := translations[lang]; ok {
				translations[lang][key] = value
				addedCount++
			}
		}
	}

	if err := SaveTranslations(config.Output, translations, config.Format, config.DefaultLanguage); err != nil {
		return fmt.Errorf("保存翻译文件失败: %w", err)
	}

	fmt.Printf("✅ 已添加/更新 %d 条翻译\n", addedCount)
	return nil
}
