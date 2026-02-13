//
// init.go
// Copyright (C) 2026 veypi <i@veypi.com>
//
// Distributed under terms of the MIT license.
//

package main

import (
	"bufio"
	"fmt"
	"os"
	"strings"
)

var initOpts = struct {
	Config string   `json:"config"`
	Langs  []string `json:"langs"`
	Yes    bool     `json:"yes"`
}{
	Config: ".v-i18n.json",
	Langs:  []string{"zh-CN", "en-US"},
	Yes:    false,
}

func init() {
	cmdInit := cmdMain.SubCommand("init", "初始化 i18n 配置文件")
	cmdInit.AutoRegister(&initOpts)
	cmdInit.Command = runInit
}

func runInit() error {
	config := DefaultConfig()

	if !initOpts.Yes {
		reader := bufio.NewReader(os.Stdin)

		// 交互式配置
		fmt.Println("🌍 v-i18n 初始化配置")
		fmt.Println("====================")

		// 扫描入口
		fmt.Printf("扫描入口目录 [%s]: ", config.Entry)
		if input, _ := reader.ReadString('\n'); strings.TrimSpace(input) != "" {
			config.Entry = strings.TrimSpace(input)
		}

		// 输出文件
		fmt.Printf("翻译文件输出路径 [%s]: ", config.Output)
		if input, _ := reader.ReadString('\n'); strings.TrimSpace(input) != "" {
			config.Output = strings.TrimSpace(input)
		}

		// 语言列表
		fmt.Printf("支持的语言（用空格分隔）[%s]: ", strings.Join(config.Languages, " "))
		if input, _ := reader.ReadString('\n'); strings.TrimSpace(input) != "" {
			config.Languages = strings.Fields(strings.TrimSpace(input))
		}

		// 默认语言
		fmt.Printf("默认语言 [%s]: ", config.DefaultLanguage)
		if input, _ := reader.ReadString('\n'); strings.TrimSpace(input) != "" {
			config.DefaultLanguage = strings.TrimSpace(input)
		}

		// 扫描配置
		fmt.Println("\n扫描配置:")
		fmt.Printf("包含文件模式 [%s]: ", strings.Join(config.Scan.Include, ", "))
		if input, _ := reader.ReadString('\n'); strings.TrimSpace(input) != "" {
			config.Scan.Include = strings.Fields(strings.TrimSpace(input))
		}

		fmt.Printf("排除文件模式 [%s]: ", strings.Join(config.Scan.Exclude, ", "))
		if input, _ := reader.ReadString('\n'); strings.TrimSpace(input) != "" {
			config.Scan.Exclude = strings.Fields(strings.TrimSpace(input))
		}
	} else {
		// 使用命令行参数
		if len(initOpts.Langs) > 0 {
			config.Languages = initOpts.Langs
		}
	}

	// 检查配置文件是否已存在
	if _, err := os.Stat(initOpts.Config); err == nil {
		fmt.Printf("⚠️  配置文件 %s 已存在，是否覆盖? [y/N]: ", initOpts.Config)
		reader := bufio.NewReader(os.Stdin)
		input, _ := reader.ReadString('\n')
		if strings.ToLower(strings.TrimSpace(input)) != "y" {
			fmt.Println("已取消")
			return nil
		}
	}

	// 保存配置文件
	if err := config.SaveConfig(initOpts.Config); err != nil {
		return fmt.Errorf("保存配置文件失败: %w", err)
	}

	fmt.Printf("✅ 配置文件已创建: %s\n", initOpts.Config)

	// 初始化翻译文件
	translations := make(map[string]map[string]interface{})
	for _, lang := range config.Languages {
		translations[lang] = make(map[string]interface{})
	}

	if err := SaveTranslations(config.Output, translations, config.Format); err != nil {
		return fmt.Errorf("初始化翻译文件失败: %w", err)
	}

	fmt.Printf("✅ 翻译文件已创建: %s\n", config.Output)
	fmt.Println("\n接下来你可以:")
	fmt.Println("  v-i18n scan    # 扫描代码中的 i18n key")
	fmt.Println("  v-i18n sync    # 同步多语言文件")

	return nil
}
