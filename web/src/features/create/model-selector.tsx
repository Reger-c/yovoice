import { useTranslator } from '@astryxdesign/core/i18n';
import { Selector, SelectorOption } from '../../shared/selector';
import { formatSize, type ModelPackage, type State } from '../../shared/workbench';

// 可选模型：只列已下载的，当前选中但未下载的也保留；一个都没下载时列出全部，方便首次选择后去下载。
export function modelChoices(models: ModelPackage[], state: State, current: string) {
  const installed = models.filter(model => state.models.some(item => item.id === model.id));
  if (!installed.length) return models;
  const selected = models.find(model => model.id === current);
  return selected && !installed.includes(selected) ? [selected, ...installed] : installed;
}

// 配音、音乐、编曲共用的模型选择器：同样的筛选、同样的“已安装 / 未下载 · 大小”说明，末尾是“管理模型…”。
export function ModelSelector({ label, models, state, value, isDisabled, manage, onChange, name = model => `${model.name} · ${model.precision}` }: {
  label: string; models: ModelPackage[]; state: State; value: string; isDisabled?: boolean;
  manage?: () => void; onChange: (modelId: string) => void; name?: (model: ModelPackage) => string;
}) {
  const t = useTranslator();
  const options = modelChoices(models, state, value).map(model => ({
    value: model.id, label: name(model),
    description: state.models.some(item => item.id === model.id) ? t('@yovoice.create.modelInstalled') : formatSize(model.size),
  }));
  return <Selector label={label} isLabelHidden width="100%" className="model-selector" value={value} isDisabled={isDisabled}
    renderOption={option => <SelectorOption label={option.label} description={option.description} layout="inline" />} renderValue={option => option.label}
    options={[...options, ...(manage ? [{ value: 'manage', label: t('@yovoice.create.manageModels') }] : [])]}
    onChange={modelId => { if (modelId === 'manage') manage?.(); else onChange(modelId); }} />;
}
