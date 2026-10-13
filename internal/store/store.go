// Package store 持久化应用状态、广播变更，并迁移旧版数据目录。
package store

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"time"
	"yovoice/internal/diag"
	"yovoice/internal/msg"
	"yovoice/internal/platform"
	"yovoice/internal/schema"
)

type Store struct {
	Root        string
	mu          sync.Mutex
	state       schema.State
	subscribers map[chan struct{}]bool
	// frozen 在数据目录迁移完成后置位：新目录已是重启后的数据源，旧目录不再接受持久化写入，避免重启前的修改静默丢失。
	frozen bool
}

func New(root string) (store *Store, err error) {
	defer func() { diag.Log(root, "state.open", "platform", runtime.GOOS, "error", diag.Error(err)) }()
	for _, d := range []string{"", "voices", "outputs", "downloads", "runtime", "models", "logs"} {
		if e := os.MkdirAll(filepath.Join(root, d), 0700); e != nil {
			return nil, e
		}
	}
	for _, d := range []string{"voices", "outputs"} {
		files, _ := filepath.Glob(filepath.Join(root, d, "*.deleted"))
		for _, file := range files {
			_ = os.Remove(file)
		}
	}
	s := &Store{Root: root, state: schema.DefaultState(), subscribers: map[chan struct{}]bool{}}
	b, e := os.ReadFile(filepath.Join(root, "state.json"))
	fromFile := false
	if e == nil {
		fromFile = true
		if string(b) == "null" || json.Unmarshal(b, &s.state) != nil {
			backup, backupErr := os.ReadFile(filepath.Join(root, "state.backup.json"))
			recovered := schema.DefaultState()
			if backupErr != nil || string(backup) == "null" || json.Unmarshal(backup, &recovered) != nil {
				return nil, msg.Err(msg.ErrStateCorrupt, nil)
			}
			// 保留损坏文件供恢复排查，绝不以空工程覆盖用户数据。
			if e = os.Rename(filepath.Join(root, "state.json"), filepath.Join(root, "state.corrupt-"+time.Now().Format("20060102-150405.000000000")+".json")); e != nil {
				return nil, e
			}
			diag.Log(root, "state.recovered", "source", "state.backup.json")
			pruneCorrupt(root, keepCorrupt)
			s.state = recovered
			if e = writeState(filepath.Join(root, "state.json"), recovered); e != nil {
				return nil, e
			}
		}
	} else if !os.IsNotExist(e) {
		return nil, e
	} else {
		backup, backupErr := os.ReadFile(filepath.Join(root, "state.backup.json"))
		if backupErr == nil {
			if string(backup) == "null" || json.Unmarshal(backup, &s.state) != nil {
				return nil, msg.Err(msg.ErrStateCorrupt, nil)
			}
			fromFile = true
			diag.Log(root, "state.recovered", "source", "state.backup.json")
			if e = writeState(filepath.Join(root, "state.json"), s.state); e != nil {
				return nil, e
			}
		} else if !os.IsNotExist(backupErr) {
			return nil, backupErr
		}
	}

	s.state.Activity = settleActivity(s.state.Activity)
	s.state.ModelActivity = settleActivity(s.state.ModelActivity)
	// Legacy state.json without uiLocale defaults to zh-CN. Brand-new installs stay empty so the web can persist navigator.language.
	if s.state.Preferences.UiLocale == "" && fromFile {
		s.state.Preferences.UiLocale = schema.UiLocaleZhCN
	}
	// AI 任务只属于本次会话。
	s.state.AITask = nil
	// 未保存的试听不跨会话保留，角色已保存的试听使用独立文件。
	s.state.Previews = []schema.CharacterPreview{}
	files, _ := filepath.Glob(filepath.Join(root, "outputs", "audition-*.wav"))
	for _, file := range files {
		_ = os.Remove(file)
	}
	return s, nil
}

