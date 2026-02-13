//
// main.go
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
	"strings"

	"github.com/veypi/vigo/flags"
	"github.com/veypi/vigo/logv"
)

var version = "v0.1.0"

var cmdMain = flags.New("v-i18n", "vhtml 项目的国际化（i18n）管理工具\nversion: "+version, nil)

func main() {
	cmdMain.Parse()
	err := cmdMain.Run()
	if err != nil {
		logv.Warn().Msg(err.Error())
		os.Exit(1)
	}
}

// Config 配置文件结构
type Config struct {
	Entry           string   `json:"entry"`
	Output          string   `json:"output"`
	Languages       []string `json:"languages"`
	DefaultLanguage string   `json:"defaultLanguage"`
	Scan            ScanConfig `json:"scan"`
	Format          FormatConfig `json:"format"`
}

// ScanConfig 扫描配置
type ScanConfig struct {
	Include []string `json:"include"`
	Exclude []string `json:"exclude"`
	Pattern string   `json:"pattern"`
}

// FormatConfig 格式化配置
type FormatConfig struct {
	Indent        int  `json:"indent"`
	SortKeys      bool `json:"sortKeys"`
	TrailingComma bool `json:"trailingComma"`
}

// DefaultConfig 返回默认配置
func DefaultConfig() *Config {
	return &Config{
		Entry:           "./ui",
		Output:          "./ui/langs.json",
		Languages:       []string{"zh-CN", "en-US"},
		DefaultLanguage: "zh-CN",
		Scan: ScanConfig{
			Include: []string{"**/*.html", "**/*.js"},
			Exclude: []string{"node_modules/**", "dist/**", ".git/**"},
			Pattern: `\$t\(['"]([^'"]+)['"]`,
		},
		Format: FormatConfig{
			Indent:        2,
			SortKeys:      true,
			TrailingComma: false,
		},
	}
}

// LoadConfig 加载配置文件
func LoadConfig(configPath string) (*Config, error) {
	if configPath == "" {
		// 尝试查找默认配置文件
		for _, name := range []string{".v-i18n.json", "v-i18n.config.js", "v-i18n.config.json"} {
			if _, err := os.Stat(name); err == nil {
				configPath = name
				break
			}
		}
	}

	if configPath == "" {
		return nil, fmt.Errorf("未找到配置文件，请运行 'v-i18n init' 初始化")
	}

	data, err := os.ReadFile(configPath)
	if err != nil {
		return nil, fmt.Errorf("读取配置文件失败: %w", err)
	}

	config := DefaultConfig()
	if err := json.Unmarshal(data, config); err != nil {
		return nil, fmt.Errorf("解析配置文件失败: %w", err)
	}

	// 转换相对路径为绝对路径
	if !filepath.IsAbs(config.Entry) {
		config.Entry = filepath.Join(filepath.Dir(configPath), config.Entry)
	}
	if !filepath.IsAbs(config.Output) {
		config.Output = filepath.Join(filepath.Dir(configPath), config.Output)
	}

	return config, nil
}

// SaveConfig 保存配置文件
func (c *Config) SaveConfig(configPath string) error {
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(configPath, data, 0644)
}

// LoadTranslations 加载翻译文件
func LoadTranslations(outputPath string) (map[string]map[string]interface{}, error) {
	data, err := os.ReadFile(outputPath)
	if err != nil {
		if os.IsNotExist(err) {
			return make(map[string]map[string]interface{}), nil
		}
		return nil, err
	}

	var translations map[string]map[string]interface{}
	if err := json.Unmarshal(data, &translations); err != nil {
		return nil, fmt.Errorf("解析翻译文件失败: %w", err)
	}

	return translations, nil
}

// SaveTranslations 保存翻译文件
func SaveTranslations(outputPath string, translations map[string]map[string]interface{}, format FormatConfig) error {
	var data []byte
	var err error

	if format.SortKeys {
		translations = sortTranslationKeys(translations)
	}

	if format.TrailingComma {
		// Go 的 json 库不支持 trailing comma，需要手动处理
		data, err = jsonMarshalWithTrailingComma(translations, format.Indent)
	} else {
		data, err = json.MarshalIndent(translations, "", strings.Repeat(" ", format.Indent))
	}

	if err != nil {
		return err
	}

	// 确保目录存在
	dir := filepath.Dir(outputPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}

	return os.WriteFile(outputPath, data, 0644)
}

// sortTranslationKeys 对翻译 key 进行排序
func sortTranslationKeys(translations map[string]map[string]interface{}) map[string]map[string]interface{} {
	sorted := make(map[string]map[string]interface{})
	for lang, items := range translations {
		sorted[lang] = sortKeysRecursive(items)
	}
	return sorted
}

func sortKeysRecursive(data map[string]interface{}) map[string]interface{} {
	sorted := make(map[string]interface{})
	keys := make([]string, 0, len(data))
	for k := range data {
		keys = append(keys, k)
	}

	// 简单排序
	for i := 0; i < len(keys); i++ {
		for j := i + 1; j < len(keys); j++ {
			if keys[i] > keys[j] {
				keys[i], keys[j] = keys[j], keys[i]
			}
		}
	}

	for _, k := range keys {
		v := data[k]
		if nested, ok := v.(map[string]interface{}); ok {
			sorted[k] = sortKeysRecursive(nested)
		} else {
			sorted[k] = v
		}
	}
	return sorted
}

// jsonMarshalWithTrailingComma 带尾随逗号的 JSON 序列化
func jsonMarshalWithTrailingComma(v interface{}, indent int) ([]byte, error) {
	// 简化实现，先使用标准序列化
	return json.MarshalIndent(v, "", string(make([]byte, indent)))
}
