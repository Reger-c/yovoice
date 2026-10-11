import { useRef, useState } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { DropdownMenu } from '@astryxdesign/core/DropdownMenu';
import { Grid } from '@astryxdesign/core/Grid';
import { HStack, VStack } from '@astryxdesign/core/Layout';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { TextArea } from '@astryxdesign/core/TextArea';
import { useTranslator } from '@astryxdesign/core/i18n';
import { AudioLines, Check, ChevronDown, ChevronUp, Play, Sparkles } from 'lucide-react';
import { call } from '../../shared/lib/client';
import { AIComposer } from '../../shared/ui/ai-composer';
import { formatTime, type Draft, type Generation, type State, type UiLocale } from '../../shared/workbench';
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
        {empty ? <Button size="sm" variant="secondary" icon={<Sparkles />} label={t('@yovoice.music.example')} onClick={() => { const example = createMusicDraft(locale); change({ text: example.text, lyrics: example.lyrics, synthesisLanguage: example.synthesisLanguage, ...(draft.title === createMusicDraft(locale, false).title ? { title: example.title } : {}) }); }} /> : null}
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
        {!draft.instrumental ? <DropdownMenu hasChevron alignment="end" button={{ size: 'sm', variant: 'ghost', label: t('@yovoice.music.insertSection') }}
          items={lyricSections.map(section => ({ label: `[${section}]`, onClick: () => insertSection(section) }))} /> : null}
        <SegmentedControl label={t('@yovoice.music.lyricsMode')} size="sm" value={draft.instrumental ? 'instrumental' : 'vocal'} onChange={value => change({ instrumental: value === 'instrumental' })}>
          <SegmentedControlItem value="vocal" label={t('@yovoice.music.vocal')} />
          <SegmentedControlItem value="instrumental" label={t('@yovoice.music.instrumental')} />
        </SegmentedControl>
      </HStack>
      {draft.instrumental
        ? <p className="music-instrumental">{t('@yovoice.music.instrumentalHint')}</p>
        : <TextArea ref={lyrics} className="music-lyrics" label={t('@yovoice.music.lyrics')} isLabelHidden value={draft.lyrics ?? ''} maxLength={4000} rows={14} hasSpellCheck={false} placeholder={t('@yovoice.music.lyricsPlaceholder')} onChange={value => change({ lyrics: value.slice(0, 4000) })} />}
    </VStack>
    <VStack className="music-block" gap={3}>
      <HStack hAlign="between" vAlign="center"><h2>{t('@yovoice.music.takes')}</h2>{takes.length ? <small>{t('@yovoice.music.takeCount', { count: takes.length })}</small> : null}</HStack>
      {takes.length ? <Grid columns={{ minWidth: 160 }} gap={4}>
        {takes.map((take, index) => <Button key={take.id} variant="ghost" className="music-take" aria-current={take.id === current ? 'true' : undefined} label={t('@yovoice.music.take', { n: takes.length - index })} onClick={() => select(take)}>
          <VStack gap={2} width="100%">
            <SongCover seed={take.id} animated={take.id === current} />
            <HStack hAlign="between" vAlign="center" gap={2}>
              <HStack gap={1} vAlign="center">{take.id === current ? <AudioLines size={14} aria-hidden /> : <Play size={14} aria-hidden />}<b>{t('@yovoice.music.take', { n: takes.length - index })}</b></HStack>
              <small className="music-take-duration">{formatTime(take.duration)}</small>
            </HStack>
            <small className="music-take-style">{take.settings.instrumental ? `${t('@yovoice.music.instrumental')} · ` : ''}{take.settings.text}</small>
          </VStack>
        </Button>)}
      </Grid> : <p className="music-empty">{t('@yovoice.music.noTakes')}</p>}
    </VStack>
  </VStack>;
}
