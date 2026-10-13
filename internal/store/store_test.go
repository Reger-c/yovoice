package store

import (
	"os"
	"path/filepath"
	"testing"
	"yovoice/internal/msg"
	"yovoice/internal/schema"
)

func TestStoreDoesNotReplayPreviousFailure(t *testing.T) {
	root := t.TempDir()
	store, err := New(root)
	must(t, err)
	for _, status := range []string{"failed", "running"} {
		must(t, store.Update(func(state *schema.State) {
			code := msg.ErrAudioDecode
			state.Activity = &schema.Activity{Kind: "generate", Status: status, Code: msg.ActivityFailed, ErrorCode: &code}
		}, true))
		reopened, err := New(root)
		must(t, err)
		activity := reopened.Read().Activity
		if status == "failed" && activity != nil {
			t.Fatal("重启不应重新显示历史失败提示")
		}
		if status == "running" && (activity == nil || activity.Status != "interrupted" || activity.ErrorCode != nil) {
			t.Fatal("未结束的操作仍应标记为中断")
		}
	}
}

func TestCorruptSnapshotsAreBounded(t *testing.T) {
	root := t.TempDir()
	s, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.Update(func(*schema.State) {}, true); err != nil {
		t.Fatal(err)
	}
	if err = s.Update(func(*schema.State) {}, true); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < keepCorrupt+2; i++ {
		if err = os.WriteFile(filepath.Join(root, "state.json"), []byte("broken"), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err = New(root); err != nil {
			t.Fatal(err)
		}
	}
	files, _ := filepath.Glob(filepath.Join(root, "state.corrupt-*.json"))
	if len(files) != keepCorrupt {
		t.Fatal("损坏快照数量未受限", len(files))
	}
}
