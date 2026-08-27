//
// i18n.go
// Copyright (C) 2026 veypi <i@veypi.com>
//
// Distributed under terms of the MIT license.
//

// Package i18n 提供 vhtml CLI 的国际化管理子命令（scan/add）。
package i18n

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/veypi/vigo/flags"
)

// Config i18n 配置，对应 vhtml.config.json 的 i18n 段。
// 字段经 flags.AutoRegister 注册为命令行参数（env 为字段名大写）。
// 扫描入口不复用独立配置：直接使用全局 -ui（见 Register 注入）。
type Config struct {
	Languages       []string `json:"languages" desc:"支持的语言列表，逗号分隔"`
	DefaultLanguage string   `json:"defaultLanguage" desc:"默认语言，作为翻译的基准语言"`
	Output          string   `json:"output" desc:"输出文件路径，翻译文件的保存位置（默认 {ui}/langs.json）"`
	Include         []string `json:"include" desc:"包含的文件模式，支持 glob 语法"`
	Exclude         []string `json:"exclude" desc:"排除的文件模式，支持 glob 语法"`
	Pattern         string   `json:"pattern" desc:"匹配翻译 key 的正则表达式"`
	Indent          int      `json:"indent" desc:"JSON 缩进空格数"`
	SortKeys        bool     `json:"sortKeys" desc:"是否对 key 进行排序"`
}

// DefaultConfig 返回内置默认配置。
func DefaultConfig() Config {
	return Config{
		Languages:       []string{"zh-CN", "en-US"},
		DefaultLanguage: "zh-CN",
		Include:         []string{"**/*.html", "**/*.js"},
		Exclude:         []string{"node_modules/**", "dist/**", ".git/**"},
		Pattern:         `\$t\(['"]([^'"]+)['"]`,
		Indent:          2,
		SortKeys:        true,
	}
}

// cfg 当前生效的配置，uiDir 全局 -ui 值（扫描入口），由 Register 注入。
var (
	cfg   *Config
	uiDir *string
)

// Register 把 scan/add 子命令注册到 parent（`vhtml i18n`）下。
// ui 为全局 -ui 配置指针：扫描入口直接复用，并在子命令上暴露 -ui flag 以便单次覆盖。
func Register(parent *flags.Flags, c *Config, ui *string) {
	cfg = c
	uiDir = ui

	cmdScan := parent.SubCommand("scan", "扫描代码中的 i18n key，自动排序、清理并报告缺失")
	cmdScan.StringVar(ui, "ui", *ui, "前端目录（i18n 扫描入口，同全局 -ui）")
	cmdScan.AutoRegister(c)
	cmdScan.AutoRegister(&scanOpts)
	cmdScan.Command = runScan

	cmdAdd := parent.SubCommand("add", "添加翻译 key，接收 JSON 格式数据（管道/-json/位置参数）")
	cmdAdd.AllowArgs()
	cmdAdd.StringVar(ui, "ui", *ui, "前端目录（i18n 扫描入口，同全局 -ui）")
	cmdAdd.AutoRegister(c)
	cmdAdd.AutoRegister(&addOpts)
	cmdAdd.Command = func() error { return runAdd(cmdAdd) }
}

// runtimeConfig 由 flag 参数解析出的运行时配置。
type runtimeConfig struct {
	Entry           string
	Output          string
	Languages       []string
	DefaultLanguage string
	Scan            ScanConfig
	Format          FormatConfig
}

// ScanConfig 扫描配置
type ScanConfig struct {
	Include []string
	Exclude []string
	Pattern string
}

// FormatConfig 格式化配置
type FormatConfig struct {
	Indent        int
	SortKeys      bool
	TrailingComma bool
}

