//
// stats.go
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
)

var statsOpts = struct {
	StatsOutput string `json:"statsOutput"`
	StatsFormat string `json:"statsFormat"`
}{
	StatsOutput: "",
	StatsFormat: "table",
}

func init() {
	cmdStats := cmdMain.SubCommand("stats", "显示翻译统计信息")
	cmdStats.AutoRegister(&globalOpts)
	cmdStats.AutoRegister(&statsOpts)
	cmdStats.Command = runStats
}

type LangStats struct {
	Language string  `json:"language"`
	Total    int     `json:"total"`
	Done     int     `json:"done"`
	Coverage float64 `json:"coverage"`
}

func runStats() error {
	config := GetConfig()

	translations, err := LoadTranslations(config.Output)
	if err != nil {
		return err
	}

	// 获取基准语言的所有 keys
	baseKeys := getAllKeysFlat(translations[config.DefaultLanguage])
	totalKeys := len(baseKeys)

	// 统计每种语言
	var stats []LangStats
	for _, lang := range config.Languages {
		items, ok := translations[lang]
		if !ok {
			stats = append(stats, LangStats{
				Language: lang,
				Total:    totalKeys,
				Done:     0,
				Coverage: 0,
			})
			continue
		}

		done := 0
		for _, key := range baseKeys {
			if value := getValueByKey(items, key); value != nil {
				if v, ok := value.(string); ok && v != "" {
					done++
				}
			}
		}

		coverage := float64(0)
		if totalKeys > 0 {
			coverage = float64(done) / float64(totalKeys) * 100
		}

		stats = append(stats, LangStats{
			Language: lang,
			Total:    totalKeys,
			Done:     done,
			Coverage: coverage,
		})
	}

	// 输出
	if statsOpts.StatsOutput != "" {
		return saveStats(stats, statsOpts.StatsOutput, statsOpts.StatsFormat)
	}

	printStats(stats)
	return nil
}

func printStats(stats []LangStats) {
	fmt.Println("┌──────────┬────────┬────────┬──────────┐")
	fmt.Println("│ Language │ Total  │ Done   │ Coverage │")
	fmt.Println("├──────────┼────────┼────────┼──────────┤")
	for _, s := range stats {
		fmt.Printf("│ %-8s │ %-6d │ %-6d │ %6.1f%%  │\n",
			s.Language, s.Total, s.Done, s.Coverage)
	}
	fmt.Println("└──────────┴────────┴────────┴──────────┘")
}

func saveStats(stats []LangStats, output, format string) error {
	switch format {
	case "json":
		data, err := json.MarshalIndent(stats, "", "  ")
		if err != nil {
			return err
		}
		return os.WriteFile(output, data, 0644)
	case "csv":
		file, err := os.Create(output)
		if err != nil {
			return err
		}
		defer file.Close()

		writer := csv.NewWriter(file)
		defer writer.Flush()

		writer.Write([]string{"Language", "Total", "Done", "Coverage"})
		for _, s := range stats {
			writer.Write([]string{
				s.Language,
				fmt.Sprintf("%d", s.Total),
				fmt.Sprintf("%d", s.Done),
				fmt.Sprintf("%.2f", s.Coverage),
			})
		}
		return nil
	default:
		return fmt.Errorf("不支持的格式: %s", format)
	}
}
