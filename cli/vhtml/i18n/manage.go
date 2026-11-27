//
// manage.go
// Copyright (C) 2026 veypi <i@veypi.com>
//
// Distributed under terms of the MIT license.
//

package i18n

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/veypi/vigo/flags"
)

// errNoAddInput 表示未提供任何翻译数据。
var errNoAddInput = errors.New("请提供 JSON 数据，可通过管道、-json 参数或位置参数传入，格式: {\"zh-CN\":{\"key\":\"value\"},\"en-US\":{\"key\":\"value\"}}")

// ========== add 命令 ==========
var addOpts = struct {
	JSON string `json:"json" desc:"JSON 格式翻译数据，如: {\"zh-CN\":{\"key\":\"value\"}}"`
}{
	JSON: "",
}

// readAddInput 按优先级读取 i18n add 的 JSON 输入：
// 1. -json 参数；2. 位置参数；3. stdin 管道。
// 显式参数优先于 stdin——否则在 CI / 重定向 / 非 TTY 环境下，
// stdin 的 EOF 会直接让 -json 与位置参数形式失效。
func readAddInput(cmd *flags.Flags, stdin *os.File) (map[string]map[string]interface{}, error) {
	var input map[string]map[string]interface{}

	parse := func(raw string) error {
		if err := json.Unmarshal([]byte(raw), &input); err != nil {
			return fmt.Errorf("解析 JSON 失败: %w", err)
		}
		return nil
	}

	if addOpts.JSON != "" {
		if err := parse(addOpts.JSON); err != nil {
			return nil, err
		}
		return input, nil
	}

	if cmd.NArg() > 0 {
		// 位置参数形式：vhtml i18n add '{"zh-CN":{...}}'
		if err := parse(strings.Join(cmd.Args(), " ")); err != nil {
			return nil, err
		}
		return input, nil
	}

	stat, err := stdin.Stat()
	if err == nil && (stat.Mode()&os.ModeCharDevice) == 0 {
		// stdin 是管道：空管道按“未提供数据”处理，不报 EOF。
		decoder := json.NewDecoder(stdin)
		if err := decoder.Decode(&input); err != nil {
			if errors.Is(err, io.EOF) {
				return nil, errNoAddInput
			}
			return nil, fmt.Errorf("解析 stdin JSON 失败: %w", err)
		}
		return input, nil
	}

	return nil, errNoAddInput
}

func runAdd(cmd *flags.Flags) error {
	config := GetConfig()

	input, err := readAddInput(cmd, os.Stdin)
	if err != nil {
		return err
	}

	if len(input) == 0 {
		return errNoAddInput
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
