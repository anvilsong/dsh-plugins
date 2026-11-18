declare function logged(target: unknown, key: string): void
export class Decorated {
  @logged
  run() {}
}
