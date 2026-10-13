// Package store 持久化应用状态、广播变更，并迁移旧版数据目录。
package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
	"yovoice/internal/diag"
	"yovoice/internal/msg"
	"yovoice/internal/platform"
	"yovoice/internal/schema"
)

// Store 在内存中保存当前状态供读取，持久化修改以事务写入 SQLite 状态库。
// 数据目录由 service.lock 独占，同一时间只有一个进程打开状态库。
type Store struct {
	Root  string
	mu    sync.Mutex
	state schema.State
	db    *sql.DB
	// saved 是数据库中已提交的内容，用于只写入变化的行。
	saved       snapshot
	backedUp    time.Time
	subscribers map[chan struct{}]bool
	// frozen 在数据目录迁移完成后置位：新目录已是重启后的数据源，旧目录不再接受持久化写入，避免重启前的修改静默丢失。
	frozen bool
}

// backupInterval 控制运行期间刷新 yovoice.backup.db 的最短间隔；每次打开时也会刷新一次。
const backupInterval = 30 * time.Minute

// hostPreferences 供原生宿主在服务启动前读取界面语言，内容由数据库派生，丢失后下次启动重建。
const hostPreferences = "host-preferences.json"

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
	s := &Store{Root: root, subscribers: map[chan struct{}]bool{}}
	if err = s.open(); err != nil {
		return nil, err
	}
	s.state.Activity = settleActivity(s.state.Activity)
	s.state.ModelActivity = settleActivity(s.state.ModelActivity)
	// AI 任务只属于本次会话。
	s.state.AITask = nil
	// 未保存的试听不跨会话保留，角色已保存的试听使用独立文件。
	s.state.Previews = []schema.CharacterPreview{}
	files, _ := filepath.Glob(filepath.Join(root, "outputs", "audition-*.wav"))
	for _, file := range files {
		_ = os.Remove(file)
	}
	if e := s.writeHostPreferences(); e != nil {
		diag.Log(root, "state.host_preferences_failed", "error", diag.Error(e))
	}
	// 每次成功打开后刷新备份，数据库损坏时可回到最近一次启动的状态。
	if e := backup(s.db, root); e != nil {
		diag.Log(root, "state.backup_failed", "error", diag.Error(e))
	} else {
		s.backedUp = time.Now()
	}
	return s, nil
}

// open 打开状态库；首次运行新版本时从旧版 state.json 导入，数据库损坏时从备份恢复。
func (s *Store) open() error {
	path := filepath.Join(s.Root, DatabaseFile)
	if _, e := os.Stat(path); os.IsNotExist(e) {
		state, found, e := readLegacy(s.Root)
		if e != nil {
			return e
		}
		if e = createDB(path, state); e != nil {
			return e
		}
		if found {
			diag.Log(s.Root, "state.imported", "source", legacyState)
		}
	} else if e != nil {
		return e
	}
	e := s.load(path)
	if corrupt(e) {
		if e = s.restore(path, e); e == nil {
			if e = s.load(path); corrupt(e) {
				// 备份同样不可用：不再尝试，交由用户处理。
				return msg.Err(msg.ErrStateCorrupt, nil)
			}
		}
	}
	if e != nil {
		return e
	}
	// 导入后中途退出时旧文件可能仍在，数据库已是数据源，旧文件只需移走。
	return retireLegacy(s.Root)
}

func (s *Store) load(path string) error {
	db, e := openDB(path)
	if e != nil {
		return e
	}
	if e = checkDB(db); e == nil {
		s.state, s.saved, e = load(db)
	}
	if e != nil {
		db.Close()
		return e
	}
	s.db = db
	return nil
}

// restore 保留损坏的数据库供排查，并用最近的备份替换；没有可用备份时报错且不改动原文件。
func (s *Store) restore(path string, cause error) error {
	source := filepath.Join(s.Root, backupFile)
	if _, e := os.Stat(source); e != nil {
		diag.Log(s.Root, "state.corrupt", "error", diag.Error(cause))
		return msg.Err(msg.ErrStateCorrupt, nil)
	}
	corruptPath := filepath.Join(s.Root, "yovoice.corrupt-"+time.Now().Format("20060102-150405.000000000")+".db")
	if e := os.Rename(path, corruptPath); e != nil {
		return e
	}
	// 回滚日志属于损坏的数据库，一并移走，避免被应用到备份上。
	if e := os.Rename(path+"-journal", corruptPath+"-journal"); e != nil && !os.IsNotExist(e) {
		return e
	}
	if e := copyFile(source, path); e != nil {
		return e
	}
	diag.Log(s.Root, "state.recovered", "source", backupFile, "error", diag.Error(cause))
	pruneCorrupt(s.Root, keepCorrupt)
	return nil
}

