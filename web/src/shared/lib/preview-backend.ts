import catalog from './catalog.json';
import aiPresets from './ai-presets.json';
import { performanceSettings, emptyState, type AudioAsset, type Draft, type State, type Voice, type Preferences, type Character, type SynthesisSettings, type AIProvider, type AITask, type LocalAPIStatus, aiTimeoutDefault } from '../workbench';
import { encodeWav } from './sound';
import { CallError } from './call-error';

// 浏览器预览的本地后端：只保存编辑和音频数据，不模拟桌面推理或模型安装。
// 作品状态存于 localStorage（主副本加恢复备份），音频存于 IndexedDB。
const primaryKey = 'voice-workbench-v1';
const backupKey = 'voice-workbench-backup';
const maxUploadBytes = 20 * 1024 * 1024;

// 预览不监听端口：本机接口只记录开关与端口，用于演示设置页。
let localApi: LocalAPIStatus = { enabled: false, port: 8080, token: 'preview'.padEnd(64, '0'), running: false };
let mockPendingPath = '';

const listeners = new Set<(state: State) => void>();
let stored: State | undefined;

function load(): State {
  let state = emptyState();
  for (const key of [primaryKey, backupKey]) {
    try {
      const value = JSON.parse(localStorage.getItem(key) ?? 'null');
      if (!value || !Array.isArray(value.drafts) || !Array.isArray(value.history) || !Array.isArray(value.voices)) continue;
      state = value; break;
    } catch { /* 主副本损坏时继续读取恢复备份。 */ }
  }
  state.characters ??= []; state.previews = []; delete state.aiTask;
  if (!['zh-CN', 'en'].includes(state.preferences?.uiLocale)) {
    state = { ...state, preferences: { ...state.preferences, uiLocale: 'zh-CN' } };
  }
  return state;
}

// 首次使用时才读取本地存储，桌面端不会触碰预览数据。
const preview = () => stored ??= load();

function publish() {
  const previous = localStorage.getItem(primaryKey);
  if (previous) { try { JSON.parse(previous); localStorage.setItem(backupKey, previous); } catch { /* 损坏的主副本不覆盖恢复备份。 */ } }
  localStorage.setItem(primaryKey, JSON.stringify(preview()));
  listeners.forEach(fn => fn(structuredClone(preview())));
}

export function subscribePreview(listener: (state: State) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }

