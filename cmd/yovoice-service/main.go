package main

import (
	"bufio"
	"context"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
	"yovoice/internal/catalog"
	"yovoice/internal/desktop"
	"yovoice/internal/diag"
	"yovoice/internal/platform"
	"yovoice/internal/schema"
	"yovoice/internal/store"
	"yovoice/internal/workbench"
)

func run() error {
	if len(os.Args) > 1 && os.Args[1] == "--prepare-data" {
		return store.PrepareDefault()
	}
	root, secret, assets := os.Getenv("WORKBENCH_DATA"), os.Getenv("WORKBENCH_TOKEN"), os.Getenv("WORKBENCH_WEB")
	if root == "" || assets == "" || len(secret) < 32 {
		return fmt.Errorf("缺少有效的数据目录、界面目录或会话凭证。")
	}
	// 启动前新目录里是否已有数据：迁移完成的新目录一定带 state.json。
	// 若新目录在重启前被删除或外置盘未连接而被重新创建为空目录，绝不能再删除旧目录——那可能是唯一的副本。
	_, stateErr := os.Stat(filepath.Join(root, "state.json"))
	hadState := stateErr == nil
	if e := os.MkdirAll(root, 0700); e != nil {
		return e
	}
	lock, e := platform.Lock(filepath.Join(root, "service.lock"))
	if e != nil {
		return fmt.Errorf("数据目录正被其他应用使用：%w", e)
	}
	defer lock.Close()
	wb, e := workbench.New(root)
	if e != nil {
		return e
	}
	defer wb.Close()
	// 修复悬空引用，避免作品因源音频缺失而永久无法保存。
	if _, e := wb.Reconcile(); e != nil {
		diag.Log(root, "state.reconcile_failed", "error", diag.Error(e))
	}
	go func() {
		// 数据目录迁移后首次在新目录启动：删除旧目录释放空间，失败时下次启动重试。
		if hadState {
			removed, e := store.CleanupPrevious(root)
			if removed != "" || e != nil {
				diag.Log(root, "storage.previous_cleanup", "path", removed, "error", diag.Error(e))
			}
		} else {
			diag.Log(root, "storage.previous_cleanup_skipped", "reason", "data root had no state")
		}
		// 每次启动自动回收残留，生成数据不必依赖用户手动点“清理残留”才能闭环。
		report, e := wb.CleanupResiduals()
		if report.CleanedCount > 0 || e != nil {
			diag.Log(root, "storage.residuals_cleaned", "count", report.CleanedCount, "bytes", report.FreedBytes, "error", diag.Error(e))
		}
	}()
	bundled := os.Getenv("WORKBENCH_ENGINE")
	if runtime.GOOS == "windows" {
		if e = wb.UseBundled(bundled); e != nil {
			return e
		}
	}
	existing := wb.Store.Read()
	// macOS 内置 Metal 内核同时支持 CPU 与 Metal；数据目录中的内核过期时回退到内置内核。
	if _, e = os.Stat(bundled); runtime.GOOS == "darwin" && e == nil && (existing.RuntimePath == nil || strings.HasSuffix(*existing.RuntimePath, "/Contents/Resources/engine/audiocpp_server") || !workbench.RuntimeReady(existing)) {
		if e = wb.Store.Update(func(s *schema.State) {
			s.RuntimePath = &bundled
			backend := s.Preferences.Backend
			if existing.RuntimePath == nil {
				backend = "metal"
				s.Preferences.Backend = backend
			}
			s.RuntimeBackend = &backend
			// 内置 Metal 内核随应用更新，版本始终与当前应用一致。
			version := catalog.EngineVersion
			s.RuntimeVersion = &version
		}, true); e != nil {
			return e
		}
	}
	listener, e := net.Listen("tcp4", "127.0.0.1:0")
	if e != nil {
		return e
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var once sync.Once
	stop := func() { once.Do(cancel) }
	// 本机接口启动失败（如端口被占用）不影响桌面应用，错误在设置页展示。
	localAPI := &desktop.LocalAPI{Workbench: wb, Context: ctx}
	_ = localAPI.Apply()
	handler := &desktop.Server{Workbench: wb, Assets: assets, Secret: secret, Shutdown: stop, LocalAPI: localAPI}
	server := &http.Server{Handler: handler, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second, BaseContext: func(net.Listener) context.Context { return ctx }}
	go func() { _, _ = bufio.NewReader(os.Stdin).ReadString('\n'); stop() }()
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(signals)
	go func() {
		select {
		case <-signals:
			stop()
		case <-ctx.Done():
		}
	}()
	shutdownDone := make(chan struct{})
	go func() {
		defer close(shutdownDone)
		<-ctx.Done()
		localAPI.Close()
		wb.Close()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()
	fmt.Println("http://" + listener.Addr().String())
	e = server.Serve(listener)
	// Serve 在监听器关闭后立即返回；等待活动请求完成，避免进程退出截断响应。
	stop()
	<-shutdownDone
	if e == http.ErrServerClosed {
		return nil
	}
	return e
}
func main() {
	if e := run(); e != nil {
		fmt.Fprintln(os.Stderr, e)
		os.Exit(1)
	}
}