// settleActivity 整理上次会话遗留的操作：运行中的标记为中断，失败提示属于上次会话，重启后不再冒充本次操作的错误。
func settleActivity(a *schema.Activity) *schema.Activity {
	if a == nil {
		return nil
	}
	if a.Status == "running" {
		a.Status = "interrupted"
		a.Code = msg.ActivityInterrupted
		a.Params = nil
		a.ErrorCode = nil
		a.ErrorParams = nil
		return a
	}
	if a.Code == "" || a.Status == "failed" {
		return nil
	}
	return a
}
func clone(s schema.State) schema.State {
	b, _ := json.Marshal(s)
	var r schema.State
	_ = json.Unmarshal(b, &r)
	return r
}
func (s *Store) Read() schema.State { s.mu.Lock(); defer s.mu.Unlock(); return clone(s.state) }
func writeState(path string, state schema.State) error {
	b, e := json.MarshalIndent(state, "", "  ")
	if e != nil {
		return e
	}
	f, e := os.CreateTemp(filepath.Dir(path), ".state-*")
	if e != nil {
		return e
	}
	defer os.Remove(f.Name())
	if _, e = f.Write(b); e == nil {
		e = f.Sync()
	}
	ce := f.Close()
	if e != nil {
		return e
	}
	if ce != nil {
		return ce
	}
	return os.Rename(f.Name(), path)
}
func (s *Store) Update(change func(*schema.State), persist bool) (err error) {
	stage := "memory"
	defer func() {
		if err != nil {
			diag.Log(s.Root, "state.write_failed", "stage", stage, "error", diag.Error(err))
		}
	}()
	s.mu.Lock()
	defer s.mu.Unlock()
	if persist && s.frozen {
		return msg.Err(msg.ErrStorageRestart, nil)
	}
	next := clone(s.state)
	change(&next)
	if persist {
		stage = "state.backup.json"
		if e := writeState(filepath.Join(s.Root, "state.backup.json"), s.state); e != nil {
			return s.writeError(e)
		}
		stage = "state.json"
		if e := writeState(filepath.Join(s.Root, "state.json"), next); e != nil {
			return s.writeError(e)
		}
	}
	s.state = next
	for ch := range s.subscribers {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
	return nil
}

// writeError 把“数据目录已不存在”翻译成可读的提示，而不是底层的文件系统错误；
// 运行中删除数据目录或拔出外置盘时，用户需要知道原因和处理方式。
// 这里不重新创建目录：外置盘未挂载时在原路径新建会把数据写到系统盘。
func (s *Store) writeError(e error) error {
	if _, err := os.Stat(s.Root); os.IsNotExist(err) {
		return msg.Err(msg.ErrDataRootMissing, msg.Params{"path": s.Root})
	}
	return e
}

// Freeze 拒绝之后的所有持久化写入；仅内存中的进度广播仍然可用。
func (s *Store) Freeze() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.frozen = true
}

// WriteState 以原子替换方式写入状态文件，供数据目录迁移生成新目录的 state.json。
func WriteState(path string, state schema.State) error { return writeState(path, state) }

func (s *Store) Subscribe() (chan struct{}, func()) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ch := make(chan struct{}, 1)
	s.subscribers[ch] = true
	ch <- struct{}{}
	return ch, func() { s.mu.Lock(); delete(s.subscribers, ch); s.mu.Unlock() }
}
func (s *Store) MediaPath(kind, name string) (string, error) {
	if (kind != "voices" && kind != "outputs") || name == "" || name == "." || name == ".." || strings.ContainsAny(name, "/\\:\x00") {
		return "", msg.Err(msg.ErrAudioPathInvalid, nil)
	}
	path := filepath.Join(s.Root, kind, name)
	if info, e := os.Lstat(path); e == nil && info.Mode()&os.ModeSymlink != 0 {
		return "", msg.Err(msg.ErrAudioPathSymlink, nil)
	}
	return path, nil
}
func DefaultDirectory() (string, error) {
	home, e := os.UserHomeDir()
	return filepath.Join(home, ".yovoice"), e
}
func PrepareDefault() error {
	target, e := DefaultDirectory()
	if e != nil {
		return e
	}
	home, e := os.UserHomeDir()
	if e != nil {
		return e
	}
	legacy := filepath.Join(home, "Library", "Application Support", "VoiceWorkbench")
	if runtime.GOOS == "windows" {
		legacy = filepath.Join(os.Getenv("LOCALAPPDATA"), "VoiceWorkbench")
	}
	return Migrate(legacy, target)
}
func Migrate(legacy, target string) error {
	if _, e := os.Stat(target); e == nil {
		return nil
	} else if !os.IsNotExist(e) {
		return e
	}
	if _, e := os.Stat(legacy); os.IsNotExist(e) {
		return nil
	} else if e != nil {
		return e
	}
	lock, e := platform.Lock(filepath.Join(legacy, "service.lock"))
	if e != nil {
		return e
	}
	defer lock.Close()
	var state schema.State
	b, e := os.ReadFile(filepath.Join(legacy, "state.json"))
	hasState := e == nil
	if e != nil && !os.IsNotExist(e) {
		return e
	}
	if hasState {
		if string(b) == "null" {
			return msg.Err(msg.ErrLegacyRestore, nil)
		}
		if e = json.Unmarshal(b, &state); e != nil {
			return e
		}
		rebase := func(p *string) *string {
			if p == nil {
				return nil
			}
			rel, e := filepath.Rel(legacy, *p)
			if e == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel) {
				rebased := filepath.Join(target, rel)
				return &rebased
			}
			return p
		}
		state.RuntimePath = rebase(state.RuntimePath)
		state.Preferences.ModelDirectory = rebase(state.Preferences.ModelDirectory)
		for i := range state.Models {
			state.Models[i].Path = *rebase(&state.Models[i].Path)
		}
	}
	// Windows 文件锁不允许移动父目录；迁移只在启动新服务前执行。
	if runtime.GOOS == "windows" {
		lock.Close()
	}
	if e = os.Rename(legacy, target); e != nil {
		return e
	}
	if hasState {
		if e = writeState(filepath.Join(target, "state.json"), state); e != nil {
			if rollback := os.Rename(target, legacy); rollback != nil {
				return msg.Err(msg.ErrUnknown, msg.Params{"detail": fmt.Sprintf("%v; rollback failed: %v", e, rollback)})
			}
			return e
		}
	}
	return nil
}