export async function previewCall<T>(method: string, data: unknown): Promise<T> {
  const state = preview();
  if (method === 'state.get') return { state, catalog, engine: { version: '', minimum: '' }, desktop: false } as T;
  if (method === 'character.save') {
    const character = structuredClone(data as Character);
    if (!character.name.trim() || character.name.length > 120 || character.demoText.length > 2000) throw new CallError('@yovoice.error.characterInvalid');
    if ([character.settings.voiceId, character.settings.emotionVoiceId].some(id => id && !state.voices.some(v => v.id === id))) throw new CallError('@yovoice.error.voiceRequired');
    if ((character.performances?.length ?? 0) > 32 || character.performances?.some((p, i, all) => !/^[a-f0-9]{32}$/i.test(p.id) || !p.name.trim() || p.name.trim().length > 120 || all.some((v, j) => j !== i && (p.id === v.id || p.name.trim().toLowerCase() === v.name.trim().toLowerCase())))) throw new CallError('@yovoice.error.characterInvalid');
    character.performances = character.performances?.map(p => ({ ...p, name: p.name.trim(), settings: performanceSettings(character.settings, p) }));
    if (character.performances?.some(p => [p.settings.voiceId, p.settings.emotionVoiceId].some(id => id && !state.voices.some(v => v.id === id)))) throw new CallError('@yovoice.error.voiceRequired');
    const index = state.characters.findIndex(c => c.id === character.id);
    character.name = character.name.trim(); character.createdAt = index < 0 ? new Date().toISOString() : state.characters[index].createdAt;
    character.updatedAt = new Date().toISOString();
    if (index < 0) state.characters.push(character); else state.characters[index] = character;
    publish(); return character as T;
  }
  if (method === 'character.delete') { state.characters = state.characters.filter(c => c.id !== (data as { id: string }).id); publish(); return true as T; }
  if (method === 'character.discardPreview') return true as T;
  if (method === 'voice.update' || method === 'voice.fromGeneration') {
    const input = data as { id: string; name: string; referenceText: string };
    if (!input.name.trim() || input.name.length > 100 || input.referenceText.length > 2000) throw new CallError('@yovoice.error.characterInvalid');
    if (method === 'voice.update') {
      const voice = state.voices.find(v => v.id === input.id);
      if (!voice) throw new CallError('@yovoice.error.audioMissing');
      voice.name = input.name.trim(); voice.referenceText = input.referenceText;
      publish(); return voice as T;
    }
    const generation = state.history.find(g => g.id === input.id);
    if (!generation) throw new CallError('@yovoice.error.audioMissing');
    const blob = await blobStore(generation.fileName);
    if (!blob) throw new CallError('@yovoice.error.audioBlobMissing');
    const voice = await previewImportVoice(new File([blob], input.name.trim() + '.wav'));
    Object.assign(voice, { referenceText: input.referenceText, source: 'generation', sourceGenerationId: input.id });
    publish(); return voice as T;
  }
  if (method === 'draft.save') {
    const draft = structuredClone(data as Draft); const index = state.drafts.findIndex(d => d.id === draft.id);
    draft.createdAt = index < 0 ? new Date().toISOString() : state.drafts[index]?.createdAt;
    draft.updatedAt = state.drafts[index]?.updatedAt;
    if (index < 0 || JSON.stringify(draft) !== JSON.stringify(state.drafts[index])) draft.updatedAt = new Date().toISOString();
    if (index < 0) state.drafts.unshift(draft); else state.drafts[index] = draft;
    publish(); return true as T;
  }
  if (method === 'media.rename' || method === 'media.delete') {
    const { kind, id, name } = data as { kind: string; id: string; name: string };
    if (!['voices', 'outputs'].includes(kind)) throw new CallError('@yovoice.error.audioKindInvalid');
    if (method === 'media.rename') {
      if (!name?.trim() || name.trim().length > 120) throw new CallError('@yovoice.error.nameLength');
      if (kind === 'voices') state.voices = state.voices.map(v => v.id === id ? { ...v, name: name.trim() } : v);
      else state.history = state.history.map(v => v.id === id ? { ...v, title: name.trim() } : v);
    } else {
      const item = kind === 'voices' ? state.voices.find(v => v.id === id) : state.history.find(v => v.id === id);
      if (kind === 'outputs' && state.drafts.some(d => d.timeline?.tracks.some(t => t.clips.some(c => c.generationId === id)))) throw new CallError('@yovoice.timeline.inUse');
      if (kind === 'voices') {
        const uses = (s: SynthesisSettings) => s.voiceId === id || s.emotionVoiceId === id;
        // 与服务端一致：所有说话人都有独立设置时，作品级设置与演绎快照不可见，不阻止删除，删除时一并清理。
        const baseHidden = (d: Draft) => !!d.subtitles?.speakers.length && d.subtitles.speakers.every(s => s.settings);
        const draftUses = (d: Draft) => (!baseHidden(d) && (uses(d) || (d.performance && uses(d.performance.settings)))) || d.subtitles?.speakers.some(s => s.settings && uses(s.settings)) || d.subtitles?.cues.some(c => c.performance && uses(c.performance.settings));
        const names = [...state.characters.filter(c => uses(c.settings) || c.performances?.some(p => uses(p.settings)) || (c.preview && uses(c.preview.settings))).map(c => c.name), ...state.drafts.filter(draftUses).map(d => d.title)];
        if (names.length) throw new CallError('@yovoice.error.voiceReferenced', { names: names.join(', ') });
        state.voices = state.voices.filter(v => v.id !== id);
        const clear = <T extends SynthesisSettings>(s: T): T => ({ ...s, voiceId: s.voiceId === id ? null : s.voiceId, emotionVoiceId: s.emotionVoiceId === id ? null : s.emotionVoiceId });
        state.drafts = state.drafts.map(d => ({ ...clear(d), performance: d.performance && { ...d.performance, settings: clear(d.performance.settings) } }));
        state.history = state.history.map(g => ({ ...g, settings: { ...g.settings, voiceId: g.settings.voiceId === id ? null : g.settings.voiceId, emotionVoiceId: g.settings.emotionVoiceId === id ? null : g.settings.emotionVoiceId } }));
      } else state.history = state.history.filter(v => v.id !== id);
      if (item && ![...state.voices, ...state.history].some(v => v.fileName === item.fileName)) await blobDelete(item.fileName);
    }
    publish(); return true as T;
  }
  if (method === 'draft.delete') {
    const id = (data as { id: string }).id;
    if (state.activity?.status === 'running' && state.activity.projectId === id) throw new CallError('@yovoice.error.busy');
    const otherDrafts = state.drafts.filter(d => d.id !== id);
    const referencedGenIds = new Set<string>();
    const referencedAssetIds = new Set<string>();
    for (const d of otherDrafts) {
      for (const track of d.timeline?.tracks ?? []) {
        for (const clip of track.clips) {
          if (clip.generationId) referencedGenIds.add(clip.generationId);
          if (clip.assetId) referencedAssetIds.add(clip.assetId);
        }
      }
    }
    const targetDraft = state.drafts.find(d => d.id === id);
    for (const asset of targetDraft?.timeline?.assets ?? []) {
      if (!referencedAssetIds.has(asset.id)) {
        await blobDelete(asset.fileName);
      }
    }
    const removedGens = state.history.filter(g => g.settings.id === id && !referencedGenIds.has(g.id));
    for (const gen of removedGens) {
      if (![...state.voices, ...state.history.filter(g => !removedGens.includes(g))].some(v => v.fileName === gen.fileName)) {
        await blobDelete(gen.fileName);
      }
    }
    state.history = state.history.filter(g => !removedGens.includes(g));
    state.drafts = otherDrafts;
    publish();
    return true as T;
  }
  if (method === 'storage.info') {
    return {
      root: mockPendingPath || '/Users/preview/.yovoice',
      modelsBytes: 1024 * 1024 * 350,
      outputsBytes: 1024 * 1024 * 15,
      voicesBytes: 1024 * 1024 * 5,
      downloadsBytes: 1024 * 1024 * 80,
      totalBytes: 1024 * 1024 * 450,
      pendingPath: mockPendingPath || undefined,
    } as T;
  }
  if (method === 'storage.directory') {
    mockPendingPath = '/Volumes/Data/yovoice-data';
    return true as T;
  }
  if (method === 'storage.directory.open') return true as T;
  if (method === 'storage.relocate') {
    mockPendingPath = (data as { path: string }).path;
    return true as T;
  }
  if (method === 'storage.cleanup') {
    return { cleanedCount: 0, freedBytes: 0 } as T;
  }
  if (method === 'localApi.get' || method === 'localApi.save' || method === 'localApi.resetToken') {
    if (method === 'localApi.save') {
      const { enabled, port } = data as { enabled: boolean; port: number };
      if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new CallError('@yovoice.error.localApiPort');
      localApi = { ...localApi, enabled, port };
    }
    if (method === 'localApi.resetToken') localApi = { ...localApi, token: crypto.randomUUID().replaceAll('-', '').repeat(2) };
    localApi = { ...localApi, running: localApi.enabled, url: localApi.enabled ? `http://127.0.0.1:${localApi.port}` : undefined };
    return structuredClone(localApi) as T;
  }
  if (method === 'preferences.save') { state.preferences = data as Preferences; publish(); return true as T; }
  if (method === 'voice.record') {
    const recording = data as { base64: string; name: string };
    const bytes = Uint8Array.from(atob(recording.base64), c => c.charCodeAt(0));
    return await previewImportVoice(new File([bytes], `${recording.name}.wav`, { type: 'audio/wav' })) as T;
  }
  // AI 服务配置可在预览中编辑（不保存密钥），实际调用模型只在桌面端进行。
  if (method === 'ai.provider.save') {
    const input = data as AIProvider & { key?: string | null };
    const preset = aiPresets.find(p => p.key === input.preset);
    if (!preset) throw new CallError('@yovoice.error.aiProviderInvalid');
    const editable = preset.endpoint !== 'fixed';
    const next: AIProvider = { id: input.id || crypto.randomUUID().replaceAll('-', ''), preset: preset.key, name: input.name?.trim() || preset.name, format: preset.endpoint === 'custom' ? input.format : preset.format, baseURL: editable ? input.baseURL.trim() : preset.baseURL, modelsPath: preset.endpoint === 'custom' ? input.modelsPath : preset.modelsPath, model: input.model?.trim() ?? '' };
    if (!/^https?:\/\/[^/]+/.test(next.baseURL)) throw new CallError('@yovoice.error.aiProviderInvalid');
    const providers = state.aiProviders ?? [];
    const old = providers.find(p => p.id === next.id);
    next.keyMask = input.key == null ? old?.keyMask : input.key.trim() ? '••••••••' : undefined;
    next.models = old?.models;
    state.aiProviders = old ? providers.map(p => p.id === next.id ? next : p) : [...providers, next];
    state.aiProviderID ||= next.id;
    publish(); return next as T;
  }
  if (method === 'ai.provider.delete' || method === 'ai.provider.use') {
    const id = (data as { id: string }).id;
    if (method === 'ai.provider.delete') {
      state.aiProviders = (state.aiProviders ?? []).filter(p => p.id !== id);
      if (state.aiProviderID === id) state.aiProviderID = state.aiProviders[0]?.id ?? '';
    } else {
      // 写作栏切换模型时同时改服务的当前模型。
      const model = (data as { model?: string }).model?.trim();
      state.aiProviderID = id;
      if (model) state.aiProviders = (state.aiProviders ?? []).map(p => p.id === id ? { ...p, model } : p);
    }
    publish(); return true as T;
  }
  // 预览模拟 OrcaRouter 一键授权：不打开外部页面，稍后直接添加使用免费模型的服务并设为当前服务。
  if (method === 'ai.connect') {
    setTimeout(() => {
      const providers = state.aiProviders ?? [];
      const old = providers.find(p => p.preset === 'orcarouter');
      const next: AIProvider = { id: old?.id ?? crypto.randomUUID().replaceAll('-', ''), preset: 'orcarouter', name: old?.name ?? 'OrcaRouter', format: 'chat_completions', baseURL: 'https://api.orcarouter.ai/v1', modelsPath: '/models', model: old?.model || 'orcarouter/free', models: old?.models, keyMask: '••••••••' };
      state.aiProviders = old ? providers.map(p => p.id === next.id ? next : p) : [...providers, next];
      state.aiProviderID = next.id; publish();
    }, 300);
    return { url: '' } as T;
  }
  // 预览模拟 AI 后台任务的生命周期：开始后短暂运行，再以“仅桌面可用”结束，便于检查界面闭环。
  if (method === 'ai.score' || method === 'ai.lyrics') {
    const input = data as { projectId: string; brief: string };
    const provider = state.aiProviders?.find(p => p.id === state.aiProviderID);
    if (!provider?.model) throw new CallError('@yovoice.error.aiNotConfigured');
    if (state.aiTask?.status === 'running') throw new CallError('@yovoice.error.busy');
    const task: AITask = { id: crypto.randomUUID().replaceAll('-', ''), kind: method === 'ai.score' ? 'score' : 'lyrics', projectId: input.projectId, brief: input.brief, status: 'running', stage: 'writing', provider: provider.name, model: provider.model, timeout: state.preferences.aiTimeout || aiTimeoutDefault, startedAt: new Date().toISOString() };
    state.aiTask = task; publish();
    setTimeout(() => {
      if (state.aiTask?.id !== task.id || state.aiTask.status !== 'running') return;
      state.aiTask = { ...state.aiTask, status: 'failed', finishedAt: new Date().toISOString(), errorCode: '@yovoice.error.previewDesktopOnly' }; publish();
    }, 1500);
    return task as T;
  }
  if (method === 'ai.cancel') {
    if (state.aiTask?.status === 'running') { state.aiTask = { ...state.aiTask, status: 'cancelled', finishedAt: new Date().toISOString() }; publish(); }
    return true as T;
  }
  if (method === 'ai.dismiss') {
    if (state.aiTask?.id === (data as { id: string }).id && state.aiTask.status !== 'running') { delete state.aiTask; publish(); }
    return true as T;
  }
  throw new CallError('@yovoice.error.previewDesktopOnly');
}

