//
// main.go
// Copyright (C) 2024 veypi <i@veypi.com>
// 2025-11-17 13:55:38
// Distributed under terms of the MIT license.
//

package main

import (
	"os"

	"github.com/veypi/vhtml/cli/vhtml/i18n"
	"github.com/veypi/vigo/flags"
	"github.com/veypi/vigo/logv"
)

var version = "v0.9.2" // 与 package.json version 保持同步

func main() {
	cfg := &Config{I18n: i18n.DefaultConfig()}
	// 配置文件必须先于 AutoRegister 加载：字段当前值会成为 flag 的默认值，
	// 从而形成 flag > env > 配置文件 > default 标签 的优先级。
	flags.LoadCfg(configFile, cfg)

	cmd := flags.New("vhtml", "vhtml 命令行工具：零构建前端开发服务器 + i18n 管理\nversion: "+version)
	cmd.AutoRegister(cfg)
	cmd.Command = func() error { return serve(cfg) }

	cmdServe := cmd.SubCommand("serve", "启动开发服务器（默认命令）：静态服务 ./ui + API 代理 + live reload")
	cmdServe.AutoRegister(cfg)
	cmdServe.Command = func() error { return serve(cfg) }

	i18n.Register(cmd.SubCommand("i18n", "国际化（i18n）管理"), &cfg.I18n, &cfg.UI)

	cmdInit := cmd.SubCommand("init", "在当前或指定目录创建 vhtml 项目骨架").AllowArgs()
	cmdInit.Command = func() error {
		dir := cmdInit.Arg(0)
		if dir == "" {
			dir = "."
		}
		return runInit(dir)
	}

	cmd.Parse()
	if err := cmd.Run(); err != nil {
		logv.Warn().Msg(err.Error())
		os.Exit(1)
	}
}
