declare module 'pioarduino-node-helpers' {
  export const core: {
    getCoreDir(): string;
    getCacheDir(): string;
    getEnvDir(): string;
    getEnvBinDir(): string;
    getCoreState(): {
      core_dir?: string;
      penv_dir?: string;
      penv_bin_dir?: string;
      python_exe?: string;
    };
    setCoreState(state: {
      core_dir?: string;
      penv_dir?: string;
      penv_bin_dir?: string;
      python_exe?: string;
    }): void;
    getCorePythonCommandOutput(
      args: string[],
      options?: { projectDir?: string }
    ): Promise<string>;
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
