package workbench

import (
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"
	"yovoice/internal/schema"
)

// 运行时安装目录由 os.MkdirTemp 以“版本-后端-随机数”命名。
var runtimeDir = regexp.MustCompile(`^v\d+\.\d+\.\d+-[a-z0-9]+-\d+$`)

// 生成后转码与旧版录音导入使用 32 位十六进制 ID 命名的临时 WAV。
var temporaryWav = regexp.MustCompile(`^[0-9a-f]{32}\.wav$`)

// removeStale 回收进程中途退出时遗留的临时文件；只匹配本程序创建的命名，
// 不触碰下载缓存的运行时压缩包与正在使用的运行时。数据目录已由调用方加锁独占。
func (w *Workbench) removeStale() {
	root := w.Store.Root
	remove := func(dir string, match func(os.DirEntry) bool) {
		entries, err := os.ReadDir(dir)
		if err != nil {
			return
		}
		for _, entry := range entries {
			if match(entry) {
				_ = os.RemoveAll(filepath.Join(dir, entry.Name()))
			}
		}
	}
	remove(root, func(e os.DirEntry) bool {
		return (e.IsDir() && strings.HasPrefix(e.Name(), ".project-")) || (!e.IsDir() && strings.HasPrefix(e.Name(), ".state-"))
	})
	remove(filepath.Join(root, "downloads"), func(e os.DirEntry) bool {
		name := e.Name()
		return (e.IsDir() && strings.HasPrefix(name, "audio-")) ||
			(!e.IsDir() && (strings.HasPrefix(name, "upload-") || strings.HasPrefix(name, "api-upload-") || temporaryWav.MatchString(name)))
	})
	w.removeStaleRuntimes()
}

// removeStaleRuntimes 删除当前运行时与各后端已登记内核以外的安装目录。
func (w *Workbench) removeStaleRuntimes() {
	s := w.Store.Read()
	used := []string{}
	if s.RuntimePath != nil {
		used = append(used, filepath.Clean(*s.RuntimePath))
	}
	for _, r := range s.Runtimes {
		used = append(used, filepath.Clean(r.Path))
	}
	dir := filepath.Join(w.Store.Root, "runtime")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		path := filepath.Join(dir, entry.Name())
		if !entry.IsDir() || !runtimeDir.MatchString(entry.Name()) || slices.ContainsFunc(used, func(p string) bool { return p == path || strings.HasPrefix(p, path+string(filepath.Separator)) }) {
			continue
		}
		_ = os.RemoveAll(path)
	}
}

// CleanupReport 记录清理残留的结果统计。
type CleanupReport struct {
	CleanedCount int   `json:"cleanedCount"`
	FreedBytes   int64 `json:"freedBytes"`
}

