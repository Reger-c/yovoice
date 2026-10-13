package workbench

import (
	"encoding/json"
	"os"
	"slices"
	"time"
	"yovoice/internal/diag"
	"yovoice/internal/msg"
	"yovoice/internal/schema"
)

func (w *Workbench) SaveDraft(d schema.Draft) error {
	w.edit.Lock()
	defer w.edit.Unlock()
	return w.saveDraft(d)
}

// saveDraft 要求调用方持有编辑锁。
func (w *Workbench) saveDraft(d schema.Draft) (err error) {
	started := time.Now()
	stage := "validate_kind"
	defer func() {
		diag.Log(w.Store.Root, "draft.save", "project_id", d.ID, "model_id", d.ModelID, "text_length", schema.TextLen(d.Text), "stage", stage, "elapsed_ms", time.Since(started).Milliseconds(), "error", diag.Error(err))
	}()
	d.EnsureCueIDs()
	if !slices.Contains([]string{"", "text", "story", "subtitle", "music", "score"}, d.Kind) {
		return msg.Err(msg.ErrDraftLimits, nil)
	}
	stage = "validate_assets"
	if err := w.validateTimelineAssets(d.Timeline); err != nil {
		return err
	}
	stage = "validate_timeline"
	if err := schema.ValidateTimeline(d.Timeline, w.Store.Read().History); err != nil {
		return err
	}
	stage = "validate_subtitles"
	if _, err := d.SubtitleDrafts(); err != nil {
		return err
	}
	stage = "validate_limits"
	if !schema.ValidID(d.ID) || schema.TextLen(d.Text) > 12000 || schema.TextLen(d.Title) > 120 || schema.TextLen(d.EmotionText) > 500 || schema.TextLen(d.VoiceDescription) > 500 || schema.TextLen(d.ReferenceText) > 2000 || schema.TextLen(d.Lyrics) > 4000 || !schema.ScoreWithinLimits(d.Score) {
		return msg.Err(msg.ErrDraftLimits, nil)
	}
	stage = "persist"
	return w.Store.Update(func(s *schema.State) {
		i := slices.IndexFunc(s.Drafts, func(v schema.Draft) bool { return v.ID == d.ID })
		// 打开作品会触发保存，只有内容变化才更新排序时间。
		if i >= 0 {
			d.CreatedAt = s.Drafts[i].CreatedAt
			d.UpdatedAt = s.Drafts[i].UpdatedAt
			before, _ := json.Marshal(s.Drafts[i])
			after, _ := json.Marshal(d)
			if string(before) == string(after) {
				return
			}
		}
		now := time.Now()
		d.UpdatedAt = &now
		if i < 0 {
			d.CreatedAt = &now
			s.Drafts = append([]schema.Draft{d}, s.Drafts...)
		} else {
			s.Drafts[i] = d
		}
	}, true)
}

func (w *Workbench) DeleteDraft(id string) error {
	if !schema.ValidID(id) {
		return msg.Err(msg.ErrDraftIDInvalid, nil)
	}
	w.edit.Lock()
	defer w.edit.Unlock()
	s := w.Store.Read()
	if s.Activity != nil && s.Activity.Kind == "generate" && s.Activity.Status == "running" && s.Activity.ProjectID == id {
		return msg.Err(msg.ErrBusy, nil)
	}
	referenced := map[string]bool{}
	for _, d := range s.Drafts {
		if d.ID == id || d.Timeline == nil {
			continue
		}
		for _, track := range d.Timeline.Tracks {
			for _, clip := range track.Clips {
				if clip.GenerationID != "" {
					referenced[clip.GenerationID] = true
				}
			}
		}
	}
	deleteIDs := map[string]bool{}
	var filesToDelete []string
	for _, g := range s.History {
		if g.Settings.ID == id {
			if !referenced[g.ID] {
				deleteIDs[g.ID] = true
				if p, err := w.Store.MediaPath("outputs", g.FileName); err == nil {
					filesToDelete = append(filesToDelete, p)
				}
			}
		}
	}
	err := w.Store.Update(func(s *schema.State) {
		s.Drafts = slices.DeleteFunc(s.Drafts, func(d schema.Draft) bool { return d.ID == id })
		if len(deleteIDs) > 0 {
			s.History = slices.DeleteFunc(s.History, func(g schema.Generation) bool { return deleteIDs[g.ID] })
		}
	}, true)
	if err != nil {
		return err
	}
	for _, f := range filesToDelete {
		_ = os.Remove(f)
	}
	return nil
}
