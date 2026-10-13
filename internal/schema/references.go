package schema

// VoiceUsers 检查素材的使用范围；已生成的历史版本为独立文件，不作为阻断。
func (s State) VoiceUsers(id string) []string {
	uses := func(settings SynthesisSettings) bool {
		return value(settings.VoiceID) == id || value(settings.EmotionVoiceID) == id
	}
	draftUses := func(d Draft) bool {
		for _, settings := range d.AllSettings() {
			if uses(settings) {
				return true
			}
		}
		return false
	}
	var names []string
	for _, c := range s.Characters {
		used := uses(c.Settings)
		for _, p := range c.Performances {
			used = used || uses(p.Settings)
		}
		if c.Preview != nil {
			used = used || uses(c.Preview.Settings)
		}
		if used {
			names = append(names, c.Name)
		}
	}
	for _, d := range s.Drafts {
		if draftUses(d) {
			names = append(names, d.Title)
		}
	}
	return names
}

// allSettings 包含台词演绎快照，用于素材引用保护和作品归档。
func (d Draft) AllSettings() []SynthesisSettings {
	settings := []SynthesisSettings{d.SynthesisSettings}
	if d.Performance != nil {
		settings = append(settings, d.Performance.Settings)
	}
	if d.Subtitles != nil {
		for _, s := range d.Subtitles.Speakers {
			if s.Settings != nil {
				settings = append(settings, *s.Settings)
			}
		}
		for _, c := range d.Subtitles.Cues {
			if c.Performance != nil {
				settings = append(settings, c.Performance.Settings)
			}
		}
	}
	return settings
}

func value(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
