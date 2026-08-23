import { DaemonServerRequests } from './daemon-server-requests'
import type { DaemonServerConstructionOptions } from './daemon-server-runtime'

export type DaemonServerOptions = DaemonServerConstructionOptions

export class DaemonServer extends DaemonServerRequests {
  constructor(options: DaemonServerOptions) {
    super(options)
  }
}
