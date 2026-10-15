import { useRef, useState } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { DropdownMenu } from '@astryxdesign/core/DropdownMenu';
import { HStack, VStack } from '@astryxdesign/core/Layout';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { TextArea } from '@astryxdesign/core/TextArea';
import { Token } from '@astryxdesign/core/Token';
import { useTranslator } from '@astryxdesign/core/i18n';
import { AudioLines, Lightbulb, Play, RotateCcw, Trash2 } from 'lucide-react';
import { call } from '../../shared/lib/client';
import { AIComposer } from '../../shared/ui/ai-composer';
import { formatTime, isUntitled, isYuE, type Draft, type Generation, type State, type UiLocale } from '../../shared/workbench';
import { createMusicDraft, lyricSections, lyricsPatch, splitTags } from './music-draft';

import { SongCover } from './song-cover';

// 音乐创作区：参照 Suno、Udio 的写法，从上到下是“一句话交给 AI → 风格 → 歌词 → 版本”。
// 一句话可以直接写出风格和歌词，也可以手动填写；纯音乐与填写歌词是并列的两种模式。
export function MusicEditor({ draft, state, change, locale, takes, current, select, remove, configureAI }: {
  draft: Draft; state: State; change: (patch: Partial<Draft>) => void; locale: UiLocale;
  takes: Generation[]; current?: string; select: (take: Generation) => void; remove: (take: Generation) => void; configureAI: () => void;
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
    <VStack className="music-block" gap={3}>
      <HStack hAlign="between" vAlign="center"><h2>{t('@yovoice.music.takes')}</h2>{takes.length ? <small>{t('@yovoice.music.takeCount', { count: takes.length })}</small> : null}</HStack>
      {takes.length ? <VStack className="music-takes" gap={0} role="list">
        {takes.map((take, index) => {
          const tags = splitTags(take.settings.text), playing = take.id === current;
          return <HStack key={take.id} className="music-take-row" role="listitem" data-current={playing} gap={2} vAlign="center">
            <Button variant="ghost" className="music-take grow" aria-current={playing ? 'true' : undefined} label={t('@yovoice.music.take', { n: takes.length - index })} onClick={() => select(take)}>
              <HStack gap={3} vAlign="center" width="100%">
                <HStack className="music-take-cover" gap={0} hAlign="center" vAlign="center"><SongCover seed={take.id} animated={playing} size={112} />{playing ? <AudioLines className="music-take-state" size={16} aria-hidden /> : <Play className="music-take-state" size={16} fill="currentColor" aria-hidden />}</HStack>
                <VStack className="grow music-take-text" gap={1}>
                  <HStack gap={2} vAlign="center"><b>{t('@yovoice.music.take', { n: takes.length - index })}</b><small className="music-take-date">{new Date(take.createdAt).toLocaleString(locale, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</small></HStack>
                  <HStack className="music-take-tags" gap={1} vAlign="center">
                    {take.settings.instrumental ? <Token size="sm" label={t('@yovoice.music.instrumental')} /> : null}
                    {tags.slice(0, 4).map(tag => <Token key={tag} size="sm" label={tag} />)}
                    {tags.length > 4 ? <small>+{tags.length - 4}</small> : null}
                  </HStack>
                </VStack>
                <small className="music-take-duration">{formatTime(take.duration)}</small>
              </HStack>
            </Button>
            <Button variant="ghost" size="sm" isIconOnly icon={<RotateCcw />} label={t('@yovoice.music.reuseTake')} tooltip={t('@yovoice.music.reuseTake')} onClick={() => change({ text: take.settings.text, lyrics: take.settings.lyrics, instrumental: take.settings.instrumental, synthesisLanguage: take.settings.synthesisLanguage, modelOptions: take.settings.modelOptions, seed: take.settings.seed })} />
            <Button variant="ghost" size="sm" isIconOnly icon={<Trash2 />} label={t('@yovoice.app.deleteVersion', { n: takes.length - index })} tooltip={t('@yovoice.app.deleteVersion', { n: takes.length - index })} onClick={() => remove(take)} />
          </HStack>;
        })}
      </VStack> : <p className="music-empty">{t('@yovoice.music.noTakes')}</p>}
    </VStack>
  </VStack>;
}
