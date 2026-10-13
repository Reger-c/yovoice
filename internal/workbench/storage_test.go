package workbench

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
	"yovoice/internal/msg"
	"yovoice/internal/schema"
	"yovoice/internal/store"
	"yovoice/internal/testkit"
)

func TestDeleteDraftCascadesHistoryAndFiles(t *testing.T) {
	root := t.TempDir()
	w, err := New(root)
	must(t, err)
	defer w.Close()

	d1 := schema.DefaultDraft()
	d1.ID = schema.NewID()
	d1.Title = "作品一"
	must(t, w.SaveDraft(d1))

	d2 := schema.DefaultDraft()
	d2.ID = schema.NewID()
	d2.Title = "作品二"

	// 为作品一生成历史版本 g1（私有）和 g2（被作品二时间线引用）
	g1 := schema.Generation{ID: schema.NewID(), Title: "版本一", FileName: "gen1.wav", Duration: 2, Settings: d1}
	g2 := schema.Generation{ID: schema.NewID(), Title: "版本二", FileName: "gen2.wav", Duration: 2, Settings: d1}

	// 在磁盘上创建对应的 outputs wav 文件
	path1 := filepath.Join(root, "outputs", g1.FileName)
	path2 := filepath.Join(root, "outputs", g2.FileName)
	must(t, os.WriteFile(path1, []byte("wav-1"), 0600))
	must(t, os.WriteFile(path2, []byte("wav-2"), 0600))

	must(t, w.Store.Update(func(s *schema.State) {
		s.History = append(s.History, g1, g2)
	}, true))

	// 作品二的时间线引用 g2
	d2.Timeline = &schema.AudioTimeline{
		Tracks: []schema.AudioLane{
			{ID: "track-1", Name: "人声", Clips: []schema.AudioClip{{ID: "clip-1", GenerationID: g2.ID, Start: 0, Offset: 0, Duration: 1}}},
		},
	}
	must(t, w.SaveDraft(d2))

	// 正在生成作品一时拒绝删除
	must(t, w.begin("generate", msg.ActivityGenerate, nil, nil, func(ctx context.Context) error {
		<-ctx.Done()
		return ctx.Err()
	}, "", d1.ID))

	if err := w.DeleteDraft(d1.ID); err == nil {
		t.Fatal("正在生成时应拒绝删除作品")
	}

	w.Cancel()
	<-w.Done()

	// 成功删除作品一
	must(t, w.DeleteDraft(d1.ID))

	s := w.Store.Read()
	for _, d := range s.Drafts {
		if d.ID == d1.ID {
			t.Fatal("作品一未从草稿列表删除")
		}
	}

	// g1 应被删除，文件被物理删除
	for _, g := range s.History {
		if g.ID == g1.ID {
			t.Fatal("未引用的历史版本未被级联删除")
		}
	}
	if _, err := os.Stat(path1); !os.IsNotExist(err) {
		t.Fatal("未引用的历史音频文件未从磁盘删除")
	}

	// g2 被作品二时间线引用，应保留，文件也应保留
	foundG2 := false
	for _, g := range s.History {
		if g.ID == g2.ID {
			foundG2 = true
		}
	}
	if !foundG2 {
		t.Fatal("被其他作品引用的历史版本被误删")
	}
	if _, err := os.Stat(path2); err != nil {
		t.Fatal("被其他作品引用的历史音频文件应保留", err)
	}
}

func TestCleanupResiduals(t *testing.T) {
	root := t.TempDir()
	w, err := New(root)
	must(t, err)
	defer w.Close()

	// 1. 创建一个 48 小时前的孤儿 output 文件
	oldOrphanPath := filepath.Join(root, "outputs", "old-orphan.wav")
	must(t, os.WriteFile(oldOrphanPath, []byte("old-orphan-data"), 0600))
	oldTime := time.Now().Add(-48 * time.Hour)
	must(t, os.Chtimes(oldOrphanPath, oldTime, oldTime))

	// 2. 创建一个刚刚生成的临时文件（不应被清理）
	freshPath := filepath.Join(root, "outputs", "fresh.wav")
	must(t, os.WriteFile(freshPath, []byte("fresh-data"), 0600))

	// 3. 执行清理
	report, err := w.CleanupResiduals()
	must(t, err)

	if report.CleanedCount < 1 {
		t.Fatalf("应至少清理 1 个旧文件，实际清理了 %d", report.CleanedCount)
	}

	if _, err := os.Stat(oldOrphanPath); !os.IsNotExist(err) {
		t.Fatal("超过 24 小时的孤儿文件未被清理")
	}

	if _, err := os.Stat(freshPath); err != nil {
		t.Fatal("24 小时内的新文件不应被误删", err)
	}
}

