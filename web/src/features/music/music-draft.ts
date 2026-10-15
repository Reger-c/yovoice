import { createDraft, type Draft, type UiLocale } from '../../shared/workbench';

export const musicModelId = 'ace-step-1.5-turbo-bf16';

// 风格标签按“流派、情绪、乐器、人声”分组，值直接写入风格描述，ACE-Step 对中英文描述都能理解。
export const styleTags = {
  genre: ['pop', 'city pop', 'lo-fi', 'folk', 'rock', 'electronic', 'R&B', 'jazz', 'hip hop', 'chinese traditional'],
  mood: ['upbeat', 'chill', 'dreamy', 'melancholic', 'epic', 'romantic'],
  instrument: ['warm synths', 'acoustic guitar', 'piano', 'strings', '808 bass', 'guzheng'],
  vocal: ['female vocals', 'male vocals', 'choir', 'rap'],
} as const;

export interface StylePreset {
  id: string;
  name: Record<UiLocale, string>;
  tags: string[];
}

// 风格预设：一键注入成熟好听的风格搭配，纯文字无 emoji。
export const stylePresets: readonly StylePreset[] = [
  { id: 'city-pop', name: { 'zh-CN': 'City Pop', en: 'City Pop' }, tags: ['city pop', 'warm synths', 'chill', 'female vocals'] },
  { id: 'lofi', name: { 'zh-CN': 'Lo-Fi', en: 'Lo-Fi' }, tags: ['lo-fi', 'chill', 'warm synths', 'acoustic guitar'] },
  { id: 'folk', name: { 'zh-CN': '民谣', en: 'Folk' }, tags: ['folk', 'acoustic guitar', 'chill'] },
  { id: 'electronic', name: { 'zh-CN': '电子', en: 'Electronic' }, tags: ['pop', 'electronic', 'upbeat', '808 bass'] },
  { id: 'chinese', name: { 'zh-CN': '国风', en: 'Chinese' }, tags: ['chinese traditional', 'guzheng', 'strings', 'dreamy'] },
  { id: 'romantic', name: { 'zh-CN': '抒情', en: 'Romantic' }, tags: ['pop', 'romantic', 'piano', 'strings'] },
  { id: 'hiphop', name: { 'zh-CN': '说唱', en: 'Hip Hop' }, tags: ['hip hop', '808 bass', 'rap', 'upbeat'] },
  { id: 'rock', name: { 'zh-CN': '摇滚', en: 'Rock' }, tags: ['rock', 'epic', 'male vocals'] },
] as const;

export const splitTags = (style: string) => style.split(/[,，]/).map(tag => tag.trim()).filter(Boolean);

export const isPresetActive = (preset: StylePreset, currentTags: readonly string[]) =>
  preset.tags.length > 0 && preset.tags.every(t => currentTags.includes(t));

export const applyPresetTags = (preset: StylePreset, currentTags: readonly string[]) => {
  if (isPresetActive(preset, currentTags)) {
    return currentTags.filter(t => !preset.tags.includes(t));
  }
  const allPresetTags = new Set(stylePresets.flatMap(p => p.tags));
  const customTags = currentTags.filter(t => !allPresetTags.has(t));
  return [...preset.tags, ...customTags];
};

