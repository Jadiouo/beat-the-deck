export interface Launch {
  readonly card: string;
  readonly seed: number;
  readonly autoplay: 'human-model' | null;
  readonly speed: number;
}

export function parseLaunch(_search: string, _devBuild: boolean): Launch | null {
  throw new Error('not implemented');
}
