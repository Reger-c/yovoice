package workbench

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"yovoice/internal/catalog"
	"yovoice/internal/download"
	"yovoice/internal/msg"
	"yovoice/internal/platform"
	"yovoice/internal/schema"
)

func (w *Workbench) register(id, path string, managed bool) error {
	path, e := filepath.Abs(path)
	if e != nil {
		return e
	}
	return w.Store.Update(func(s *schema.State) {
		s.Models = slices.DeleteFunc(s.Models, func(m schema.InstalledModel) bool { return m.ID == id })
		s.Models = append(s.Models, schema.InstalledModel{ID: id, Path: path, Managed: managed})
	}, true)
}
func (w *Workbench) DownloadModel(id string) error {
	m, e := catalog.Lookup(id)
	if e != nil {
		return e
	}
	s := w.Store.Read()
	files := m.PackageFiles()
	urls := make([]string, len(files))
	for i, f := range files {
		if urls[i], e = m.FileURL(s.Preferences.DownloadSource, f.Path); e != nil {
			return e
		}
	}
	return w.begin("download", msg.ActivityDownload, msg.Params{"name": m.Name}, ptr(id), func(ctx context.Context) error {
		dir := value(s.Preferences.ModelDirectory)
		if dir == "" {
			dir = filepath.Join(w.Store.Root, "models")
		}
		// 单文件模型直接放在模型目录；多文件模型放进自己的子目录并保留相对路径。
		root, dest := dir, filepath.Join(dir, filepath.Base(m.RemotePath))
		if len(m.Files) > 0 {
			root = filepath.Join(dir, m.Directory)
			dest = root
		}
		if e := os.MkdirAll(root, 0700); e != nil {
			return e
		}
		target := func(f catalog.ModelFile) string {
			if len(m.Files) > 0 {
				return filepath.Join(root, filepath.FromSlash(f.Path))
			}
			return dest
		}
		available, e := platform.FreeSpace(dir)
		if e != nil {
			return e
		}
		need := int64(100 << 20)
		for _, f := range files {
			need += max(int64(0), f.Size-download.FileSize(target(f)+".part")-download.FileSize(target(f)))
		}
		if available < uint64(need) {
			return msg.Err(msg.ErrModelDirSpace, nil)
		}
		// 进度按整个模型包累计，多个文件依次下载。
		var done int64
		for i, f := range files {
			if e = download.File(ctx, w.client, urls[i], target(f), f.SHA256, f.Size, func(r, _ int64) {
				code, params := msg.ActivityDownloading, msg.Params{"name": m.Name}
				if done+r == m.Size {
					code, params = msg.ActivityVerifying, nil
				}
				w.progress(code, params, done+r, m.Size)
			}); e != nil {
				return e
			}
			done += f.Size
		}
		return w.register(id, dest, true)
	})
}
func (w *Workbench) ImportModel(path string) error {
	return w.begin("import", msg.ActivityImport, nil, nil, func(ctx context.Context) error {
		paths := []string{path}
		info, e := os.Stat(path)
		if e != nil {
			return e
		}
		if info.IsDir() {
			paths, e = filepath.Glob(filepath.Join(path, "*.gguf"))
			if e != nil {
				return e
			}
		}
		count := 0
		for _, p := range paths {
			if e = ctx.Err(); e != nil {
				return e
			}
			size := download.FileSize(p)
			if !slices.ContainsFunc(catalog.Models, func(m catalog.ModelPackage) bool {
				return slices.ContainsFunc(m.PackageFiles(), func(f catalog.ModelFile) bool { return f.SHA256 == m.SHA256 && f.Size == size })
			}) {
				continue
			}
			hash, e := download.Hash(ctx, p)
			if e != nil {
				return e
			}
			for _, m := range catalog.Models {
				if m.SHA256 == hash {
					path := p
					if len(m.Files) > 0 {
						// 多文件模型只认完整的模型目录：主模型旁需有其余文件。
						if path = packageRoot(m, p); path == "" {
							continue
						}
					}
					if e = w.register(m.ID, path, false); e != nil {
						return e
					}
					count++
				}
			}
		}
		if count == 0 {
			return msg.Err(msg.ErrModelImportNone, nil)
		}
		return nil
	})
}

// ForgetModel 移除模型登记，不删除用户导入的文件。下载其他模型不占用推理引擎，可同时移除。
func (w *Workbench) ForgetModel(id string) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	activity := w.Store.Read().Activity
	if w.cancel != nil && (activity == nil || activity.Kind != "download" || activity.ModelID == nil || *activity.ModelID == id) {
		return msg.Err(msg.ErrModelForgetBlocked, nil)
	}
	w.engine.Stop()
	return w.Store.Update(func(s *schema.State) {
		s.Models = slices.DeleteFunc(s.Models, func(m schema.InstalledModel) bool { return m.ID == id })
	}, true)
}

// packageRoot 根据主模型文件位置推出多文件模型包的目录，文件不全时返回空串。
func packageRoot(m catalog.ModelPackage, main string) string {
	root := filepath.Dir(main)
	for i := 0; i < strings.Count(m.RemotePath, "/"); i++ {
		root = filepath.Dir(root)
	}
	for _, f := range m.Files {
		if download.FileSize(filepath.Join(root, filepath.FromSlash(f.Path))) != f.Size {
			return ""
		}
	}
	return root
}