// CleanupResiduals 回收超过 24 小时的孤儿历史版本与孤儿磁盘文件。
func (w *Workbench) CleanupResiduals() (CleanupReport, error) {
	w.edit.Lock()
	defer w.edit.Unlock()

	s := w.Store.Read()
	cutoff := time.Now().Add(-24 * time.Hour)

	var report CleanupReport

	// 1. 收集存活草稿 ID 与所有被时间线引用的 Generation ID
	aliveDraftIDs := map[string]bool{}
	timelineReferencedGenIDs := map[string]bool{}
	for _, d := range s.Drafts {
		aliveDraftIDs[d.ID] = true
		if d.Timeline != nil {
			for _, track := range d.Timeline.Tracks {
				for _, clip := range track.Clips {
					if clip.GenerationID != "" {
						timelineReferencedGenIDs[clip.GenerationID] = true
					}
				}
			}
		}
	}

	// 2. 识别遗留的孤儿历史记录（草稿已删除且未被任何时间线引用）
	deleteGenIDs := map[string]bool{}
	orphanGenFiles := map[string]bool{}
	for _, g := range s.History {
		if !aliveDraftIDs[g.Settings.ID] && !timelineReferencedGenIDs[g.ID] {
			deleteGenIDs[g.ID] = true
			if g.FileName != "" {
				orphanGenFiles[g.FileName] = true
			}
		}
	}

	if len(deleteGenIDs) > 0 {
		_ = w.Store.Update(func(state *schema.State) {
			state.History = slices.DeleteFunc(state.History, func(g schema.Generation) bool {
				return deleteGenIDs[g.ID]
			})
		}, true)
		s = w.Store.Read()
	}

	// 3. 收集所有活跃被引用的文件名集合
	activeVoiceFiles := map[string]bool{}
	for _, v := range s.Voices {
		if v.FileName != "" {
			activeVoiceFiles[v.FileName] = true
		}
	}

	activeOutputFiles := map[string]bool{}
	for _, g := range s.History {
		if g.FileName != "" {
			activeOutputFiles[g.FileName] = true
		}
	}
	for _, c := range s.Characters {
		if c.Preview != nil && c.Preview.FileName != "" {
			activeOutputFiles[c.Preview.FileName] = true
		}
	}
	for _, p := range s.Previews {
		if p.FileName != "" {
			activeOutputFiles[p.FileName] = true
		}
	}
	for _, d := range s.Drafts {
		if d.Timeline != nil {
			for _, asset := range d.Timeline.Assets {
				if asset.FileName != "" {
					activeOutputFiles[asset.FileName] = true
				}
			}
		}
	}

	// 孤儿历史的物理文件若已无其他引用，立即物理删除（无需再等待 24 小时）
	for fileName := range orphanGenFiles {
		if !activeOutputFiles[fileName] && !activeVoiceFiles[fileName] {
			if path, err := w.Store.MediaPath("outputs", fileName); err == nil {
				if info, err := os.Stat(path); err == nil {
					if os.Remove(path) == nil {
						report.CleanedCount++
						report.FreedBytes += info.Size()
					}
				}
			}
		}
	}

	// 4. 清理 outputs/ 下未引用的孤儿文件（只清理超过 24 小时的）
	outputsDir := filepath.Join(w.Store.Root, "outputs")
	if entries, err := os.ReadDir(outputsDir); err == nil {
		for _, entry := range entries {
			name := entry.Name()
			if entry.IsDir() || strings.HasPrefix(name, ".") {
				continue
			}
			if !activeOutputFiles[name] {
				path := filepath.Join(outputsDir, name)
				if info, err := entry.Info(); err == nil && info.ModTime().Before(cutoff) {
					if os.Remove(path) == nil {
						report.CleanedCount++
						report.FreedBytes += info.Size()
					}
				}
			}
		}
	}

	// 5. 清理 voices/ 下未引用的孤儿文件（只清理超过 24 小时的）
	voicesDir := filepath.Join(w.Store.Root, "voices")
	if entries, err := os.ReadDir(voicesDir); err == nil {
		for _, entry := range entries {
			name := entry.Name()
			if entry.IsDir() || strings.HasPrefix(name, ".") {
				continue
			}
			if !activeVoiceFiles[name] {
				path := filepath.Join(voicesDir, name)
				if info, err := entry.Info(); err == nil && info.ModTime().Before(cutoff) {
					if os.Remove(path) == nil {
						report.CleanedCount++
						report.FreedBytes += info.Size()
					}
				}
			}
		}
	}

	// 6. 清理 downloads/ 下超过 24 小时的临时或残留分片
	downloadsDir := filepath.Join(w.Store.Root, "downloads")
	if entries, err := os.ReadDir(downloadsDir); err == nil {
		for _, entry := range entries {
			name := entry.Name()
			if entry.IsDir() || strings.HasPrefix(name, ".") {
				continue
			}
			if strings.HasSuffix(name, ".part") || strings.HasPrefix(name, "upload-") || strings.HasPrefix(name, "audio-") {
				path := filepath.Join(downloadsDir, name)
				if info, err := entry.Info(); err == nil && info.ModTime().Before(cutoff) {
					if os.Remove(path) == nil {
						report.CleanedCount++
						report.FreedBytes += info.Size()
					}
				}
			}
		}
	}

	return report, nil
}

