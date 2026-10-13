import { useEffect, useState } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { HStack, VStack } from '@astryxdesign/core/Layout';
import { StatusDot } from '@astryxdesign/core/StatusDot';
import { useTranslator } from '@astryxdesign/core/i18n';
import { FolderCog, FolderOpen, Trash2 } from 'lucide-react';
import { call } from '../../shared/lib/client';
import { formatBytes, type CleanupReport, type StorageInfo, type State } from '../../shared/workbench';
import { overflowTitle } from '../../shared/ui/overflow-title';
import { AppDialog } from '../../shared/ui/app-dialog';
import { SettingsGroup, SettingsRow } from './settings-group';

// 设置 › 常规里的“存储”：数据目录路径、各类占用明细、更改存储位置、打开目录和清理残留。
export function StorageSettings({ state, run, busy }: { state: State; run: (task: () => Promise<unknown>) => void; busy?: boolean }) {
  const t = useTranslator();
  const [info, setInfo] = useState<StorageInfo | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const [relocating, setRelocating] = useState(false);
  const [cleanupMessage, setCleanupMessage] = useState<string | null>(null);

  const refresh = () => {
    call<StorageInfo>('storage.info').then(setInfo).catch(() => setInfo(null));
  };

  useEffect(() => {
    refresh();
  }, []);

  if (!info) return null;

  const changeLocation = () => run(async () => {
    setRelocating(true);
    try {
      await call('storage.directory');
      refresh();
    } finally {
      setRelocating(false);
    }
  });

  const openFolder = () => run(async () => {
    await call('storage.directory.open');
  });

  const cleanup = () => run(async () => {
    setCleaning(true);
    setCleanupMessage(null);
    try {
      const res = await call<CleanupReport>('storage.cleanup');
      refresh();
      if (res && res.cleanedCount > 0) {
        setCleanupMessage(t('@yovoice.settings.cleanupSuccess', {
          count: res.cleanedCount,
          size: formatBytes(res.freedBytes),
        }));
      } else {
        setCleanupMessage(t('@yovoice.settings.cleanupEmpty'));
      }
    } finally {
      setCleaning(false);
    }
  });

  const breakdown = t('@yovoice.settings.storageBreakdown', {
    total: formatBytes(info.totalBytes),
    models: formatBytes(info.modelsBytes),
    outputs: formatBytes(info.outputsBytes),
    voices: formatBytes(info.voicesBytes),
    downloads: formatBytes(info.downloadsBytes),
  });

  const activity = state.activity;
  const showRelocateDialog = relocating || activity?.kind === 'relocate';

  return <SettingsGroup title={t('@yovoice.settings.storageGroup')} description={t('@yovoice.settings.storageRelocateHint')}>
    <SettingsRow
      className="settings-directory"
      label={t('@yovoice.settings.storageDirectory')}
      hint={<VStack gap={1}>
        <span className="model-path" onPointerEnter={overflowTitle}>{info.root}</span>
        <span>{breakdown}</span>
        {info.pendingPath ? <HStack gap={1} vAlign="center">
          <StatusDot variant="warning" label={t('@yovoice.settings.storageRelocatePending')} />
          <span>{t('@yovoice.settings.storageRelocatePending')}</span>
        </HStack> : null}
      </VStack>}
    >
      <Button
        size="sm"
        label={t('@yovoice.settings.changeLocation')}
        icon={<FolderCog size={16} />}
        isDisabled={busy || relocating || !!info.pendingPath}
        isLoading={relocating}
        onClick={changeLocation}
      />
      <Button
        size="sm"
        label={t('@yovoice.settings.openFolder')}
        icon={<FolderOpen size={16} />}
        onClick={openFolder}
      />
    </SettingsRow>
    <SettingsRow
      label={t('@yovoice.settings.cleanupResiduals')}
      hint={cleanupMessage ? <VStack gap={1}>
        <span>{t('@yovoice.settings.cleanupResidualsHint')}</span>
        <span>{cleanupMessage}</span>
      </VStack> : t('@yovoice.settings.cleanupResidualsHint')}
    >
      <Button
        size="sm"
        label={t('@yovoice.settings.cleanupResiduals')}
        icon={<Trash2 size={16} />}
        isLoading={cleaning}
        isDisabled={busy || cleaning}
        onClick={cleanup}
      />
    </SettingsRow>

    {showRelocateDialog ? <AppDialog
      title={t('@yovoice.settings.relocatingTitle')}
      width={460}
      busy={true}
      onClose={() => {}}
    >
      <VStack gap={3}>
        <p>{t('@yovoice.settings.relocatingHint')}</p>
        <progress
          value={activity?.total && activity.total > 0 ? activity.received : undefined}
          max={activity?.total && activity.total > 0 ? activity.total : 1}
          style={{ width: '100%' }}
        />
        {activity?.total && activity.total > 0 ? <HStack hAlign="between">
          <small>{formatBytes(activity.received)} / {formatBytes(activity.total)}</small>
          <small>{Math.round((activity.received / activity.total) * 100)}%</small>
        </HStack> : null}
      </VStack>
    </AppDialog> : null}
  </SettingsGroup>;
}
