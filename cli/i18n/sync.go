//
// sync.go
// Copyright (C) 2026 veypi <i@veypi.com>
//
// Distributed under terms of the MIT license.
//

package main

import (
	"fmt"
	"strings"
)

var syncOpts = struct {
	Source string   `json:"source"`
	Target []string `json:"target"`
	Fill   string   `json:"fill"`
	Mark   bool     `json:"mark"`
}{
	Source: "",
	Target: []string{},
	Fill:   "",
	Mark:   true,
}

func init() {
	cmdSync := cmdMain.SubCommand("sync", "同步语言文件（以源语言为基准）")
	cmdSync.AutoRegister(&syncOpts)
	cmdSync.Command = runSync
}

func runSync() error {
	config, err := LoadConfig("")
	if err != nil {
		return err
	}

	// 加载翻译文件
	translations, err := LoadTranslations(config.Output)
	if err != nil {
		return err
	}

	// 确定源语言
	sourceLang := syncOpts.Source
	if sourceLang == "" {
		sourceLang = config.DefaultLanguage
	}

	sourceData, ok := translations[sourceLang]
	if !ok {
		return fmt.Errorf("源语言 %s 不存在", sourceLang)
	}

	// 确定目标语言
	targetLangs := syncOpts.Target
	if len(targetLangs) == 0 {
		for _, lang := range config.Languages {
			if lang != sourceLang {
				targetLangs = append(targetLangs, lang)
			}
		}
	}

	// 获取源语言所有 keys
	sourceKeys := getAllKeysFlat(sourceData)

	// 同步每个目标语言
	for _, targetLang := range targetLangs {
		targetData, ok := translations[targetLang]
		if !ok {
			targetData = make(map[string]interface{})
			translations[targetLang] = targetData
		}

		syncedCount := 0
		missingCount := 0

		for _, key := range sourceKeys {
			sourceValue := getValueByKey(sourceData, key)
			targetValue := getValueByKey(targetData, key)

			if targetValue == nil {
				// key 不存在，需要添加
				fillValue := syncOpts.Fill
				if fillValue == "" {
					// 使用源语言值作为填充
					if sv, ok := sourceValue.(string); ok {
						fillValue = sv
					} else {
						fillValue = ""
					}
				}
				if syncOpts.Mark && fillValue != "" {
					fillValue = "🔴 " + fillValue
				}
				setNestedKey(targetData, key, fillValue)
				missingCount++
			} else {
				// key 存在，保持原值
				setNestedKey(targetData, key, targetValue)
				syncedCount++
			}
		}

		// 删除目标语言中多余的 keys
		targetKeys := getAllKeysFlat(targetData)
		removedCount := 0
		for _, key := range targetKeys {
			if !contains(sourceKeys, key) {
				deleteNestedKey(targetData, key)
				removedCount++
			}
		}

		fmt.Printf("✅ %s: 已同步 %d 个, 新增 %d 个, 删除 %d 个\n",
			targetLang, syncedCount, missingCount, removedCount)
	}

	// 保存翻译文件
	if err := SaveTranslations(config.Output, translations, config.Format); err != nil {
		return fmt.Errorf("保存翻译文件失败: %w", err)
	}

	fmt.Printf("\n✅ 同步完成，已保存到 %s\n", config.Output)
	return nil
}

// getAllKeysFlat 获取所有 keys（扁平化）
func getAllKeysFlat(data map[string]interface{}) []string {
	var keys []string
	extractKeysFlat(data, "", &keys)
	return keys
}

func extractKeysFlat(data map[string]interface{}, prefix string, keys *[]string) {
	for k, v := range data {
		key := k
		if prefix != "" {
			key = prefix + "." + k
		}
		if nested, ok := v.(map[string]interface{}); ok {
			extractKeysFlat(nested, key, keys)
		} else {
			*keys = append(*keys, key)
		}
	}
}

// getValueByKey 通过 key 获取值
func getValueByKey(data map[string]interface{}, key string) interface{} {
	parts := strings.Split(key, ".")
	current := data
	for i, part := range parts {
		if i == len(parts)-1 {
			return current[part]
		}
		if nested, ok := current[part].(map[string]interface{}); ok {
			current = nested
		} else {
			return nil
		}
	}
	return nil
}

// contains 检查切片是否包含元素
func contains(slice []string, item string) bool {
	for _, s := range slice {
		if s == item {
			return true
		}
	}
	return false
}
