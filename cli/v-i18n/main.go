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

// 全局配置参数
var globalOpts = struct {
	Entry           string   `json:"entry" desc:"入口目录，需要扫描的源代码目录"`
	Output          string   `json:"output" desc:"输出文件路径，翻译文件的保存位置"`
	Languages       []string `json:"languages" desc:"支持的语言列表，逗号分隔"`
	DefaultLanguage string   `json:"defaultLanguage" desc:"默认语言，作为翻译的基准语言"`
	Include         []string `json:"include" desc:"包含的文件模式，支持 glob 语法"`
	Exclude         []string `json:"exclude" desc:"排除的文件模式，支持 glob 语法"`
	Pattern         string   `json:"pattern" desc:"匹配翻译 key 的正则表达式"`
	Indent          int      `json:"indent" desc:"JSON 缩进空格数"`
	SortKeys        bool     `json:"sortKeys" desc:"是否对 key 进行排序"`
}{
	Entry:           "./ui",
	Output:          "./ui/langs.json",
	Languages:       []string{"zh-CN", "en-US"},
	DefaultLanguage: "zh-CN",
	Include:         []string{"**/*.html", "**/*.js"},
	Exclude:         []string{"node_modules/**", "dist/**", ".git/**"},
	Pattern:         `\$t\(['"]([^'"]+)['"]`,
	Indent:          2,
	SortKeys:        true,
}

var cmdMain = flags.New("v-i18n", "vhtml 项目的国际化（i18n）管理工具\nversion: "+version, nil)

func init() {
	cmdMain.AutoRegister(&globalOpts)
}

func main() {
	cmdMain.Parse()
	err := cmdMain.Run()
	if err != nil {
		logv.Warn().Msg(err.Error())
		os.Exit(1)
	}
}

// Config 配置结构
type Config struct {
	Entry           string       `json:"entry"`
	Output          string       `json:"output"`
	Languages       []string     `json:"languages"`
	DefaultLanguage string       `json:"defaultLanguage"`
	Scan            ScanConfig   `json:"scan"`
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

// GetConfig 从全局参数获取配置
func GetConfig() *Config {
	return &Config{
		Entry:           globalOpts.Entry,
		Output:          globalOpts.Output,
		Languages:       globalOpts.Languages,
		DefaultLanguage: globalOpts.DefaultLanguage,
		Scan: ScanConfig{
			Include: globalOpts.Include,
			Exclude: globalOpts.Exclude,
			Pattern: globalOpts.Pattern,
		},
		Format: FormatConfig{
			Indent:        globalOpts.Indent,
			SortKeys:      globalOpts.SortKeys,
			TrailingComma: false,
		},
	}
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
		translations = sortTranslationKeysFlat(translations)
	}

	if format.TrailingComma {
		data, err = jsonMarshalWithTrailingComma(translations, format.Indent)
	} else {
		data, err = json.MarshalIndent(translations, "", strings.Repeat(" ", format.Indent))
	}

	if err != nil {
		return err
	}

	// 确保目录存在
	dir := filepath.Dir(outputPath)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}

	return os.WriteFile(outputPath, data, 0o644)
}

// sortTranslationKeysFlat 对扁平化翻译 key 进行排序
func sortTranslationKeysFlat(translations map[string]map[string]interface{}) map[string]map[string]interface{} {
	sorted := make(map[string]map[string]interface{})
	for lang, items := range translations {
		sorted[lang] = sortKeysFlat(items)
	}
	return sorted
}

func sortKeysFlat(data map[string]interface{}) map[string]interface{} {
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
		sorted[k] = data[k]
	}
	return sorted
}

// jsonMarshalWithTrailingComma 带尾随逗号的 JSON 序列化
func jsonMarshalWithTrailingComma(v interface{}, indent int) ([]byte, error) {
	return json.MarshalIndent(v, "", strings.Repeat(" ", indent))
}
