declare module 'pioarduino-node-helpers' {
  export const core: {
    getCoreDir(): string;
    getCacheDir(): string;
    getEnvDir(): string;
    getEnvBinDir(): string;
    getCorePythonCommandOutput(args: string[], options?: { projectDir?: string }): Promise<string>;
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
