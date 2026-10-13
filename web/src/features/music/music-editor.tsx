import { useRef, useState } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { DropdownMenu } from '@astryxdesign/core/DropdownMenu';
import { HStack, VStack } from '@astryxdesign/core/Layout';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { TextArea } from '@astryxdesign/core/TextArea';
import { Token } from '@astryxdesign/core/Token';
import { useTranslator } from '@astryxdesign/core/i18n';
import { AudioLines, Check, ChevronDown, ChevronUp, Lightbulb, Play, RotateCcw } from 'lucide-react';
import { call } from '../../shared/lib/client';
import { AIComposer } from '../../shared/ui/ai-composer';
import { formatTime, isYuE, type Draft, type Generation, type State, type UiLocale } from '../../shared/workbench';
import { createMusicDraft, lyricSections, musicLanguages, styleTags } from './music-draft';

import { SongCover } from './song-cover';

interface Lyrics { title: string; style: string; lyrics: string; language: string }

const splitTags = (style: string) => style.split(/[,，]/).map(tag => tag.trim()).filter(Boolean);

// 音乐创作区：参照 Suno、Udio 的写法，从上到下是“一句话交给 AI → 风格 → 歌词 → 版本”。
// 一句话可以直接写出风格和歌词，也可以手动填写；纯音乐与填写歌词是并列的两种模式。
export function MusicEditor({ draft, state, change, locale, takes, current, select, configureAI }: {
  draft: Draft; state: State; change: (patch: Partial<Draft>) => void; locale: UiLocale;
  takes: Generation[]; current?: string; select: (take: Generation) => void; configureAI: () => void;
}) {
  const t = useTranslator();
  // YuE2 只能生成带人声的歌曲，选中时隐藏纯音乐切换。
  const yue = isYuE(draft.modelId);
  const [allTags, setAllTags] = useState(false);
  const lyrics = useRef<HTMLTextAreaElement>(null);
  const tags = splitTags(draft.text);
  const toggleTag = (tag: string) => {
    const next = tags.includes(tag) ? tags.filter(item => item !== tag) : [...tags, tag];
    change({ text: next.join(', ').slice(0, 512) });
  };
  // 默认只显示一行：已选标签在前，其余用流派补足。
  const known: readonly string[] = Object.values(styleTags).flat();
  const quickTags = [...tags.filter(tag => known.includes(tag)), ...styleTags.genre.filter(tag => !tags.includes(tag))].slice(0, Math.max(8, tags.length));
  const tagButton = (tag: string) => <Button key={tag} className="music-tag" size="sm" variant="secondary" icon={tags.includes(tag) ? <Check /> : undefined} aria-pressed={tags.includes(tag)} label={tag} onClick={() => toggleTag(tag)} />;
  // 展开/收起放在标签行末尾，不单独占一行。
  const groups = Object.keys(styleTags) as (keyof typeof styleTags)[];
  const moreTags = <Button size="sm" variant="ghost" icon={allTags ? <ChevronUp /> : <ChevronDown />} label={t(allTags ? '@yovoice.music.fewerTags' : '@yovoice.music.allTags')} onClick={() => setAllTags(!allTags)} />;
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
  // AI 写歌词：填入风格与歌词；标题仍是默认值时一并替换，歌词语言只接受 ACE-Step 支持的。
  function applyLyrics(value: unknown) {
    const result = value as Lyrics;
    change({
      ...(result.style ? { text: result.style } : {}),
      ...(!draft.instrumental && result.lyrics ? { lyrics: result.lyrics } : {}),
      ...((musicLanguages as readonly string[]).includes(result.language) ? { synthesisLanguage: result.language } : {}),
      ...(result.title && draft.title === createMusicDraft(locale, false).title ? { title: result.title } : {}),
    });
  }
  return <VStack className="music-editor" gap={5}>
    <AIComposer kind="lyrics" projectId={draft.id} state={state} overwrite={!empty} configure={configureAI} apply={applyLyrics}
      placeholder={t(draft.instrumental ? '@yovoice.ai.lyricsPlaceholderInstrumental' : '@yovoice.ai.lyricsPlaceholder')} submitLabel={t('@yovoice.ai.lyricsSubmit')}
      start={brief => call('ai.lyrics', { projectId: draft.id, brief, instrumental: !!draft.instrumental, language: draft.synthesisLanguage ?? '', locale })} />
    <VStack className="music-block" gap={3}>
      <HStack hAlign="between" vAlign="center" gap={2} wrap="wrap">
        <h2>{t('@yovoice.music.style')}</h2>
        <HStack gap={2} vAlign="center" wrap="wrap">
        {empty ? <Button size="sm" variant="secondary" icon={<Lightbulb />} label={t('@yovoice.music.example')} onClick={() => { const example = createMusicDraft(locale); change({ text: example.text, lyrics: example.lyrics, synthesisLanguage: example.synthesisLanguage, ...(draft.title === createMusicDraft(locale, false).title ? { title: example.title } : {}) }); }} /> : null}
        </HStack>
      </HStack>
      <TextArea className="music-style" label={t('@yovoice.music.style')} isLabelHidden value={draft.text} maxLength={512} rows={2} hasSpellCheck={false} placeholder={t('@yovoice.music.stylePlaceholder')} onChange={text => change({ text: text.slice(0, 512) })} />
      <VStack gap={2} role="group" aria-label={t('@yovoice.music.tags')}>
        {allTags ? groups.map((group, index) => <HStack key={group} gap={2} vAlign="center" wrap="wrap">
          <small className="music-tag-group">{t(`@yovoice.music.tagGroup.${group}`)}</small>
          {styleTags[group].map(tag => tagButton(tag))}
          {index === groups.length - 1 ? moreTags : null}
        </HStack>) : <HStack gap={2} vAlign="center" wrap="wrap">{quickTags.map(tag => tagButton(tag))}{moreTags}</HStack>}
      </VStack>
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
          </HStack>;
        })}
      </VStack> : <p className="music-empty">{t('@yovoice.music.noTakes')}</p>}
    </VStack>
  </VStack>;
}