// 标签中文辅助释义，降低理解门槛。
export const tagTooltips: Record<string, Record<UiLocale, string>> = {
  'pop': { 'zh-CN': '流行乐 · 朗朗上口', en: 'Pop music' },
  'city pop': { 'zh-CN': '城市流行 · 80年代复古都市浪漫', en: '80s Japanese urban pop' },
  'lo-fi': { 'zh-CN': '低保真慢调 · 慵懒惬意氛围', en: 'Relaxed low fidelity beats' },
  'folk': { 'zh-CN': '民谣 · 质朴温暖人文感', en: 'Acoustic folk storytelling' },
  'rock': { 'zh-CN': '摇滚 · 热血激情与吉他底色', en: 'High energy rock sound' },
  'electronic': { 'zh-CN': '电子舞曲 · 现代合成律动', en: 'Modern electronic beats' },
  'R&B': { 'zh-CN': '节奏布鲁斯 · 丝滑律动与转音', en: 'Smooth rhythm and blues' },
  'jazz': { 'zh-CN': '爵士 · 优雅摇摆与和弦色彩', en: 'Classic jazz chords' },
  'hip hop': { 'zh-CN': '嘻哈说唱 · 强节奏重鼓点', en: 'Booming beats and flow' },
  'chinese traditional': { 'zh-CN': '国风传统 · 五声音阶与民乐韵味', en: 'Traditional Chinese melodies' },
  'upbeat': { 'zh-CN': '欢快动感 · 充满活力', en: 'Bright and energetic mood' },
  'chill': { 'zh-CN': '轻松惬意 · 减压治愈', en: 'Calm and relaxing vibe' },
  'dreamy': { 'zh-CN': '梦幻空灵 · 朦胧漂浮感', en: 'Ethereal atmosphere' },
  'melancholic': { 'zh-CN': '感伤忧郁 · 触动心弦', en: 'Bittersweet nostalgia' },
  'epic': { 'zh-CN': '宏大史诗 · 磅礴震撼', en: 'Cinematic grand scale' },
  'romantic': { 'zh-CN': '浪漫温柔 · 细腻深情', en: 'Sweet and loving tone' },
  'warm synths': { 'zh-CN': '温暖合成器音色', en: 'Warm analog synthesizer' },
  'acoustic guitar': { 'zh-CN': '原声木吉他扫弦/分解', en: 'Acoustic guitar strums' },
  'piano': { 'zh-CN': '纯净钢琴琴键音色', en: 'Expressive acoustic piano' },
  'strings': { 'zh-CN': '交响弦乐群铺底/主奏', en: 'Orchestral string section' },
  '808 bass': { 'zh-CN': '808 低音重炮下潜', en: 'Heavy sub bass tone' },
  'guzheng': { 'zh-CN': '中国传统乐器古筝弹奏', en: 'Traditional Guzheng plucks' },
  'female vocals': { 'zh-CN': '清晰自然的女声音色', en: 'Clear female vocal style' },
  'male vocals': { 'zh-CN': '沉稳醇厚的男声音色', en: 'Deep male vocal style' },
  'choir': { 'zh-CN': '多声部合唱与和声铺底', en: 'Multi-part choir harmony' },
  'rap': { 'zh-CN': '快节奏说唱念白节奏', en: 'Fast rhythmic rap delivery' },
};

export const lyricSections = ['intro', 'verse', 'pre-chorus', 'chorus', 'bridge', 'outro'] as const;

// 常用演唱语言放在前面，完整列表与 Go 的 schema.MusicLanguages 一致。
export const musicLanguages = ['zh', 'en', 'yue', 'ja', 'ko', 'es', 'fr', 'de', 'pt', 'ru', 'it'] as const;

export const durationPresets = [0, 30, 60, 120, 180] as const;

const copy: Record<UiLocale, { title: string; style: string; lyrics: string; language: string }> = {
  'zh-CN': {
    title: '夏夜便利店',
    style: 'city pop, warm synths, chill, female vocals',
    lyrics: '[verse]\n晚风把招牌吹得一闪一闪\n冰柜里的汽水排成一行\n你说再等十分钟就打烊\n我们把整个夏天都买光\n\n[chorus]\n二十四小时的光 不睡的城\n收银台的叮咚像心跳的声\n如果今晚可以不说再见\n就在这里 一直等',
    language: 'zh',
  },
  en: {
    title: 'Corner Store Summer',
    style: 'city pop, warm synths, chill, female vocals',
    lyrics: '[verse]\nNeon flickers in the evening breeze\nSoda cans lined up in the freezer\nTen more minutes till they close the doors\nWe could buy the whole summer and more\n\n[chorus]\nTwenty-four hour light, a city awake\nEvery register chime like a heartbeat we make\nIf tonight we never say goodbye\nWe will wait here, you and I',
    language: 'en',
  },
};

export function createMusicDraft(locale: UiLocale, example = true): Draft {
  const text = copy[locale];
  return {
    ...createDraft(false, locale, musicModelId), kind: 'music',
    title: example ? text.title : createDraft(false, locale).title,
    text: example ? text.style : '', lyrics: example ? text.lyrics : '', instrumental: false, synthesisLanguage: text.language,
    modelOptions: { ace_step: { duration_seconds: 60 } },
  };
}