func copyFile(src, dst string) error {
	in, e := os.Open(src)
	if e != nil {
		return e
	}
	defer in.Close()
	out, e := os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if e != nil {
		return e
	}
	if _, e = io.Copy(out, in); e == nil {
		e = out.Sync()
	}
	if ce := out.Close(); e == nil {
		e = ce
	}
	if e != nil {
		_ = os.Remove(dst)
	}
	return e
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

// Update 在内存副本上应用修改；persist 为真时先把变化的记录在一个事务中写入数据库，提交成功后才替换内存状态。
func (s *Store) Update(change func(*schema.State), persist bool) (err error) {
	defer func() {
		if err != nil {
			diag.Log(s.Root, "state.write_failed", "stage", DatabaseFile, "error", diag.Error(err))
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
		if s.db == nil {
			return errors.New("状态库已关闭")
		}
		// 类 Unix 系统上已删除的文件仍可写入，必须先确认数据库仍在原位，否则修改会静默丢失。
		if _, e := os.Stat(filepath.Join(s.Root, DatabaseFile)); e != nil {
			return s.writeError(e)
		}
		snap, e := encode(&next)
		if e != nil {
			return e
		}
		changed, e := commit(s.db, s.saved, snap)
		if e != nil {
			return s.writeError(e)
		}
		s.saved = snap
		if changed {
			if next.Preferences.UiLocale != s.state.Preferences.UiLocale {
				s.state.Preferences.UiLocale = next.Preferences.UiLocale
				if e = s.writeHostPreferences(); e != nil {
					diag.Log(s.Root, "state.host_preferences_failed", "error", diag.Error(e))
				}
			}
			if time.Since(s.backedUp) >= backupInterval {
				if e = backup(s.db, s.Root); e != nil {
					diag.Log(s.Root, "state.backup_failed", "error", diag.Error(e))
				}
				s.backedUp = time.Now()
			}
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

// writeHostPreferences 写出原生宿主需要的界面语言，结构与旧版 state.json 的 preferences 保持一致。
func (s *Store) writeHostPreferences() error {
	b, e := json.Marshal(map[string]any{"preferences": map[string]any{"uiLocale": s.state.Preferences.UiLocale}})
	if e != nil {
		return e
	}
	return writeFileAtomic(filepath.Join(s.Root, hostPreferences), b)
}

// writeError 把“数据目录已不存在”翻译成可读的提示，而不是底层的文件系统错误；
// 运行中删除数据目录或拔出外置盘时，用户需要知道原因和处理方式。
// 这里不重新创建目录：外置盘未挂载时在原路径新建会把数据写到系统盘。
func (s *Store) writeError(e error) error {
	if _, err := os.Stat(s.Root); os.IsNotExist(err) {
		return msg.Err(msg.ErrDataRootMissing, msg.Params{"path": s.Root})
	}
	if diskFull(e) {
		return msg.Err(msg.ErrDiskFull, nil)
	}
	return e
}

// Freeze 拒绝之后的所有持久化写入；仅内存中的进度广播仍然可用。
func (s *Store) Freeze() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.frozen = true
}

// Close 关闭状态库；之后的持久化写入返回错误，内存读取仍可用。
func (s *Store) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.db == nil {
		return nil
	}
	e := s.db.Close()
	s.db = nil
	return e
}

// HasData 判断目录中是否已有状态数据（新版数据库或尚未导入的旧版 state.json）。
func HasData(root string) bool {
	for _, name := range []string{DatabaseFile, legacyState} {
		if _, e := os.Stat(filepath.Join(root, name)); e == nil {
			return true
		}
	}
	return false
}

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
	return writeFileAtomic(cfgPath, b)
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
	if !HasData(previous) {
		// 不是可识别的数据目录，不冒险删除。
		return "", forget()
	}
	lock, e := platform.Lock(filepath.Join(previous, "service.lock"))
	if e != nil {
		// 旧目录仍被其他进程使用，下次启动再试。
		return "", e
	}
	lock.Close()
	// 状态文件最后删除：中途退出时下次启动仍能识别这是旧数据目录并继续清理。
	entries, e := os.ReadDir(previous)
	if e != nil {
		return "", e
	}
	for _, entry := range entries {
		if name := entry.Name(); name == DatabaseFile || name == legacyState {
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
