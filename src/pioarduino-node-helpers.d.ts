declare module 'pioarduino-node-helpers' {
  export const core: {
    getCoreDir(): string;
    getCacheDir(): string;
    getEnvDir(): string;
    getEnvBinDir(): string;
    getCorePythonExe(): Promise<string>;
    getCorePythonCommandOutput(args: string[], options?: { projectDir?: string }): Promise<string>;
  };
  export const installer: {
    pioarduinoCoreStage: new (
      stateStorage: object,
      onStatusChange: () => void,
      params?: {
        useBuiltinPIOCore?: boolean;
        disableAutoUpdates?: boolean;
        pythonPrompt?: { STATUS_TRY_AGAIN: number };
      }
    ) => {
      loadCoreState(): Promise<boolean>;
    };
  };
  export const project: {
    ProjectConfig: new (projectDir: string) => {
      read(): Promise<void>;
      envs(): string[];
      defaultEnvs(): string[];
      defaultEnv(): string;
      getEnvPlatform(env: string): string | null;
      getEnvMonitorSpeed(env: string): number | undefined;
    };
  };
}
