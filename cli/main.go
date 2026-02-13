//
// main.go
// Copyright (C) 2024 veypi <i@veypi.com>
// 2025-11-17 13:55:38
// Distributed under terms of the MIT license.
//

package main

import (
	"github.com/veypi/vhtml"

	"github.com/veypi/vigo"
	"github.com/veypi/vigo/flags"
	"github.com/veypi/vigo/logv"
)

var version = "v0.1.0"

var cmdMain = flags.New("vflow", "the backend server of vhtml doc. \nversion: "+version, cliOpts)

// subCMD  = cmdMain.SubCommand("name", "desc")

var cliOpts = &struct {
	Host string `json:"host"`
	Port int    `json:"port" short:"p"`
}{
	Host: "0.0.0.0",
	Port: 4000,
}

func init() {
	cmdMain.Command = runWeb
	// subCMD.AutoRegister(opts)
	// subCMD.Command = cmd
}

func main() {
	cmdMain.Parse()
	err := cmdMain.Run()
	if err != nil {
		logv.Warn().Msg(err.Error())
	}
}

func runWeb() error {
	server, err := vigo.New(vigo.WithHost(cliOpts.Host), vigo.WithPort(cliOpts.Port))
	if err != nil {
		return err
	}
	server.SetRouter(vhtml.Router)
	return server.Run()
}
