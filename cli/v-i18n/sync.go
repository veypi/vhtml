//
// sync.go
// Copyright (C) 2026 veypi <i@veypi.com>
//
// Distributed under terms of the MIT license.
//

package main

import (
	"fmt"
)

var syncOpts = struct {
	Source   string   `json:"source" desc:"源语言，作为同步的基准"`
	Target   []string `json:"target" desc:"目标语言列表，为空则同步到所有其他语言"`
	SyncFill string   `json:"syncFill" desc:"填充缺失翻译的值"`
	Mark     bool     `json:"mark" desc:"是否标记新添加的翻译"`
}{
	Source:   "",
	Target:   []string{},
	SyncFill: "",
	Mark:     true,
}

func init() {
	cmdSync := cmdMain.SubCommand("sync", "同步语言文件（以源语言为基准）")
	cmdSync.AutoRegister(&globalOpts)
	cmdSync.AutoRegister(&syncOpts)
	cmdSync.Command = runSync
}

func runSync() error {
	config := GetConfig()

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

	// 获取源语言所有 keys（扁平化直接遍历）
	var sourceKeys []string
	for key := range sourceData {
		sourceKeys = append(sourceKeys, key)
	}

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
			sourceValue := sourceData[key]
			targetValue, exists := targetData[key]

			if !exists {
				// key 不存在，需要添加
				fillValue := syncOpts.SyncFill
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
				targetData[key] = fillValue
				missingCount++
			} else {
				// key 存在，保持原值
				targetData[key] = targetValue
				syncedCount++
			}
		}

		// 删除目标语言中多余的 keys
		removedCount := 0
		for key := range targetData {
			if !contains(sourceKeys, key) {
				delete(targetData, key)
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

// contains 检查切片是否包含元素
func contains(slice []string, item string) bool {
	for _, s := range slice {
		if s == item {
			return true
		}
	}
	return false
}
