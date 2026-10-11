import type { ReactNode } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { HStack, VStack } from '@astryxdesign/core/Layout';
import { useTranslator } from '@astryxdesign/core/i18n';
import { PanelRightClose, PanelRightOpen, SlidersHorizontal } from 'lucide-react';

// 创作页：左侧正文，右侧检查器。宽屏下检查器可收起，收起后主操作移到标题栏，正文独占宽度。
export function Studio({ title, actions, inspector, showInspector, onShowInspector, inspectorCollapsed, onToggleInspector, collapsedAction, writingClassName = '', children }: {
  title: ReactNode; actions?: ReactNode; inspector: ReactNode; showInspector: boolean;
  onShowInspector: () => void; inspectorCollapsed?: boolean; onToggleInspector?: () => void; collapsedAction?: ReactNode;
  writingClassName?: string; children: ReactNode;
}) {
  const t = useTranslator();
  return <HStack className={`studio ${showInspector ? 'show-inspector' : ''} ${inspectorCollapsed ? 'collapse-inspector' : ''}`} gap={0}>
    <VStack as="section" className="document" gap={0}>
      <VStack className={`writing ${writingClassName}`} gap={0}>
        <HStack className="document-heading" gap={3} vAlign="center">
          {title}{actions}
          {inspectorCollapsed && collapsedAction ? <HStack className="inspector-collapsed-action" gap={0} vAlign="center">{collapsedAction}</HStack> : null}
          {onToggleInspector ? <Button label={t(inspectorCollapsed ? '@yovoice.app.expandInspector' : '@yovoice.app.collapseInspector')} className="inspector-collapse" isIconOnly variant="ghost"
            icon={inspectorCollapsed ? <PanelRightOpen /> : <PanelRightClose />} aria-expanded={!inspectorCollapsed} onClick={onToggleInspector} /> : null}
          <Button label={t('@yovoice.app.voiceSettings')} className="inspector-toggle" isIconOnly icon={<SlidersHorizontal />} variant="ghost" onClick={onShowInspector} />
        </HStack>
        {children}
      </VStack>
    </VStack>
    {inspector}
  </HStack>;
}
