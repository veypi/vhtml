//
// reload.go
// Copyright (C) 2026 veypi <i@veypi.com>
//
// Distributed under terms of the MIT license.
//

package main

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/veypi/vigo"
)

// reloadHub SSE 广播中心 + 文件系统监听。
type reloadHub struct {
	mu      sync.Mutex
	clients map[chan struct{}]bool
}

func newReloadHub() *reloadHub {
	return &reloadHub{clients: make(map[chan struct{}]bool)}
}

// serveHTTP SSE 端点：客户端保持长连接，文件变更时收到 "reload" 事件。
func (h *reloadHub) serveHTTP(x *vigo.X) {
	w := x.ResponseWriter()
	flusher, ok := w.(http.Flusher)
	if !ok {
		x.WriteHeader(http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	ch := make(chan struct{}, 1)
	h.mu.Lock()
	h.clients[ch] = true
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		delete(h.clients, ch)
		h.mu.Unlock()
	}()

	_, _ = fmt.Fprintf(w, ": connected\n\n")
	flusher.Flush()

	ctx := x.Request.Context()
	keepalive := time.NewTicker(25 * time.Second)
	defer keepalive.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ch:
			_, _ = fmt.Fprintf(w, "data: reload\n\n")
			flusher.Flush()
		case <-keepalive.C:
			_, _ = fmt.Fprintf(w, ": ping\n\n")
			flusher.Flush()
		}
	}
}

func (h *reloadHub) broadcast() {
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.clients {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
}

// ignoreDirs 不监听的目录名。
var ignoreDirs = map[string]bool{
	"node_modules": true,
	".git":         true,
	"dist":         true,
}

// watch 递归监听 root 目录，变更去抖 100ms 后广播 reload。
func (h *reloadHub) watch(root string) error {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return err
	}
	err = filepath.Walk(root, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			if p != root && ignoreDirs[info.Name()] {
				return filepath.SkipDir
			}
			return watcher.Add(p)
		}
		return nil
	})
	if err != nil {
		return err
	}

	go func() {
		var timer *time.Timer
		var timerC <-chan time.Time
		for {
			select {
			case ev, ok := <-watcher.Events:
				if !ok {
					return
				}
				// 新建目录补挂监听
				if ev.Op&fsnotify.Create != 0 {
					if st, err := os.Stat(ev.Name); err == nil && st.IsDir() && !ignoreDirs[filepath.Base(ev.Name)] {
						_ = watcher.Add(ev.Name)
					}
				}
				if ev.Op&(fsnotify.Write|fsnotify.Create|fsnotify.Remove|fsnotify.Rename) != 0 {
					if timer == nil {
						timer = time.NewTimer(100 * time.Millisecond)
						timerC = timer.C
					} else {
						timer.Reset(100 * time.Millisecond)
					}
				}
			case _, ok := <-watcher.Errors:
				if !ok {
					return
				}
			case <-timerC:
				timer = nil
				timerC = nil
				h.broadcast()
			}
		}
	}()
	return nil
}