// isolateConfig 让存储重定向配置写入临时目录，避免测试改动开发者本机的配置。
func isolateConfig(t *testing.T) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("APPDATA", filepath.Join(home, "AppData", "Roaming"))
}

func TestStorageInfoAndRelocate(t *testing.T) {
	isolateConfig(t)
	root := t.TempDir()
	w, err := New(root)
	must(t, err)
	defer w.Close()

	info, err := w.StorageInfo()
	must(t, err)
	if info.Root != root {
		t.Fatalf("StorageInfo Root 不匹配: %s != %s", info.Root, root)
	}

	// 不能迁移到相同目录
	if err := w.RelocateStorage(root); err == nil {
		t.Fatal("应拒绝迁移到相同目录")
	}

	// 正常迁移到新目录
	target := filepath.Join(t.TempDir(), "new-data")
	must(t, w.RelocateStorage(target))

	infoAfter, err := w.StorageInfo()
	must(t, err)
	if infoAfter.PendingPath != target {
		t.Fatalf("PendingPath 应更新为 %s，实际为 %s", target, infoAfter.PendingPath)
	}

	if _, err := os.Stat(filepath.Join(target, "state.json")); err != nil {
		t.Fatal("新目录缺少 state.json", err)
	}
}

func TestRelocateCopiesWithoutTouchingSourceAndFreezes(t *testing.T) {
	isolateConfig(t)
	root := t.TempDir()
	w, err := New(root)
	must(t, err)
	defer w.Close()

	voice := filepath.Join(root, "voices", "keep.wav")
	must(t, os.WriteFile(voice, []byte("voice"), 0600))
	model := filepath.Join(root, "models", "m", "weights.gguf")
	must(t, os.MkdirAll(filepath.Dir(model), 0700))
	must(t, os.WriteFile(model, []byte("weights"), 0600))
	runtimePath := filepath.Join(root, "runtime", "cpu", "engine")
	must(t, w.Store.Update(func(s *schema.State) {
		s.Models = append(s.Models, schema.InstalledModel{ID: "m", Path: model, Managed: true})
		s.RuntimePath = &runtimePath
		s.Runtimes = map[string]schema.InstalledRuntime{"cpu": {Path: runtimePath, Version: "1"}}
	}, true))

	if err, ok := w.RelocateStorage(filepath.Join(root, "inside")).(*msg.CallError); !ok || err.Code != msg.ErrStorageInsideData {
		t.Fatalf("应拒绝迁移到当前数据目录内部，实际: %v", err)
	}

	target := filepath.Join(t.TempDir(), "moved")
	must(t, w.RelocateStorage(target))

	// 旧目录保持完整，重启前仍可回退使用。
	for _, p := range []string{voice, model, filepath.Join(root, "state.json")} {
		if _, err := os.Stat(p); err != nil {
			t.Fatalf("迁移后旧目录文件被改动: %s %v", p, err)
		}
	}
	for _, rel := range []string{"voices/keep.wav", "models/m/weights.gguf", "state.json"} {
		if _, err := os.Stat(filepath.Join(target, filepath.FromSlash(rel))); err != nil {
			t.Fatalf("新目录缺少 %s: %v", rel, err)
		}
	}
	if _, err := os.Stat(filepath.Join(target, "service.lock")); !os.IsNotExist(err) {
		t.Fatal("不应复制服务锁文件")
	}

	moved, err := store.New(target)
	must(t, err)
	s := moved.Read()
	if s.Models[0].Path != filepath.Join(target, "models", "m", "weights.gguf") {
		t.Fatalf("模型路径未改写: %s", s.Models[0].Path)
	}
	if *s.RuntimePath != filepath.Join(target, "runtime", "cpu", "engine") || s.Runtimes["cpu"].Path != *s.RuntimePath {
		t.Fatalf("内核路径未改写: %v %v", *s.RuntimePath, s.Runtimes)
	}

	cfg, err := store.ReadConfig()
	must(t, err)
	if cfg.DataPath != target || cfg.PreviousPath != root {
		t.Fatalf("存储配置不正确: %+v", cfg)
	}

	// 重启前拒绝持久化写入与再次迁移，避免修改写进旧目录后丢失。
	if err := w.Store.Update(func(*schema.State) {}, true); err == nil {
		t.Fatal("迁移后应拒绝持久化写入")
	}
	if err := w.RelocateStorage(filepath.Join(t.TempDir(), "again")); err == nil {
		t.Fatal("重启前应拒绝再次迁移")
	}
}

func TestRelocateRejectsWhileBusy(t *testing.T) {
	isolateConfig(t)
	root := t.TempDir()
	w, err := New(root)
	must(t, err)
	defer w.Close()
	must(t, w.begin("download", msg.ActivityGenerate, nil, nil, func(ctx context.Context) error {
		<-ctx.Done()
		return ctx.Err()
	}))
	defer func() { w.Cancel(); <-w.Done() }()
	if err := w.RelocateStorage(filepath.Join(t.TempDir(), "moved")); err == nil {
		t.Fatal("后台任务进行中应拒绝迁移")
	}
}

