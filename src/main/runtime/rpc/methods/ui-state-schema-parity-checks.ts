import type { z } from 'zod'
import type {
  PersistedUIState,
  RightSidebarTab,
  WorktreeCardProperty
} from '../../../../shared/types'
import type {
  RightSidebarTabSchema,
  UiUpdateFieldsSchema,
  WorktreeCardPropertySchema
} from './client-ui-schemas'
import type { AssertNoMissingKeys, AssertNoMissingValues } from './ui-state-schema-parity'

// Why: state only the main process ever writes (store.updateUI, star-nag's own
// IPC, window lifecycle). Clients never send these, so keeping them out of the
// strict schema is deliberate — but it must stay deliberate rather than
// forgotten, which is what the parity assertion below enforces.
type MainOwnedUIState =
  | 'trayMinimizeNoticeShown'
  | 'dashboardPopoutBounds'
  | '_expandedWorktreeCardPropertiesDefaulted'
  | 'starNagBaselineAgents'
  | 'starNagAppVersion'
  | 'starNagNextThreshold'
  | 'starNagCompleted'
  | 'starNagDeferredUntil'
  | 'starNagAgentValueMomentAppVersion'
const _uiUpdateParity: AssertNoMissingKeys<
  Omit<PersistedUIState, MainOwnedUIState>,
  z.infer<UiUpdateFieldsSchema>
> = true
void _uiUpdateParity

// Why: key parity is blind to enum drift, which is how 'cli' and three
// rightSidebarTab members went missing while the guard above stayed green.
const _worktreeCardPropertyParity: AssertNoMissingValues<
  WorktreeCardProperty,
  z.infer<WorktreeCardPropertySchema>
> = true
void _worktreeCardPropertyParity
const _rightSidebarTabParity: AssertNoMissingValues<
  RightSidebarTab,
  z.infer<RightSidebarTabSchema>
> = true
void _rightSidebarTabParity
