package workbench

import (
	"encoding/json"
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

// RelocateStorage 将数据目录迁移到新位置，支持同盘重命名或跨盘完整复制，改写内部路径并记录重定向配置。
func (w *Workbench) RelocateStorage(targetPath string) error {
	w.edit.Lock()
	defer w.edit.Unlock()

	targetPath = filepath.Clean(targetPath)
	if !filepath.IsAbs(targetPath) {
		return msg.Err(msg.ErrAudioPathInvalid, nil)
	}

	currentRoot := filepath.Clean(w.Store.Root)
	if targetPath == currentRoot {
		return msg.Err(msg.ErrStorageSame, nil)
	}

	// 确保当前状态已完整落盘
	_ = w.Store.Update(func(_ *schema.State) {}, true)

	// 检查是否位于安装目录内部：更新程序会备份并替换安装目录，因此新数据目录绝不能位于安装目录内。
	if installDir := detectInstallDir(); installDir != "" {
		rel, err := filepath.Rel(installDir, targetPath)
		if err == nil && !strings.HasPrefix(rel, "..") && rel != "." {
			return msg.Err(msg.ErrStorageInsideApp, nil)
		}
		if filepath.Clean(installDir) == targetPath {
			return msg.Err(msg.ErrStorageInsideApp, nil)
		}
	}

	// 如果目标目录已存在，检查是否非空
	if entries, err := os.ReadDir(targetPath); err == nil {
		if len(entries) > 0 {
			return msg.Err(msg.ErrStorageTargetNotEmpty, nil)
		}
	} else if !os.IsNotExist(err) {
		return err
	}

	if err := os.MkdirAll(targetPath, 0700); err != nil {
		return err
	}

	cleanupTarget := func() {
		_ = os.RemoveAll(targetPath)
	}

	totalBytes := dirSize(currentRoot)
	_ = w.Store.Update(func(s *schema.State) {
		s.Activity = &schema.Activity{
			Kind:     "relocate",
			Code:     msg.ActivityRelocate,
			Status:   "running",
			Received: 0,
			Total:    totalBytes,
		}
	}, false)
	defer func() {
		_ = w.Store.Update(func(s *schema.State) {
			if s.Activity != nil && s.Activity.Kind == "relocate" {
				s.Activity = nil
			}
		}, false)
	}()

	// 优先尝试同盘快速移动（秒级完成），跨设备时回退到带进度复制
	sameVolume := filepath.VolumeName(currentRoot) == filepath.VolumeName(targetPath)
	movedQuickly := false
	if sameVolume {
		entries, err := os.ReadDir(currentRoot)
		if err == nil {
			allOk := true
			for _, entry := range entries {
				name := entry.Name()
				if name == "service.lock" || strings.HasSuffix(name, ".deleted") {
					continue
				}
				srcItem := filepath.Join(currentRoot, name)
				dstItem := filepath.Join(targetPath, name)
				if err := os.Rename(srcItem, dstItem); err != nil {
					allOk = false
					break
				}
			}
			if allOk {
				movedQuickly = true
			} else {
				// 若部分移动失败，先清理并走完整复制
				cleanupTarget()
				_ = os.MkdirAll(targetPath, 0700)
			}
		}
	}

	if !movedQuickly {
		lastReported := int64(0)
		lastReportTime := time.Now()
		onProgress := func(copied int64) {
			if copied-lastReported >= 5<<20 || time.Since(lastReportTime) > 200*time.Millisecond {
				lastReported = copied
				lastReportTime = time.Now()
				_ = w.Store.Update(func(s *schema.State) {
					if s.Activity != nil && s.Activity.Kind == "relocate" {
						s.Activity.Received = copied
					}
				}, false)
			}
		}
		if err := copyDirectoryContentsWithProgress(currentRoot, targetPath, onProgress); err != nil {
			cleanupTarget()
			return fmt.Errorf("复制数据失败: %w", err)
		}
	}

	// 重写目标目录下的 state.json 内部绝对路径
	targetStateFile := filepath.Join(targetPath, "state.json")
	if b, err := os.ReadFile(targetStateFile); err == nil {
		var s schema.State
		if err := json.Unmarshal(b, &s); err == nil {
			rebase := func(p *string) *string {
				if p == nil {
					return nil
				}
				rel, e := filepath.Rel(currentRoot, *p)
				if e == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel) {
					rebased := filepath.Join(targetPath, rel)
					return &rebased
				}
				return p
			}
			s.RuntimePath = rebase(s.RuntimePath)
			s.Preferences.ModelDirectory = rebase(s.Preferences.ModelDirectory)
			for i := range s.Models {
				s.Models[i].Path = *rebase(&s.Models[i].Path)
			}
			if newBytes, err := json.MarshalIndent(s, "", "  "); err == nil {
				_ = os.WriteFile(targetStateFile, newBytes, 0600)
			}
		}
	}

	// 写入全局存储重定向配置
	if err := store.WriteConfig(targetPath); err != nil {
		cleanupTarget()
		return fmt.Errorf("写入存储配置失败: %w", err)
	}

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

// copyDirectoryContentsWithProgress 递归复制目录内容，跳过锁文件，并实时汇报累计复制字节。
func copyDirectoryContentsWithProgress(src, dst string, onProgress func(copied int64)) error {
	var totalCopied int64
	return filepath.Walk(src, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		if rel == "." {
			return nil
		}
		if info.Name() == "service.lock" || strings.HasSuffix(info.Name(), ".deleted") {
			return nil
		}
		target := filepath.Join(dst, rel)
		if info.IsDir() {
			return os.MkdirAll(target, 0700)
		}
		copied, err := copyFileChunked(path, target)
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

func copyFileChunked(src, dst string) (int64, error) {
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
	defer out.Close()

	return io.Copy(out, in)
}