// GetConfig 从当前配置获取运行时配置
func GetConfig() *runtimeConfig {
	// 扫描入口直接使用全局 -ui
	entry := "./ui"
	if uiDir != nil && *uiDir != "" {
		entry = *uiDir
	}
	// 输出路径缺省跟随入口目录
	output := cfg.Output
	if output == "" {
		output = filepath.Join(entry, "langs.json")
	}

	return &runtimeConfig{
		Entry:           entry,
		Output:          output,
		Languages:       cfg.Languages,
		DefaultLanguage: cfg.DefaultLanguage,
		Scan: ScanConfig{
			Include: cfg.Include,
			Exclude: cfg.Exclude,
			Pattern: cfg.Pattern,
		},
		Format: FormatConfig{
			Indent:        cfg.Indent,
			SortKeys:      cfg.SortKeys,
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
func SaveTranslations(outputPath string, translations map[string]map[string]interface{}, format FormatConfig, defaultLanguage string) error {
	if format.SortKeys {
		translations = sortTranslationKeysFlat(translations, defaultLanguage)
	}

	data, err := marshalTranslationsOrdered(translations, format.Indent, defaultLanguage)
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

// marshalTranslationsOrdered 按固定语言顺序序列化 JSON，defaultLanguage 需要传入
func marshalTranslationsOrdered(translations map[string]map[string]interface{}, indent int, defaultLanguage string) ([]byte, error) {
	space := strings.Repeat(" ", indent)
	var b strings.Builder
	b.WriteString("{\n")

	// 构建有序语言列表：defaultLanguage 排第一，其余按字母序
	langs := make([]string, 0, len(translations))
	if _, ok := translations[defaultLanguage]; ok {
		langs = append(langs, defaultLanguage)
	}
	otherLangs := make([]string, 0, len(translations))
	for lang := range translations {
		if lang != defaultLanguage {
			otherLangs = append(otherLangs, lang)
		}
	}
	for i := 0; i < len(otherLangs); i++ {
		for j := i + 1; j < len(otherLangs); j++ {
			if otherLangs[i] > otherLangs[j] {
				otherLangs[i], otherLangs[j] = otherLangs[j], otherLangs[i]
			}
		}
	}
	langs = append(langs, otherLangs...)

	for i, lang := range langs {
		b.WriteString(space)
		b.WriteString(jsonString(lang))
		b.WriteString(": ")

		items := translations[lang]
		keys := make([]string, 0, len(items))
		for k := range items {
			keys = append(keys, k)
		}
		for m := 0; m < len(keys); m++ {
			for n := m + 1; n < len(keys); n++ {
				if keys[m] > keys[n] {
					keys[m], keys[n] = keys[n], keys[m]
				}
			}
		}

		b.WriteString("{\n")
		for j, key := range keys {
			valueBytes, err := json.Marshal(items[key])
			if err != nil {
				return nil, err
			}
			b.WriteString(space)
			b.WriteString(space)
			b.WriteString(jsonString(key))
			b.WriteString(": ")
			b.Write(valueBytes)
			if j < len(keys)-1 {
				b.WriteString(",")
			}
			b.WriteString("\n")
		}
		b.WriteString(space)
		b.WriteString("}")
		if i < len(langs)-1 {
			b.WriteString(",")
		}
		b.WriteString("\n")
	}
	b.WriteString("}")
	return []byte(b.String()), nil
}

// jsonString 将字符串转义为 JSON 字符串
func jsonString(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

// sortTranslationKeysFlat 对扁平化翻译 key 进行排序，defaultLanguage 排在最前面
func sortTranslationKeysFlat(translations map[string]map[string]interface{}, defaultLanguage string) map[string]map[string]interface{} {
	sorted := make(map[string]map[string]interface{})

	// 先放 defaultLanguage
	if items, ok := translations[defaultLanguage]; ok {
		sorted[defaultLanguage] = sortKeysFlat(items)
	}

	// 再放其他语言，按字母序
	langKeys := make([]string, 0, len(translations))
	for lang := range translations {
		if lang != defaultLanguage {
			langKeys = append(langKeys, lang)
		}
	}
	for i := 0; i < len(langKeys); i++ {
		for j := i + 1; j < len(langKeys); j++ {
			if langKeys[i] > langKeys[j] {
				langKeys[i], langKeys[j] = langKeys[j], langKeys[i]
			}
		}
	}
	for _, lang := range langKeys {
		sorted[lang] = sortKeysFlat(translations[lang])
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