// StorageConfig 存储全局重定向配置。
// PreviousPath 记录迁移前的旧目录：新目录成功启动后由 CleanupPrevious 删除，释放原磁盘空间。
type StorageConfig struct {
	DataPath     string `json:"dataPath"`
	PreviousPath string `json:"previousPath,omitempty"`
}

// ConfigFile 返回平台全局存储配置文件的路径，需与 Windows / macOS 宿主读取的位置保持一致。
func ConfigFile() (string, error) {
	var base string
	if runtime.GOOS == "windows" {
		base = os.Getenv("APPDATA")
		if base == "" {
			home, err := os.UserHomeDir()
			if err != nil {
				return "", err
			}
			base = filepath.Join(home, "AppData", "Roaming")
		}
	} else if runtime.GOOS == "darwin" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		base = filepath.Join(home, "Library", "Application Support")
	} else {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		base = filepath.Join(home, ".config")
	}
	return filepath.Join(base, "yovoice", "storage.json"), nil
}

// ReadConfig 读取已保存的数据目录重定向配置。
func ReadConfig() (StorageConfig, error) {
	var cfg StorageConfig
	cfgPath, err := ConfigFile()
	if err != nil {
		return cfg, err
	}
	b, err := os.ReadFile(cfgPath)
	if err != nil {
		return cfg, err
	}
	err = json.Unmarshal(b, &cfg)
	return cfg, err
}

// WriteConfig 原子保存数据目录重定向配置，避免写到一半时宿主读到损坏的配置。
func WriteConfig(cfg StorageConfig) error {
	cfgPath, err := ConfigFile()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(cfgPath), 0700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(cfgPath), ".storage-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(b); err == nil {
		err = f.Sync()
	}
	if ce := f.Close(); err == nil {
		err = ce
	}
	if err != nil {
		return err
	}
	return os.Rename(f.Name(), cfgPath)
}

// SamePath 判断两个路径是否指向同一位置；Windows 与 macOS 默认文件系统不区分大小写。
func SamePath(a, b string) bool {
	a, b = filepath.Clean(a), filepath.Clean(b)
	if runtime.GOOS == "windows" || runtime.GOOS == "darwin" {
		return strings.EqualFold(a, b)
	}
	return a == b
}

// Within 判断 child 是否位于 parent 内部（含相同路径）。
func Within(parent, child string) bool {
	parent, child = filepath.Clean(parent), filepath.Clean(child)
	if SamePath(parent, child) {
		return true
	}
	if runtime.GOOS == "windows" || runtime.GOOS == "darwin" {
		parent, child = strings.ToLower(parent), strings.ToLower(child)
	}
	rel, err := filepath.Rel(parent, child)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

// CleanupPrevious 在新数据目录成功启动后删除迁移前的旧目录。
// 只有配置确认当前目录就是迁移目标、旧目录确实是数据目录且没有其他进程占用时才删除；
// 宿主未切换到新目录（例如旧版宿主）时保持旧目录不动，绝不删除正在使用的数据。
func CleanupPrevious(root string) (removed string, err error) {
	cfg, err := ReadConfig()
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", err
	}
	previous := cfg.PreviousPath
	if previous == "" || cfg.DataPath == "" || !SamePath(cfg.DataPath, root) {
		return "", nil
	}
	forget := func() error {
		cfg.PreviousPath = ""
		return WriteConfig(cfg)
	}
	if Within(previous, root) || Within(root, previous) {
		return "", forget()
	}
	if _, e := os.Stat(previous); os.IsNotExist(e) {
		return "", forget()
	}
	if _, e := os.Stat(filepath.Join(previous, "state.json")); e != nil {
		// 不是可识别的数据目录，不冒险删除。
		return "", forget()
	}
	lock, e := platform.Lock(filepath.Join(previous, "service.lock"))
	if e != nil {
		// 旧目录仍被其他进程使用，下次启动再试。
		return "", e
	}
	lock.Close()
	// state.json 最后删除：中途退出时下次启动仍能识别这是旧数据目录并继续清理。
	entries, e := os.ReadDir(previous)
	if e != nil {
		return "", e
	}
	for _, entry := range entries {
		if entry.Name() == "state.json" {
			continue
		}
		if e = os.RemoveAll(filepath.Join(previous, entry.Name())); e != nil {
			return "", e
		}
	}
	if e = os.RemoveAll(previous); e != nil {
		return "", e
	}
	return previous, forget()
}

// keepCorrupt 限制损坏状态快照数量：保留最近几份用于排查，避免反复损坏时无限占用空间。
const keepCorrupt = 3

func pruneCorrupt(root string, keep int) {
	files, _ := filepath.Glob(filepath.Join(root, "state.corrupt-*.json"))
	// 文件名带纳秒时间戳，字典序即时间序。
	slices.Sort(files)
	for len(files) > keep {
		_ = os.Remove(files[0])
		files = files[1:]
	}
}