func TestCleanupPreviousRemovesOldRootOnlyAfterSwitch(t *testing.T) {
	isolateConfig(t)
	previous := t.TempDir()
	must(t, os.WriteFile(filepath.Join(previous, "state.json"), []byte("{}"), 0600))
	must(t, os.MkdirAll(filepath.Join(previous, "models"), 0700))
	target := t.TempDir()
	must(t, store.WriteConfig(store.StorageConfig{DataPath: target, PreviousPath: previous}))

	// 宿主仍在旧目录启动时绝不删除。
	removed, err := store.CleanupPrevious(previous)
	must(t, err)
	if removed != "" {
		t.Fatal("当前目录不是迁移目标时不应删除旧目录")
	}
	if _, err := os.Stat(previous); err != nil {
		t.Fatal("旧目录被误删", err)
	}

	removed, err = store.CleanupPrevious(target)
	must(t, err)
	if removed != previous {
		t.Fatalf("应删除旧目录，实际: %q", removed)
	}
	if _, err := os.Stat(previous); !os.IsNotExist(err) {
		t.Fatal("旧目录未删除")
	}
	cfg, err := store.ReadConfig()
	must(t, err)
	if cfg.PreviousPath != "" || cfg.DataPath != target {
		t.Fatalf("清理后配置不正确: %+v", cfg)
	}
}

func TestOrphanHistoryKeepsTimelineClipsAndFreshResults(t *testing.T) {
	root := t.TempDir()
	w, err := New(root)
	must(t, err)
	defer w.Close()

	gone := schema.DefaultDraft()
	gone.ID = schema.NewID()
	used := schema.Generation{ID: schema.NewID(), FileName: "used.wav", Duration: 2, CreatedAt: time.Now().Add(-72 * time.Hour), Settings: gone}
	old := schema.Generation{ID: schema.NewID(), FileName: "old.wav", CreatedAt: time.Now().Add(-48 * time.Hour), Settings: gone}
	fresh := schema.Generation{ID: schema.NewID(), FileName: "fresh.wav", CreatedAt: time.Now(), Settings: gone}
	for _, g := range []schema.Generation{used, old, fresh} {
		must(t, os.WriteFile(filepath.Join(root, "outputs", g.FileName), []byte("wav"), 0600))
	}
	must(t, w.Store.Update(func(s *schema.State) { s.History = append([]schema.Generation{fresh, old, used}, s.History...) }, true))
	other := schema.DefaultDraft()
	other.ID = schema.NewID()
	other.Timeline = &schema.AudioTimeline{Tracks: []schema.AudioLane{{ID: "track", Name: "人声", Clips: []schema.AudioClip{{ID: "clip", GenerationID: used.ID, Duration: 1}}}}}
	must(t, w.SaveDraft(other))

	// 接口历史修剪：时间线使用的版本不计入限额，也不被删除。
	w.pruneOrphanHistory(1)
	has := func(id string) bool {
		for _, g := range w.Store.Read().History {
			if g.ID == id {
				return true
			}
		}
		return false
	}
	if !has(used.ID) || !has(fresh.ID) || has(old.ID) {
		t.Fatal("修剪结果不正确：应保留时间线版本与最新版本，删除更旧的孤儿版本")
	}
	if _, err := os.Stat(filepath.Join(root, "outputs", "used.wav")); err != nil {
		t.Fatal("时间线使用的音频被删除", err)
	}

	_, err = w.CleanupResiduals()
	must(t, err)
	if !has(used.ID) || !has(fresh.ID) {
		t.Fatal("清理残留不应删除时间线使用的版本或 24 小时内的接口结果")
	}
}

func TestDeleteDraftRemovesImportedAssets(t *testing.T) {
	root := t.TempDir()
	w, err := New(root)
	must(t, err)
	defer w.Close()
	assetID := schema.NewID()
	asset := schema.AudioAsset{ID: assetID, Name: "配乐", FileName: "import-" + assetID + ".wav", Duration: 1}
	path := filepath.Join(root, "outputs", asset.FileName)
	must(t, os.WriteFile(path, testkit.WAV(), 0600))
	d := schema.DefaultDraft()
	d.ID = schema.NewID()
	d.Timeline = &schema.AudioTimeline{Assets: []schema.AudioAsset{asset}, Tracks: []schema.AudioLane{{ID: "track", Name: "配乐", Clips: []schema.AudioClip{{ID: "clip", AssetID: assetID, Duration: 1}}}}}
	must(t, w.SaveDraft(d))
	must(t, w.DeleteDraft(d.ID))
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("删除作品后导入的时间线素材未删除")
	}
}
