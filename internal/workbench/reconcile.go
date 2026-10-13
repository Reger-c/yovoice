package workbench

import (
	"os"
	"slices"
	"yovoice/internal/diag"
	"yovoice/internal/schema"
)

// ReconcileReport 记录启动自检修复的悬空引用数量。
type ReconcileReport struct {
	Clips    int `json:"clips"`
	Assets   int `json:"assets"`
	Accepted int `json:"accepted"`
	Previews int `json:"previews"`
}

func (r ReconcileReport) changed() bool {
	return r.Clips+r.Assets+r.Accepted+r.Previews > 0
}

// Reconcile 在启动时修复指向已不存在数据的引用。
// 时间线片段的源版本或导入素材缺失时，作品保存会被校验永久拒绝；
// 这里把悬空的片段、素材和已采纳记录移除，让作品恢复可编辑，而不是卡在无法保存的状态。
func (w *Workbench) Reconcile() (ReconcileReport, error) {
	w.edit.Lock()
	defer w.edit.Unlock()
	var report ReconcileReport
	s := w.Store.Read()
	generations := map[string]bool{}
	for _, g := range s.History {
		generations[g.ID] = true
	}
	exists := func(name string) bool {
		path, err := w.Store.MediaPath("outputs", name)
		if err != nil {
			return false
		}
		_, err = os.Stat(path)
		return err == nil
	}
	missingAssets := map[string]map[string]bool{}
	for _, d := range s.Drafts {
		if d.Timeline == nil {
			continue
		}
		for _, asset := range d.Timeline.Assets {
			if !exists(asset.FileName) {
				if missingAssets[d.ID] == nil {
					missingAssets[d.ID] = map[string]bool{}
				}
				missingAssets[d.ID][asset.ID] = true
			}
		}
	}
	missingPreviews := map[string]bool{}
	for _, c := range s.Characters {
		if c.Preview != nil && !exists(c.Preview.FileName) {
			missingPreviews[c.ID] = true
		}
	}
	fix := func(state *schema.State, count bool) {
		for i := range state.Drafts {
			t := state.Drafts[i].Timeline
			if t == nil {
				continue
			}
			missing := missingAssets[state.Drafts[i].ID]
			assets := map[string]bool{}
			before := len(t.Assets)
			t.Assets = slices.DeleteFunc(t.Assets, func(a schema.AudioAsset) bool { return missing[a.ID] })
			for _, a := range t.Assets {
				assets[a.ID] = true
			}
			for j := range t.Tracks {
				clips := len(t.Tracks[j].Clips)
				t.Tracks[j].Clips = slices.DeleteFunc(t.Tracks[j].Clips, func(c schema.AudioClip) bool {
					if c.AssetID != "" {
						return !assets[c.AssetID]
					}
					return !generations[c.GenerationID]
				})
				if count {
					report.Clips += clips - len(t.Tracks[j].Clips)
				}
			}
			accepted := len(t.AcceptedGenerations)
			t.AcceptedGenerations = slices.DeleteFunc(t.AcceptedGenerations, func(id string) bool { return !generations[id] })
			if count {
				report.Assets += before - len(t.Assets)
				report.Accepted += accepted - len(t.AcceptedGenerations)
			}
		}
		for i := range state.Characters {
			if missingPreviews[state.Characters[i].ID] {
				state.Characters[i].Preview = nil
				if count {
					report.Previews++
				}
			}
		}
	}
	// 先在快照上计算，确有悬空引用时才写盘，避免每次启动都改写状态文件。
	probe := s
	fix(&probe, true)
	if !report.changed() {
		return report, nil
	}
	if err := w.Store.Update(func(state *schema.State) { fix(state, false) }, true); err != nil {
		return report, err
	}
	diag.Log(w.Store.Root, "state.reconciled", "clips", report.Clips, "assets", report.Assets, "accepted", report.Accepted, "previews", report.Previews)
	return report, nil
}
