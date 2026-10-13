package workbench

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
	"yovoice/internal/msg"
	"yovoice/internal/schema"
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

func TestStorageInfoAndRelocate(t *testing.T) {
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
