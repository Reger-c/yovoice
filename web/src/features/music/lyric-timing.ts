// 播放页的歌词时间轴。生成模型不返回逐句时间，这里按每句的音节数在整首时长里按比例分配；
// 没有歌词的段落（如 [intro]、[instrumental]）当作器乐间隔，显示为省略号。
export interface LyricLine { text: string; start: number; end: number; instrumental?: boolean }

// 估算一句的音节数：中日韩文字每字一拍，拉丁文按元音组计，其余符号不计。
function syllables(line: string) {
  const cjk = line.match(/[぀-ヿ㐀-鿿가-힯]/g)?.length ?? 0;
  const latin = (line.match(/[\p{Script=Latin}']+/gu) ?? []).reduce((sum, word) => sum + Math.max(1, word.match(/[aeiouyàâäéèêëîïôöùûü]+/gi)?.length ?? 0), 0);
  return cjk + latin;
}

// 权重单位：每句至少 3 拍外加 1.5 拍换气；器乐段落 12 拍，段落之间 2 拍。
const instrumentalWeight = 12, sectionGap = 2, leadIn = 6, tail = 6;

export function lyricTimeline(lyrics: string, duration: number): LyricLine[] {
  const items: { text: string; weight: number; instrumental?: boolean }[] = [];
  let sectionLines = 0, sectionOpen = false;
  const closeSection = () => { if (sectionOpen && sectionLines === 0) items.push({ text: '', weight: instrumentalWeight, instrumental: true }); sectionOpen = false; sectionLines = 0; };
  for (const raw of lyrics.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (/^\[[^\]]*\]$/.test(line)) {
      closeSection();
      if (items.length) items.push({ text: '', weight: sectionGap });
      sectionOpen = true;
      continue;
    }
    sectionLines++;
    items.push({ text: line, weight: Math.max(3, syllables(line)) + 1.5 });
  }
  closeSection();
  if (!items.some(item => item.text) || !(duration > 0)) return [];
  // 歌曲通常有前奏和尾奏：开头不是器乐段落时补一段前奏，结尾同理补尾奏。
  if (!items[0].instrumental) items.unshift({ text: '', weight: leadIn, instrumental: true });
  if (!items[items.length - 1].instrumental) items.push({ text: '', weight: tail });
  const unit = duration / items.reduce((sum, item) => sum + item.weight, 0);
  const lines: LyricLine[] = [];
  let at = 0;
  for (const item of items) {
    const start = at; at += item.weight * unit;
    // 段落间隔并入上一句；器乐间隔单独占一行。
    if (item.text || item.instrumental) lines.push({ text: item.text, start, end: at, ...(item.instrumental ? { instrumental: true } : {}) });
    else if (lines.length) lines[lines.length - 1].end = at;
  }
  return lines;
}

// 当前时间所在的行：最后一个已开始的行。
export const activeLyric = (lines: LyricLine[], time: number) => {
  let index = -1;
  for (let i = 0; i < lines.length && lines[i].start <= time; i++) index = i;
  return index;
};
