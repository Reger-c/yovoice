import { useEffect, useRef } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { HStack, VStack } from '@astryxdesign/core/Layout';
import { useTranslator } from '@astryxdesign/core/i18n';
import { CircleCheck, CircleDashed, LoaderCircle } from 'lucide-react';
import { call } from '../../shared/lib/client';
import { formatSize, modelEngineReady, projectKind, requiresVoice, runtimeStatus, runtimeUsable, type Draft, type EngineInfo, type ModelPackage, type State } from '../../shared/workbench';

export type SetupStep = { id: 'model' | 'engine' | 'voice'; done: boolean; model?: ModelPackage; modelId: string };

// 生成前需要具备的条件：模型（编曲是音色库）、推理引擎（编曲不需要）、需要克隆的模型还要选好参考音频。
// 故事作品按说话人检查，取第一个还没下载的模型。
export function setupSteps(draft: Draft, state: State, catalog: ModelPackage[], engine: EngineInfo): SetupStep[] {
  const kind = projectKind(draft);
  const installed = (id: string) => state.models.some(model => model.id === id);
  const modelId = draft.subtitles?.speakers.map(speaker => speaker.settings?.modelId ?? draft.modelId).find(id => !installed(id)) ?? draft.modelId;
  const model = catalog.find(item => item.id === modelId);
  const steps: SetupStep[] = [{ id: 'model', done: installed(modelId), model, modelId }];
  if (kind !== 'score') steps.push({ id: 'engine', done: runtimeUsable(runtimeStatus(state, engine)) && modelEngineReady(state, model), model, modelId });
  if (kind === 'text' && requiresVoice(draft)) steps.push({ id: 'voice', done: state.voices.some(voice => voice.id === draft.voiceId), modelId });
  return steps;
}

// 创作区顶部的准备清单：缺什么就地补什么，不再在点击生成时跳转；全部完成后自动收起。
export function SetupChecklist({ steps, state, attention, chooseVoice, chooseModel, run }: {
  steps: SetupStep[]; state: State; attention: number;
  chooseVoice: () => void; chooseModel: (modelId: string) => void; run: (task: () => Promise<unknown>) => void;
}) {
  const t = useTranslator();
  const card = useRef<HTMLDivElement>(null);
  const left = steps.filter(step => !step.done).length;
  // 点击生成但还没准备好时，滚到清单并闪一下提示，代替跳转到设置页。
  useEffect(() => {
    const element = card.current;
    if (!attention || !element) return;
    element.scrollIntoView({ block: 'nearest' });
    element.dataset.attention = 'true';
    const timer = setTimeout(() => { delete element.dataset.attention; }, 1200);
    return () => clearTimeout(timer);
  }, [attention]);
  if (!left) return null;
  const busy = state.activity?.status === 'running';
  const modelBusy = state.modelActivity?.status === 'running';
  const row = (step: SetupStep, index: number) => {
    const soundfont = step.model?.family === 'soundfont';
    const download = state.modelActivity?.kind === 'download' && state.modelActivity.modelId === step.modelId && state.modelActivity.status === 'running' ? state.modelActivity : null;
    const installing = state.activity?.kind === 'runtime' && state.activity.status === 'running';
    const outdated = !!state.runtimePath && step.id === 'engine';
    const label = step.id === 'model' ? t(soundfont ? '@yovoice.setup.soundfont' : '@yovoice.setup.model') : step.id === 'engine' ? t('@yovoice.setup.engine') : t('@yovoice.setup.voice');
    const detail = step.done ? t('@yovoice.setup.done')
      : step.id === 'model' ? (download ? t('@yovoice.setup.downloading', { received: formatSize(download.received), total: formatSize(step.model?.size ?? download.total) }) : step.model ? `${step.model.name} ${step.model.precision} · ${formatSize(step.model.size)}` : step.modelId)
        : step.id === 'engine' ? (installing ? t('@yovoice.setup.installing') : t(outdated ? '@yovoice.setup.engineUpdate' : '@yovoice.setup.engineDetail'))
          : t('@yovoice.setup.voiceDetail');
    const action = step.done ? null
      : step.id === 'model' ? (download ? null : <>
        <Button size="sm" variant="primary" label={t('@yovoice.setup.download')} isDisabled={modelBusy} onClick={() => run(() => call('model.download', { id: step.modelId }))} />
        <Button size="sm" variant="ghost" label={t('@yovoice.setup.otherModel')} onClick={() => chooseModel(step.modelId)} />
      </>)
        : step.id === 'engine' ? (installing ? null : <Button size="sm" variant="primary" label={t(outdated ? '@yovoice.setup.update' : '@yovoice.setup.install')} isDisabled={busy} onClick={() => run(() => call('runtime.install'))} />)
          : <Button size="sm" variant="primary" label={t('@yovoice.setup.chooseVoice')} onClick={chooseVoice} />;
    return <HStack key={step.id} className="setup-step grow" data-done={step.done} gap={3} vAlign="start" role="listitem" aria-label={label}>
      {step.done ? <CircleCheck className="setup-step-icon" size={18} aria-hidden /> : download || (step.id === 'engine' && installing) ? <LoaderCircle className="setup-step-icon generation-spinner" size={18} aria-hidden /> : <CircleDashed className="setup-step-icon" size={18} aria-hidden />}
      <VStack className="grow" gap={1}>
        <b>{index + 1}. {label}</b>
        <small className="setup-step-detail">{detail}</small>
        {download ? <progress aria-label={label} value={download.received} max={step.model?.size || download.total || 1} /> : null}
        {action ? <HStack gap={1} vAlign="center" wrap="wrap" paddingBlockStart={1}>{action}</HStack> : null}
      </VStack>
    </HStack>;
  };
  return <Card ref={card} className="setup-checklist" padding={4} aria-label={t('@yovoice.setup.label')}>
    <VStack gap={3}>
      <HStack gap={2} vAlign="center" wrap="wrap"><h2 className="setup-title">{t('@yovoice.setup.title', { count: left })}</h2><small className="setup-hint grow">{t('@yovoice.setup.hint')}</small></HStack>
      <HStack className="setup-steps" gap={4} wrap="wrap" role="list">{steps.map(row)}</HStack>
    </VStack>
  </Card>;
}
