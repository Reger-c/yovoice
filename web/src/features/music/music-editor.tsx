import { useRef, useState } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { DropdownMenu } from '@astryxdesign/core/DropdownMenu';
import { HStack, VStack } from '@astryxdesign/core/Layout';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { TextArea } from '@astryxdesign/core/TextArea';
import { Token } from '@astryxdesign/core/Token';
import { useTranslator } from '@astryxdesign/core/i18n';
import { Lightbulb } from 'lucide-react';
import { call } from '../../shared/lib/client';
import { AIComposer } from '../../shared/ui/ai-composer';
import { isUntitled, isYuE, type Draft, type State, type UiLocale } from '../../shared/workbench';
import { createMusicDraft, lyricSections, lyricsPatch, splitTags } from './music-draft';

// 音乐创作区：参照 Suno、Udio 的写法，从上到下是“一句话交给 AI → 风格 → 歌词”；生成的版本在“版本记录”里查看。
// 一句话可以直接写出风格和歌词，也可以手动填写；纯音乐与填写歌词是并列的两种模式。
export function MusicEditor({ draft, state, change, locale, configureAI }: {
  draft: Draft; state: State; change: (patch: Partial<Draft>) => void; locale: UiLocale; configureAI: () => void;
}) {
  const t = useTranslator();
  // YuE2 只能生成带人声的歌曲，选中时隐藏纯音乐切换。
  const yue = isYuE(draft.modelId);
  const lyrics = useRef<HTMLTextAreaElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [inputVal, setInputVal] = useState('');
  const tags = splitTags(draft.text);

  const toggleTag = (tag: string) => {
    const next = tags.includes(tag) ? tags.filter(item => item !== tag) : [...tags, tag];
    change({ text: next.join(', ').slice(0, 512) });
  };
  const addTag = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    const newItems = splitTags(trimmed);
    const combined = Array.from(new Set([...tags, ...newItems]));
    change({ text: combined.join(', ').slice(0, 512) });
    setInputVal('');
  };
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
      e.preventDefault();
      addTag(inputVal);
    } else if (e.key === 'Backspace' && !inputVal && tags.length > 0) {
      change({ text: tags.slice(0, -1).join(', ') });
    }
  };
  const handleBlur = () => {
    if (inputVal.trim()) {
      addTag(inputVal);
    }
  };
  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text');
    if (text.includes(',') || text.includes('，') || text.includes('\n')) {
      e.preventDefault();
      addTag(text);
    }
  };
  // 在光标处插入段落标记；标记单独占一行，便于 ACE-Step 识别结构。
  const insertSection = (section: string) => {
    const element = lyrics.current; const value = draft.lyrics ?? '';
    const start = element?.selectionStart ?? value.length, end = element?.selectionEnd ?? value.length;
    const before = value.slice(0, start);
    const tag = `${before && !before.endsWith('\n\n') ? (before.endsWith('\n') ? '\n' : '\n\n') : ''}[${section}]\n`;
    change({ lyrics: (before + tag + value.slice(end)).slice(0, 4000) });
    requestAnimationFrame(() => { element?.focus(); element?.setSelectionRange(start + tag.length, start + tag.length); });
  };
  const empty = !draft.text.trim() && !draft.lyrics?.trim();
  const applyLyrics = (value: unknown) => change(lyricsPatch(draft, value));
  return <VStack className="music-editor" gap={5}>
    <AIComposer kind="lyrics" projectId={draft.id} state={state} overwrite={!empty} configure={configureAI} apply={applyLyrics}
      placeholder={t(draft.instrumental ? '@yovoice.ai.lyricsPlaceholderInstrumental' : '@yovoice.ai.lyricsPlaceholder')} submitLabel={t('@yovoice.ai.lyricsSubmit')}
      start={brief => call('ai.lyrics', { projectId: draft.id, brief, instrumental: !!draft.instrumental, language: draft.synthesisLanguage ?? '', locale })} />
    <VStack className="music-block" gap={3}>
      <HStack className="music-style-header" hAlign="between" vAlign="center" gap={2}>
        <h2>{t('@yovoice.music.style')}</h2>
        {empty ? <Button size="sm" variant="secondary" icon={<Lightbulb />} label={t('@yovoice.music.example')} onClick={() => { const example = createMusicDraft(locale); change({ text: example.text, lyrics: example.lyrics, synthesisLanguage: example.synthesisLanguage, ...(isUntitled(draft.title) ? { title: example.title } : {}) }); }} /> : null}
      </HStack>

      {/* 风格标签输入区：展示已选Token胶囊，并在行内支持直接打字、回车/逗号追加、退格删除 */}
      <HStack
        className="music-style-box"
        gap={1}
        vAlign="center"
        wrap="wrap"
        onClick={() => inputRef.current?.focus()}
      >
        <input
          className="music-style-field"
          aria-label={t('@yovoice.music.style')}
          value={draft.text}
          readOnly
          tabIndex={-1}
        />
        {tags.map(tag => (
          <Token key={tag} size="sm" label={tag} onRemove={() => toggleTag(tag)} />
        ))}
        <input
          ref={inputRef}
          className="music-inline-input grow"
          aria-label={t('@yovoice.music.addTag')}
          placeholder={tags.length === 0 ? t('@yovoice.music.stylePlaceholder') : t('@yovoice.music.addTagPlaceholder')}
          value={inputVal}
          onChange={e => setInputVal(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          onPaste={handlePaste}
        />
      </HStack>
    </VStack>
    <VStack className="music-block" gap={3}>
      <HStack vAlign="center" gap={2} wrap="wrap">
        <h2 className="grow">{t('@yovoice.music.lyrics')}</h2>
        {!draft.instrumental || yue ? <DropdownMenu hasChevron alignment="end" button={{ size: 'sm', variant: 'ghost', label: t('@yovoice.music.insertSection') }}
          items={lyricSections.map(section => ({ label: `[${section}]`, onClick: () => insertSection(section) }))} /> : null}
        {yue ? <small>{t('@yovoice.music.yueVocalOnly')}</small> : <SegmentedControl label={t('@yovoice.music.lyricsMode')} size="sm" value={draft.instrumental ? 'instrumental' : 'vocal'} onChange={value => change({ instrumental: value === 'instrumental' })}>
          <SegmentedControlItem value="vocal" label={t('@yovoice.music.vocal')} />
          <SegmentedControlItem value="instrumental" label={t('@yovoice.music.instrumental')} />
        </SegmentedControl>}
      </HStack>
      {draft.instrumental && !yue
        ? <p className="music-instrumental">{t('@yovoice.music.instrumentalHint')}</p>
        : <TextArea ref={lyrics} className="music-lyrics" label={t('@yovoice.music.lyrics')} isLabelHidden value={draft.lyrics ?? ''} maxLength={4000} rows={14} hasSpellCheck={false} placeholder={t('@yovoice.music.lyricsPlaceholder')} onChange={value => change({ lyrics: value.slice(0, 4000) })} />}
    </VStack>
  </VStack>;
}
