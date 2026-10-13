package workbench

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
	"yovoice/internal/msg"
	"yovoice/internal/schema"
	"yovoice/internal/store"
)

type StorageInfo struct {
	Root           string `json:"root"`
	ModelsBytes    int64  `json:"modelsBytes"`
	OutputsBytes   int64  `json:"outputsBytes"`
	VoicesBytes    int64  `json:"voicesBytes"`
	DownloadsBytes int64  `json:"downloadsBytes"`
	TotalBytes     int64  `json:"totalBytes"`
	PendingPath    string `json:"pendingPath,omitempty"`
}

// StorageInfo 返回当前数据目录大小与重定向状态。
func (w *Workbench) StorageInfo() (StorageInfo, error) {
	root := w.Store.Root
	var info StorageInfo
	info.Root = root
	info.PendingPath = w.pendingDataPath

	info.ModelsBytes = dirSize(filepath.Join(root, "models"))
	info.OutputsBytes = dirSize(filepath.Join(root, "outputs"))
	info.VoicesBytes = dirSize(filepath.Join(root, "voices"))
	info.DownloadsBytes = dirSize(filepath.Join(root, "downloads"))
	info.TotalBytes = dirSize(root)

	return info, nil
}

func dirSize(path string) int64 {
	var total int64
	_ = filepath.Walk(path, func(_ string, info os.FileInfo, err error) error {
		if err == nil && info != nil && !info.IsDir() {
			total += info.Size()
		}
		return nil
	})
	return total
}

// RelocateStorage 将数据目录完整复制到新位置，改写内部路径并记录重定向配置，重启后生效。
// 迁移期间旧目录保持不动：任何一步失败只清理新目录里本次写入的内容，不会损坏现有数据；
// 新目录成功启动后才由 store.CleanupPrevious 删除旧目录，释放原磁盘空间。
func (w *Workbench) RelocateStorage(targetPath string) error {
	w.edit.Lock()
	defer w.edit.Unlock()
	if w.pendingDataPath != "" {
		return msg.Err(msg.ErrStorageRestart, nil)
	}

	targetPath = filepath.Clean(targetPath)
	if !filepath.IsAbs(targetPath) {
		return msg.Err(msg.ErrAudioPathInvalid, nil)
	}
	currentRoot := filepath.Clean(w.Store.Root)
	if store.SamePath(targetPath, currentRoot) {
		return msg.Err(msg.ErrStorageSame, nil)
	}
	// 新目录位于当前数据目录内会被自身复制；当前目录位于新目录内则新目录必然非空。
	if store.Within(currentRoot, targetPath) || store.Within(targetPath, currentRoot) {
		return msg.Err(msg.ErrStorageInsideData, nil)
	}
	// 更新程序会备份并替换安装目录，因此新数据目录绝不能位于安装目录内。
	if installDir := detectInstallDir(); installDir != "" && store.Within(installDir, targetPath) {
		return msg.Err(msg.ErrStorageInsideApp, nil)
	}

	createdTarget := false
	if entries, err := os.ReadDir(targetPath); err == nil {
		if len(entries) > 0 {
			return msg.Err(msg.ErrStorageTargetNotEmpty, nil)
		}
	} else if os.IsNotExist(err) {
		createdTarget = true
	} else {
		return err
	}

	// 占用后台操作槽位：迁移期间拒绝开始生成或下载，用户也可以取消迁移。
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	w.mu.Lock()
	if w.closed || w.cancel != nil || w.installCancel != nil {
		w.mu.Unlock()
		return msg.Err(msg.ErrBusy, nil)
	}
	done := make(chan struct{})
	w.cancel, w.done = cancel, done
	w.mu.Unlock()
	defer func() {
		w.mu.Lock()
		w.cancel = nil
		close(done)
		w.mu.Unlock()
	}()

	// 迁移前把当前状态完整落盘，并以内存快照作为新目录的状态来源。
	if err := w.Store.Update(func(_ *schema.State) {}, true); err != nil {
		return err
	}
	snapshot := w.Store.Read()

	if err := os.MkdirAll(targetPath, 0700); err != nil {
		return err
	}
	cleanupTarget := func() {
		if createdTarget {
			_ = os.RemoveAll(targetPath)
			return
		}
		// 用户选择的空文件夹本身保留，只删除本次复制进去的内容。
		if entries, err := os.ReadDir(targetPath); err == nil {
			for _, entry := range entries {
				_ = os.RemoveAll(filepath.Join(targetPath, entry.Name()))
			}
		}
	}

	totalBytes := dirSize(currentRoot)
	_ = w.Store.Update(func(s *schema.State) {
		s.Activity = &schema.Activity{Kind: "relocate", Code: msg.ActivityRelocate, Status: "running", Total: totalBytes, StartedAt: time.Now().UTC()}
	}, false)
	defer func() {
		_ = w.Store.Update(func(s *schema.State) {
			if s.Activity != nil && s.Activity.Kind == "relocate" {
				s.Activity = nil
			}
		}, false)
	}()

	var lastReported int64
	lastReportTime := time.Now()
	onProgress := func(copied int64) {
		if copied > lastReported && time.Since(lastReportTime) >= 200*time.Millisecond {
			lastReported, lastReportTime = copied, time.Now()
			_ = w.Store.Update(func(s *schema.State) {
				if s.Activity != nil && s.Activity.Kind == "relocate" {
					s.Activity.Received = copied
				}
			}, false)
		}
	}
	if err := copyDirectoryContentsWithProgress(ctx, currentRoot, targetPath, onProgress); err != nil {
		cleanupTarget()
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return fmt.Errorf("复制数据失败: %w", err)
	}

	// 新目录的 state.json 由内存快照生成，指向旧目录的绝对路径全部改写到新目录。
	rebase := func(p string) string {
		if p != "" && store.Within(currentRoot, p) {
			if rel, err := filepath.Rel(currentRoot, p); err == nil {
				return filepath.Join(targetPath, rel)
			}
		}
		return p
	}
	rebasePtr := func(p *string) *string {
		if p == nil {
			return nil
		}
		next := rebase(*p)
		return &next
	}
	snapshot.RuntimePath = rebasePtr(snapshot.RuntimePath)
	snapshot.Preferences.ModelDirectory = rebasePtr(snapshot.Preferences.ModelDirectory)
	for i := range snapshot.Models {
		snapshot.Models[i].Path = rebase(snapshot.Models[i].Path)
	}
	for backend, installed := range snapshot.Runtimes {
		installed.Path = rebase(installed.Path)
		snapshot.Runtimes[backend] = installed
	}
	snapshot.Activity = nil
	snapshot.ModelActivity = nil
	if err := store.WriteState(filepath.Join(targetPath, "state.json"), snapshot); err != nil {
		cleanupTarget()
		return fmt.Errorf("写入新目录状态失败: %w", err)
	}

	if err := store.WriteConfig(store.StorageConfig{DataPath: targetPath, PreviousPath: currentRoot}); err != nil {
		cleanupTarget()
		return fmt.Errorf("写入存储配置失败: %w", err)
	}

	// 重启前的修改只会写进旧目录，随后被丢弃；冻结持久化写入，让用户明确知道需要重启。
	w.Store.Freeze()
	w.pendingDataPath = targetPath
	return nil
}

