import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { Dialog } from '@astryxdesign/core/Dialog';
import { HStack, VStack } from '@astryxdesign/core/Layout';
import { useTranslator } from '@astryxdesign/core/i18n';
import { Maximize, Minimize, Pause, Play, SkipBack, X } from 'lucide-react';
import { mediaUrl } from '../../shared/lib/client';
import { formatTime, type Generation } from '../../shared/workbench';
import { activeLyric, lyricTimeline } from './lyric-timing';
import { splitTags } from './music-draft';
import { coverPalette, SongCover } from './song-cover';

// 包络的时间分辨率（秒）：封面与背景随响度起伏。
const envelopeStep = 0.05;

// 读取整首音频，算出每 50ms 的响度（0~1），只用于动效，失败时不起伏。
async function loudness(url: string) {
  const context = new AudioContext();
  try {
    const response = await fetch(url); if (!response.ok) return [];
    const buffer = await context.decodeAudioData(await response.arrayBuffer());
    const data = buffer.getChannelData(0), size = Math.max(1, Math.round(buffer.sampleRate * envelopeStep));
    const values = Array.from({ length: Math.ceil(data.length / size) }, (_, i) => {
      let sum = 0, count = 0;
      for (let j = i * size; j < Math.min(data.length, (i + 1) * size); j += 16) { sum += data[j] * data[j]; count++; }
      return Math.sqrt(sum / Math.max(1, count));
    });
    const peak = Math.max(...values, 1e-6);
    return values.map(value => value / peak);
  } catch { return []; } finally { await context.close(); }
}

