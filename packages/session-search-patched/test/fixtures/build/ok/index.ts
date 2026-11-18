/** Fixture: engine module with the class constructs the generator has to erase or report. */

import { createHash } from 'node:crypto'
import { Context, Service, type Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type Persistence from '@deepseek-ai/dsh-session-persistence'
import { identity as ident, type Mode } from './query.ts'
import { open } from './schema.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    fixtureValue?: string
  }
}

export interface Cfg {
  path: string
}

abstract class Base<T = unknown> {
  declare readonly brand: string
  abstract run(): T
  describe(): string {
    return createHash('sha256').update(String(this.run())).digest('hex')
  }
}

export class Engine extends Service {
  static override inject = ['sessions']
  static Config: z<Cfg> = z.object({ path: z.string().required() })
  static label: string // field: static Engine.label

  declare note: string
  readonly config: Cfg // field: Engine.config
  private _ready: Promise<void> | undefined // field: Engine._ready
  _flag!: boolean // field: Engine._flag
  optional?: number // field: Engine.optional
  #hidden: string // field: Engine.#hidden
  protected tag = 'x' satisfies string
  count = 0 as number
  _fiber: Fiber | undefined = undefined

  constructor(ctx: Context, config: Cfg) {
    super(ctx, 'fixture')
    this.config = config
    this.#hidden = 'h'
  }

  override async close(): Promise<void> {
    await this._ready
  }

  protected async [Service.init](): Promise<void> {
    this._ready = open().then(() => undefined)
  }

  method<T extends object>(this: Engine, arg: T, mode?: Mode): T | undefined {
    return ident<T>(arg) as T
  }

  static {
    Engine.label = 'engine'
  }
}

class Plain {
  a: string // field: Plain.a
  b = () => {
    return 1
  }
  c?: number // field: Plain.c
  static d: string // field: static Plain.d
  get e() {
    return 1
  }
  f = [1, 2]
  g // field: Plain.g
}

export class Sub extends Base<string> {
  override run(): string {
    return new Plain().a
  }
}

export { Plain }
export type { Persistence }
