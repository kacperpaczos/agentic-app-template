import { buildRegistry, platformArtifactRenderers, platformCardRenderers } from '@platform/ui';
import { procurementUiModule } from '@module/procurement/ui';
import type { MenuItemContribution } from '@platform/contracts';

/**
 * Application composition root (browser half).
 *
 * The platform shell knows nothing about procurement; this file is what joins
 * them. Swapping `modules` for `[]` yields a working, empty application — that
 * path is what `tests/platform-boundary.test.ts` exercises on the server side.
 */
const platformMenu: MenuItemContribution[] = [
  { id: 'platform.canvas', section: 'workspace', label: 'Canvas', to: '/', order: 1 },
  { id: 'platform.spaces', section: 'workspace', label: 'Zapisane kompozycje', to: '/spaces', order: 2 },
  { id: 'platform.agentViews', section: 'workspace', label: 'Widoki agenta', to: '/agent-views', order: 3 },
  { id: 'platform.files', section: 'files', label: 'Pliki i raporty', to: '/files', order: 1 },
  { id: 'platform.settings', section: 'settings', label: 'Ustawienia', to: '/settings', order: 1 },
];

export const registry = buildRegistry({
  modules: [procurementUiModule],
  platformCardRenderers,
  platformArtifactRenderers: platformArtifactRenderers as never,
  platformMenu,
});