// 音乐播放页：仿 Apple Music 的全屏播放，左侧封面与播放控制，右侧滚动歌词；方便录屏，静置时自动隐藏控件和鼠标。
export function NowPlaying({ item, title, close, onError }: { item: Generation; title: string; close: () => void; onError: (message: string) => void }) {
  const t = useTranslator();
  const audio = useRef<HTMLAudioElement>(null);
  const stage = useRef<HTMLElement>(null);
  const lyricsBox = useRef<HTMLElement>(null);
  const [url, setUrl] = useState('');
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(item.duration);
  const [idle, setIdle] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const envelope = useRef<number[]>([]);
  const lyrics = item.settings.instrumental ? '' : item.settings.lyrics ?? '';
  const lines = useMemo(() => lyricTimeline(lyrics, duration), [lyrics, duration]);
  const current = activeLyric(lines, time);
  const { hue, accent } = coverPalette(item.id);
  const tags = splitTags(item.settings.text).slice(0, 4);

  // 打开即开始播放；浏览器拦截自动播放时停在开头，由用户点播放。
  useEffect(() => {
    let disposed = false, resource = '';
    mediaUrl('outputs', item.fileName).then(value => {
      resource = value;
      if (disposed) { if (value.startsWith('blob:')) URL.revokeObjectURL(value); return; }
      setUrl(value);
      void loudness(value).then(values => { if (!disposed) envelope.current = values; });
    }, (error: Error) => { if (!disposed) onError(error.message); });
    return () => { disposed = true; if (resource.startsWith('blob:')) URL.revokeObjectURL(resource); };
  }, [item.fileName, onError]);
  const toggle = () => {
    const element = audio.current;
    if (!element) return;
    if (!element.paused) { element.pause(); return; }
    element.play().catch((error: DOMException) => { if (error.name !== 'NotAllowedError' && error.name !== 'AbortError') onError('@yovoice.error.audioPlayFailed'); });
  };
  const seek = (value: number) => { if (audio.current) audio.current.currentTime = value; setTime(value); };
  // 播放中逐帧把当前响度写进样式变量，不经过 React 渲染。
  useEffect(() => {
    const element = audio.current, root = stage.current;
    if (!playing || !element || !root || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let frame = 0, level = 0;
    const tick = () => {
      const target = envelope.current[Math.floor(element.currentTime / envelopeStep)] ?? 0;
      level += (target - level) * 0.25;
      root.style.setProperty('--now-playing-level', level.toFixed(3));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(frame); root.style.setProperty('--now-playing-level', '0'); };
  }, [playing]);
  // 当前句滚到歌词区中间。
  useEffect(() => {
    const box = lyricsBox.current, line = box?.querySelector<HTMLElement>(`[data-index="${current}"]`);
    if (!box || !line) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    box.scrollTo({ top: line.offsetTop - box.clientHeight / 2 + line.clientHeight / 2, behavior: reduced ? 'auto' : 'smooth' });
  }, [current]);
  // 播放中鼠标静置 2.5 秒后隐藏控件和指针，录屏时画面只留封面与歌词。
  const lastActive = useRef(0);
  const wake = () => { lastActive.current = performance.now(); if (idle) setIdle(false); };
  useEffect(() => {
    if (!playing) return;
    lastActive.current = performance.now();
    const timer = setInterval(() => { if (performance.now() - lastActive.current > 2500) setIdle(true); }, 500);
    return () => clearInterval(timer);
  }, [playing]);
  useEffect(() => {
    const change = () => setFullscreen(document.fullscreenElement === stage.current);
    document.addEventListener('fullscreenchange', change);
    return () => document.removeEventListener('fullscreenchange', change);
  }, []);
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void stage.current?.requestFullscreen().catch(() => undefined);
  };
  const progress = duration ? time / duration * 100 : 0;
  return <Dialog className="now-playing-dialog" isOpen variant="fullscreen" padding={0} aria-label={t('@yovoice.music.nowPlayingTitle', { title })} onOpenChange={open => { if (!open) close(); }}>
    <VStack ref={stage} className="now-playing" data-playing={playing} data-idle={idle} gap={0}
      style={{ '--now-playing-hue': hue, '--now-playing-accent': accent } as CSSProperties}
      onPointerMove={wake} onPointerDown={wake}
      onKeyDown={event => { wake(); if (event.key === ' ' && !(event.target instanceof HTMLButtonElement || event.target instanceof HTMLInputElement)) { event.preventDefault(); toggle(); } }}>
      <audio hidden ref={audio} src={url || undefined} autoPlay
        onLoadedMetadata={() => { const value = audio.current?.duration; if (value && Number.isFinite(value)) setDuration(value); }}
        onTimeUpdate={() => setTime(audio.current?.currentTime ?? 0)}
        onPlay={() => setPlaying(true)} onPause={() => { setPlaying(false); setIdle(false); }} onEnded={() => setPlaying(false)} />
      <HStack className="now-playing-bar now-playing-chrome" gap={2} hAlign="end" vAlign="center">
        {document.fullscreenEnabled ? <Button label={t(fullscreen ? '@yovoice.music.exitFullscreen' : '@yovoice.music.fullscreen')} tooltip={t(fullscreen ? '@yovoice.music.exitFullscreen' : '@yovoice.music.fullscreen')} isIconOnly variant="ghost" icon={fullscreen ? <Minimize /> : <Maximize />} onClick={toggleFullscreen} /> : null}
        <Button label={t('@yovoice.music.closeNowPlaying')} tooltip={t('@yovoice.music.closeNowPlaying')} isIconOnly variant="ghost" icon={<X />} onClick={close} />
      </HStack>
      <HStack className={`now-playing-stage ${lines.length ? '' : 'now-playing-solo'}`.trim()} gap={0} vAlign="center">
        <VStack className="now-playing-side" gap={6}>
          <VStack className="now-playing-art" gap={0}><SongCover seed={item.id} animated={playing} size={640} /></VStack>
          <VStack className="now-playing-meta" gap={1}>
            <h2 className="now-playing-title">{title}</h2>
            <p className="now-playing-tags">{item.settings.instrumental ? t('@yovoice.music.instrumental') : tags.join(' · ')}</p>
          </VStack>
          <VStack className="now-playing-controls now-playing-chrome" gap={3}>
            <input className="now-playing-progress" aria-label={t('@yovoice.player.progress')} aria-valuetext={t('@yovoice.player.progressValue', { current: formatTime(time), total: formatTime(duration) })} type="range" min={0} max={duration || 1} step={0.01} value={time} disabled={!url} onChange={event => seek(Number(event.target.value))} style={{ '--now-playing-progress': `${progress}%` } as CSSProperties} />
            <HStack className="now-playing-times" hAlign="between"><small>{formatTime(time)}</small><small>-{formatTime(Math.max(0, duration - time))}</small></HStack>
            <HStack gap={4} hAlign="center" vAlign="center">
              <Button label={t('@yovoice.player.skipStart')} isIconOnly variant="ghost" icon={<SkipBack />} isDisabled={!url} onClick={() => seek(0)} />
              <Button className="now-playing-toggle" label={playing ? t('@yovoice.player.pause') : t('@yovoice.player.play')} isIconOnly variant="ghost" icon={playing ? <Pause fill="currentColor" /> : <Play fill="currentColor" />} isDisabled={!url} onClick={toggle} />
            </HStack>
          </VStack>
        </VStack>
        {lines.length ? <VStack ref={lyricsBox} className="now-playing-lyrics" gap={0} role="list" aria-label={t('@yovoice.music.lyrics')}>
          {lines.map((line, index) => <p key={index} role="listitem" data-index={index} className="now-playing-line" data-state={index === current ? 'current' : index < current ? 'past' : 'next'} data-instrumental={line.instrumental || undefined}
            title={line.instrumental ? undefined : t('@yovoice.music.seekLyric')} onClick={() => { seek(line.start); if (audio.current?.paused) toggle(); }}>
            {line.instrumental ? '• • •' : line.text}
          </p>)}
        </VStack> : null}
      </HStack>
      {lines.length ? <small className="now-playing-note now-playing-chrome">{t('@yovoice.music.lyricsEstimated')}</small> : null}
    </VStack>
  </Dialog>;
}