// detectInstallDir 获取当前应用的安装根目录。
func detectInstallDir() string {
	if webDir := os.Getenv("WORKBENCH_WEB"); webDir != "" {
		return filepath.Clean(filepath.Dir(webDir))
	}
	if exe, err := os.Executable(); err == nil {
		dir := filepath.Dir(exe)
		if filepath.Base(dir) == "service" {
			return filepath.Clean(filepath.Dir(dir))
		}
		return filepath.Clean(dir)
	}
	return ""
}

// skipRelocate 列出不复制到新目录的条目：锁文件属于当前进程，状态文件由内存快照重新生成，
// 待删除标记与未保存试听在重启时本就会被清理。
func skipRelocate(rel string, info os.FileInfo) bool {
	name := info.Name()
	if rel == "service.lock" || rel == "state.json" || rel == "state.backup.json" {
		return true
	}
	if strings.HasSuffix(name, ".deleted") || strings.HasPrefix(name, ".state-") {
		return true
	}
	return info.Mode()&os.ModeSymlink != 0
}

// copyDirectoryContentsWithProgress 递归复制目录内容，并实时汇报累计复制字节。
func copyDirectoryContentsWithProgress(ctx context.Context, src, dst string, onProgress func(copied int64)) error {
	var totalCopied int64
	return filepath.Walk(src, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		if rel == "." {
			return nil
		}
		if skipRelocate(rel, info) {
			if info.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		target := filepath.Join(dst, rel)
		if info.IsDir() {
			return os.MkdirAll(target, 0700)
		}
		if !info.Mode().IsRegular() {
			return nil
		}
		copied, err := copyFileChunked(ctx, path, target, func(n int64) {
			if onProgress != nil {
				onProgress(totalCopied + n)
			}
		})
		if err != nil {
			return err
		}
		totalCopied += copied
		if onProgress != nil {
			onProgress(totalCopied)
		}
		return nil
	})
}

type progressWriter struct {
	ctx     context.Context
	out     io.Writer
	written int64
	report  func(int64)
}

func (p *progressWriter) Write(b []byte) (int, error) {
	if err := p.ctx.Err(); err != nil {
		return 0, err
	}
	n, err := p.out.Write(b)
	p.written += int64(n)
	p.report(p.written)
	return n, err
}

// copyFileChunked 复制单个文件并落盘；大文件复制过程中也会汇报进度并响应取消。
func copyFileChunked(ctx context.Context, src, dst string, report func(int64)) (int64, error) {
	in, err := os.Open(src)
	if err != nil {
		return 0, err
	}
	defer in.Close()
	if err := os.MkdirAll(filepath.Dir(dst), 0700); err != nil {
		return 0, err
	}
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0600)
	if err != nil {
		return 0, err
	}
	n, err := io.Copy(&progressWriter{ctx: ctx, out: out, report: report}, in)
	if err == nil {
		err = out.Sync()
	}
	if ce := out.Close(); err == nil {
		err = ce
	}
	return n, err
}
