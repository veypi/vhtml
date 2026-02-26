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
)

func main() {
	app := vigo.New("vhtml", vhtml.Router, struct{}{}, func() error { return nil })
	panic(app.Run())
}
