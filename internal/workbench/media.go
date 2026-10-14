package workbench

import (
	"os"
	"slices"
	"strings"
	"unicode"
	"yovoice/internal/msg"
	"yovoice/internal/schema"
)

func (w *Workbench) MediaFile(kind, id string) (string, error) {
	if !schema.ValidID(id) {
		return "", msg.Err(msg.ErrAudioIDInvalid, nil)
	}
	s := w.Store.Read()
	var file string
	switch kind {
	case "voices":
		for _, v := range s.Voices {
			if v.ID == id {
				file = v.FileName
			}
		}
	case "outputs":
		for _, c := range s.Characters {
			if c.Preview != nil && c.Preview.ID == id {
				file = c.Preview.FileName
			}
		}
		for _, p := range s.Previews {
			if p.ID == id {
				file = p.FileName
			}
		}
		for _, v := range s.History {
			if v.ID == id {
				file = v.FileName
			}
		}
	default:
		return "", msg.Err(msg.ErrAudioKindInvalid, nil)
	}
	if file == "" {
		return "", msg.Err(msg.ErrAudioMissing, nil)
	}
	return w.Store.MediaPath(kind, file)
}
func (w *Workbench) RenameMedia(kind, id, name string) error {
	w.edit.Lock()
	defer w.edit.Unlock()
	if _, e := w.MediaFile(kind, id); e != nil {
		return e
	}
	name = strings.TrimSpace(name)
	if schema.TextLen(name) < 1 || schema.TextLen(name) > 120 || strings.ContainsFunc(name, unicode.IsControl) {
		return msg.Err(msg.ErrNameLength, nil)
	}
	return w.Store.Update(func(s *schema.State) {
		if kind == "voices" {
			for i := range s.Voices {
				if s.Voices[i].ID == id {
					s.Voices[i].Name = name
				}
			}
		} else {
			for i := range s.History {
				if s.History[i].ID == id {
					s.History[i].Title = name
				}
			}
		}
	}, true)
}
func (w *Workbench) DeleteMedia(kind, id string) error {
	w.edit.Lock()
	defer w.edit.Unlock()
	s := w.Store.Read()
	var file string
	switch kind {
	case "voices":
		for _, v := range s.Voices {
			if v.ID == id {
				file = v.FileName
			}
		}
	case "outputs":
		for _, v := range s.History {
			if v.ID == id {
				file = v.FileName
			}
		}
	default:
		return msg.Err(msg.ErrAudioKindInvalid, nil)
	}
	if file == "" {
		return msg.Err(msg.ErrAudioMissing, nil)
	}
	if kind == "voices" {
		users := s.VoiceUsers(id)
		if len(users) > 0 {
			return msg.Err(msg.ErrVoiceReferenced, msg.Params{"names": strings.Join(users, "、")})
		}
	}
	if kind == "voices" && s.Activity != nil && s.Activity.Kind == "generate" && s.Activity.Status == "running" {
		return msg.Err(msg.ErrVoiceBusyDelete, nil)
	}
	if kind == "outputs" {
		for _, draft := range s.Drafts {
			if draft.Timeline == nil {
				continue
			}
			for _, track := range draft.Timeline.Tracks {
				if slices.ContainsFunc(track.Clips, func(c schema.AudioClip) bool { return c.GenerationID == id }) {
					return msg.Err(msg.ErrTimelineInUse, nil)
				}
			}
		}
	}
	path, pathErr := w.Store.MediaPath(kind, file)
	var removed string
	exists := false
	if pathErr == nil {
		if _, statErr := os.Lstat(path); statErr == nil {
			exists = true
			removed = path + ".deleted"
			if e := os.Rename(path, removed); e != nil {
				if delErr := os.Remove(path); delErr == nil {
					exists = false
				} else {
					return e
				}
			}
		}
	}
	e := w.Store.Update(func(s *schema.State) {
		if kind == "outputs" {
			s.History = slices.DeleteFunc(s.History, func(v schema.Generation) bool { return v.ID == id })
		} else {
			s.Voices = slices.DeleteFunc(s.Voices, func(v schema.Voice) bool { return v.ID == id })
			// 可见引用已在前面阻止删除，这里清理的是被说话人设置覆盖的隐藏引用，避免留下悬空 ID。
			for i := range s.Drafts {
				s.Drafts[i].EachSettings(func(settings *schema.SynthesisSettings) { clearVoice(settings, id) })
			}
			for i := range s.History {
				if value(s.History[i].Settings.VoiceID) == id {
					s.History[i].Settings.VoiceID = nil
				}
				if value(s.History[i].Settings.EmotionVoiceID) == id {
					s.History[i].Settings.EmotionVoiceID = nil
				}
			}
		}
	}, true)
	if e != nil {
		if exists && removed != "" {
			_ = os.Rename(removed, path)
		}
		return e
	}
	if exists && removed != "" {
		// 同一文件仍被其他记录引用（例如复制作品共享的素材）时放回原处，否则删除。
		if w.Store.Read().MediaRefs()[kind][file] {
			_ = os.Rename(removed, path)
		} else {
			_ = os.Remove(removed)
		}
	}
	return nil
}