export function assertUploadSize(file: Blob) {
  if (file.size > maxUploadBytes) throw new CallError('@yovoice.error.audioTooLarge');
}

export async function previewImportTimeline(file: File, name: string): Promise<AudioAsset> {
  assertUploadSize(file);
  const context = new AudioContext();
  try {
    const buffer = await context.decodeAudioData(await file.arrayBuffer());
    if (buffer.duration < 0.01 || buffer.duration > 3600) throw new CallError('@yovoice.timeline.importDuration');
    const id = crypto.randomUUID().replaceAll('-', '');
    const asset = { id, name, fileName: `import-${id}.wav`, duration: buffer.duration };
    await blobStore(asset.fileName, encodeWav(buffer));
    return asset;
  } finally { await context.close(); }
}

export async function previewImportVoice(file: File): Promise<Voice> {
  assertUploadSize(file);
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(await file.arrayBuffer());
    if (decoded.duration < 1 || decoded.duration > 60) throw new CallError('@yovoice.error.audioDuration');
    const wav = encodeWav(decoded);
    const id = crypto.randomUUID().replaceAll('-', '');
    const voice = { id, name: file.name.replace(/\.[^.]+$/, ''), fileName: id + '.wav', duration: decoded.duration };
    await blobStore(voice.fileName, wav); preview().voices.push(voice); publish(); return voice;
  } finally { await context.close(); }
}

export async function previewMediaUrl(file: string): Promise<string> {
  const blob = await blobStore(file); if (!blob) throw new CallError('@yovoice.error.audioBlobMissing'); return URL.createObjectURL(blob);
}

function database(): Promise<IDBDatabase> { return new Promise((resolve, reject) => {
  const request = indexedDB.open('voice-workbench-audio', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('audio');
  request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
}); }

async function blobStore(key: string, value?: Blob): Promise<Blob | undefined> {
  const db = await database();
  try { return await new Promise((resolve, reject) => {
    const transaction = db.transaction('audio', value ? 'readwrite' : 'readonly');
    const request = value ? transaction.objectStore('audio').put(value, key) : transaction.objectStore('audio').get(key);
    transaction.oncomplete = () => resolve(value ?? request.result); transaction.onerror = () => reject(transaction.error);
  }); } finally { db.close(); }
}

async function blobDelete(key: string): Promise<void> {
  const db = await database();
  try { await new Promise<void>((resolve, reject) => { const tx = db.transaction('audio', 'readwrite'); tx.objectStore('audio').delete(key); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); }); } finally { db.close(); }
}
