declare module 'pioarduino-node-helpers' {
  export const core: {
    getCoreDir(): string;
    getCacheDir(): string;
    getEnvDir(): string;
    getEnvBinDir(): string;
  };
}
