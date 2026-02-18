## [0.3.1](https://github.com/dankeboy36/trbr/compare/0.3.0...0.3.1) (2026-02-18)


### Bug Fixes

* **riscv:** preserve Windows MI frame paths ([#70](https://github.com/dankeboy36/trbr/issues/70)) ([4e379be](https://github.com/dankeboy36/trbr/commit/4e379be9b1edf9de15cf1873b9ca271751573167)), closes [#69](https://github.com/dankeboy36/trbr/issues/69)

# [0.3.0](https://github.com/dankeboy36/trbr/compare/0.2.2...0.3.0) (2026-02-13)


### Features

* add capturer API to decode streaming input ([#68](https://github.com/dankeboy36/trbr/issues/68)) ([398cdd9](https://github.com/dankeboy36/trbr/commit/398cdd9d49ba90d9399fe1a43cae0f4ee75bd139))

## [0.2.2](https://github.com/dankeboy36/trbr/compare/0.2.1...0.2.2) (2026-01-19)


### Bug Fixes

* **ci:** fix next version calculation for release ([#64](https://github.com/dankeboy36/trbr/issues/64)) ([bb6f0b4](https://github.com/dankeboy36/trbr/commit/bb6f0b4a509396dd01c686f1542dcebfc1623224))
* **ci:** replace next-version logic with a lib ([#63](https://github.com/dankeboy36/trbr/issues/63)) ([9ddc1b0](https://github.com/dankeboy36/trbr/commit/9ddc1b0694cd362da41a0dd30cb3d9e919bc2248))

## [0.2.1](https://github.com/dankeboy36/trbr/compare/0.2.0...0.2.1) (2026-01-18)


### Bug Fixes

* release to npm with GitHub OIDC ([#62](https://github.com/dankeboy36/trbr/issues/62)) ([bcb29ed](https://github.com/dankeboy36/trbr/commit/bcb29edb1efd8d482b859cefece95d8d08395d60))

# [0.2.0](https://github.com/dankeboy36/trbr/compare/0.1.24...0.2.0) (2026-01-18)


### Bug Fixes

* **ci:** allow job to publish w/o bypassing 2FA ([#61](https://github.com/dankeboy36/trbr/issues/61)) ([7ddf66d](https://github.com/dankeboy36/trbr/commit/7ddf66d7ec5333b9545e93a2e05c663679bde224))
* **ci:** next version calculation for the bin ([#60](https://github.com/dankeboy36/trbr/issues/60)) ([b8f3ea0](https://github.com/dankeboy36/trbr/commit/b8f3ea0d3eb169268510eaab87c53c53a2b0c8fb))


### Features

* **riscv:** decode vars, locals, and globals ([#59](https://github.com/dankeboy36/trbr/issues/59)) ([54a75c8](https://github.com/dankeboy36/trbr/commit/54a75c8157a2ac5f7a36b04a235ad7935bbc5444))

## [0.1.24](https://github.com/dankeboy36/trbr/compare/0.1.23...0.1.24) (2025-07-29)


### Bug Fixes

* add support for `esp32p4` `build.mcu` ([#45](https://github.com/dankeboy36/trbr/issues/45)) ([d5e24cf](https://github.com/dankeboy36/trbr/commit/d5e24cf1f38c01caaf1dd6dea0f05ec5f1f5f655))

## [0.1.23](https://github.com/dankeboy36/trbr/compare/0.1.22...0.1.23) (2025-07-15)


### Bug Fixes

* ensure decode output is flushed to stdout before exit ([#40](https://github.com/dankeboy36/trbr/issues/40)) ([4e9aca0](https://github.com/dankeboy36/trbr/commit/4e9aca0dbe01245ff67aa9a2ebc1784103eb52d8))

## [0.1.22](https://github.com/dankeboy36/trbr/compare/0.1.21...0.1.22) (2025-07-10)


### Bug Fixes

* infer decode target arch from `build.mcu` ([#38](https://github.com/dankeboy36/trbr/issues/38)) ([d4cbceb](https://github.com/dankeboy36/trbr/commit/d4cbceb5f289ae8789b12d99bbcbafb331eb015b))

## [0.1.21](https://github.com/dankeboy36/trbr/compare/0.1.20...0.1.21) (2025-07-07)


### Bug Fixes

* cleanup open streams + processes after decode ([#37](https://github.com/dankeboy36/trbr/issues/37)) ([617a6fa](https://github.com/dankeboy36/trbr/commit/617a6fad361c4b90a596c654be6eb3bf27e0034e))

## [0.1.20](https://github.com/dankeboy36/trbr/compare/0.1.19...0.1.20) (2025-07-06)


### Bug Fixes

* can force color mode ([#36](https://github.com/dankeboy36/trbr/issues/36)) ([1666256](https://github.com/dankeboy36/trbr/commit/16662569b121fbd5f0ecf1bda279be4c7d85c953))

## [0.1.19](https://github.com/dankeboy36/trbr/compare/0.1.18...0.1.19) (2025-07-05)


### Bug Fixes

* support cancellation ([#35](https://github.com/dankeboy36/trbr/issues/35)) ([3faf3fc](https://github.com/dankeboy36/trbr/commit/3faf3fc7ee3c646401f0c585136a40fc14560405))

## [0.1.18](https://github.com/dankeboy36/trbr/compare/0.1.17...0.1.18) (2025-07-05)


### Bug Fixes

* use `tinyexec` as a dev dependency  ([#34](https://github.com/dankeboy36/trbr/issues/34)) ([7fda576](https://github.com/dankeboy36/trbr/commit/7fda576c1e25eb551e175d2bf78832879052293e))

## [0.1.17](https://github.com/dankeboy36/trbr/compare/0.1.16...0.1.17) (2025-07-04)


### Bug Fixes

* addr2line error handling ([#33](https://github.com/dankeboy36/trbr/issues/33)) ([b58bc04](https://github.com/dankeboy36/trbr/commit/b58bc04d7b64e1c06883de74262cc4e51e345b43))

## [0.1.16](https://github.com/dankeboy36/trbr/compare/0.1.15...0.1.16) (2025-07-03)


### Bug Fixes

* no nested ANSI colors ([#32](https://github.com/dankeboy36/trbr/issues/32)) ([e98d840](https://github.com/dankeboy36/trbr/commit/e98d84047a1b5786abdbedf250c7e28ca9b13447))

## [0.1.15](https://github.com/dankeboy36/trbr/compare/0.1.14...0.1.15) (2025-07-02)


### Bug Fixes

* correct addr formatting in malloc error ([#31](https://github.com/dankeboy36/trbr/issues/31)) ([c257db2](https://github.com/dankeboy36/trbr/commit/c257db2a99424795eec2c1b30630e8b4f2c70946))

## [0.1.14](https://github.com/dankeboy36/trbr/compare/0.1.13...0.1.14) (2025-06-27)


### Bug Fixes

* relax ELF detection in dump ([#30](https://github.com/dankeboy36/trbr/issues/30)) ([0a36737](https://github.com/dankeboy36/trbr/commit/0a3673783c6e9e7d7c2f9a08162eefccd4249a2e))

## [0.1.13](https://github.com/dankeboy36/trbr/compare/0.1.12...0.1.13) (2025-06-24)


### Bug Fixes

* enable color by default ([#28](https://github.com/dankeboy36/trbr/issues/28)) ([bab6b7e](https://github.com/dankeboy36/trbr/commit/bab6b7ec768f2c2030195aa424201c7e8d3bf8ba))

## [0.1.12](https://github.com/dankeboy36/trbr/compare/0.1.11...0.1.12) (2025-06-24)


### Bug Fixes

* decode coredump from raw ESP32 flash dump ([#27](https://github.com/dankeboy36/trbr/issues/27)) ([34d35f4](https://github.com/dankeboy36/trbr/commit/34d35f4a8b5a28d90acdfdb5d445f1ba0f3dc34c))

## [0.1.11](https://github.com/dankeboy36/trbr/compare/0.1.10...0.1.11) (2025-06-23)


### Bug Fixes

* drop ink app ([#26](https://github.com/dankeboy36/trbr/issues/26)) ([99ac62c](https://github.com/dankeboy36/trbr/commit/99ac62c6b882c8848a910dc3840393835bdcd82e))

## [0.1.10](https://github.com/dankeboy36/trbr/compare/0.1.9...0.1.10) (2025-06-19)


### Bug Fixes

* update readme ([#25](https://github.com/dankeboy36/trbr/issues/25)) ([832cbc0](https://github.com/dankeboy36/trbr/commit/832cbc051c58b83f2df6b112ebde6a05434d44f0))

## [0.1.9](https://github.com/dankeboy36/trbr/compare/0.1.8...0.1.9) (2025-06-19)


### Bug Fixes

* decode ESP ELF coredump with GDB ([#24](https://github.com/dankeboy36/trbr/issues/24)) ([5494b18](https://github.com/dankeboy36/trbr/commit/5494b1875d2c3db53c6380161cb02931e0f014e8))

## [0.1.8](https://github.com/dankeboy36/trbr/compare/0.1.7...0.1.8) (2025-03-31)


### Bug Fixes

* **doc:** document lib API ([#14](https://github.com/dankeboy36/trbr/issues/14)) ([f2b5baf](https://github.com/dankeboy36/trbr/commit/f2b5baf2e241242842790daf8c2e54c05dfb0673))

## [0.1.7](https://github.com/dankeboy36/trbr/compare/0.1.6...0.1.7) (2025-03-30)


### Bug Fixes

* increase timeout for paste input processing ([#13](https://github.com/dankeboy36/trbr/issues/13)) ([a097cb7](https://github.com/dankeboy36/trbr/commit/a097cb7ab3b4daa89abb5a824be71a82e0a70d8b))

## [0.1.6](https://github.com/dankeboy36/trbr/compare/0.1.5...0.1.6) (2025-03-30)


### Bug Fixes

* **lib:** correct the typing of `resolveToolPath` ([#11](https://github.com/dankeboy36/trbr/issues/11)) ([9e27c31](https://github.com/dankeboy36/trbr/commit/9e27c31a287602f29b7eda802c2a3c5c95e5a50a))

## [0.1.5](https://github.com/dankeboy36/trbr/compare/0.1.4...0.1.5) (2025-03-30)


### Bug Fixes

* distribute lib as cjs and esm ([#10](https://github.com/dankeboy36/trbr/issues/10)) ([4cd7cb4](https://github.com/dankeboy36/trbr/commit/4cd7cb4608b53e11bfd56109f4558f329460f278))

## [0.1.4](https://github.com/dankeboy36/trbr/compare/0.1.3...0.1.4) (2025-03-29)


### Bug Fixes

* `--target-arch` defaults to `xtensa` ([#9](https://github.com/dankeboy36/trbr/issues/9)) ([0863166](https://github.com/dankeboy36/trbr/commit/086316667794a403868d1f1a88e2dc67111142c2))

## [0.1.3](https://github.com/dankeboy36/trbr/compare/0.1.2...0.1.3) (2025-03-28)


### Bug Fixes

* update readme ([#6](https://github.com/dankeboy36/trbr/issues/6)) ([a701c83](https://github.com/dankeboy36/trbr/commit/a701c83956d628c269f1ecb25ef7bbf8cee3fa1d))

## [0.1.2](https://github.com/dankeboy36/trbr/compare/0.1.1...0.1.2) (2025-03-28)


### Bug Fixes

* admin_token is missing for next version ([#5](https://github.com/dankeboy36/trbr/issues/5)) ([d9a8c6a](https://github.com/dankeboy36/trbr/commit/d9a8c6aed0da022e2c246af3df997eed71e41482))

## [0.1.1](https://github.com/dankeboy36/trbr/compare/0.1.0...0.1.1) (2025-03-28)


### Bug Fixes

* build lib code for the npm release ([#4](https://github.com/dankeboy36/trbr/issues/4)) ([ca3c23b](https://github.com/dankeboy36/trbr/commit/ca3c23ba317a71303884292764bab710d5c20704))

# [0.1.0](https://github.com/dankeboy36/trbr/compare/0.0.1...0.1.0) (2025-03-28)


### Bug Fixes

* **ci:** use `actions/download-artifact@v4` ([#2](https://github.com/dankeboy36/trbr/issues/2)) ([3416b45](https://github.com/dankeboy36/trbr/commit/3416b45b8323e3c7fd043fb73fa8f02ad80dc0b5))
* get the next version before packaging the CLI ([#3](https://github.com/dankeboy36/trbr/issues/3)) ([74501c4](https://github.com/dankeboy36/trbr/commit/74501c4e162646f1d02e98e409374ab195389de4))


### Features

* initial standalone decoder implementation ([#1](https://github.com/dankeboy36/trbr/issues/1)) ([4b61130](https://github.com/dankeboy36/trbr/commit/4b61130bf2be506fa80fa1db7e3277ff449dbb56))

# [0.1.0](https://github.com/dankeboy36/trbr/compare/0.0.1...0.1.0) (2025-03-27)


### Bug Fixes

* **ci:** use `actions/download-artifact@v4` ([#2](https://github.com/dankeboy36/trbr/issues/2)) ([3416b45](https://github.com/dankeboy36/trbr/commit/3416b45b8323e3c7fd043fb73fa8f02ad80dc0b5))


### Features

* initial standalone decoder implementation ([#1](https://github.com/dankeboy36/trbr/issues/1)) ([4b61130](https://github.com/dankeboy36/trbr/commit/4b61130bf2be506fa80fa1db7e3277ff449dbb56))

## [1.2.3](https://github.com/dankeboy36/get-arduino-tools/compare/1.2.2...1.2.3) (2025-02-17)


### Bug Fixes

* **security:** add guard against Zip Slip vulnerability (CWE-22) ([#18](https://github.com/dankeboy36/get-arduino-tools/issues/18)) ([9c9a422](https://github.com/dankeboy36/get-arduino-tools/commit/9c9a422887648f37ff9c4a5b766c0d68bc59fe97))

## [1.2.2](https://github.com/dankeboy36/get-arduino-tools/compare/1.2.1...1.2.2) (2025-02-11)


### Bug Fixes

* split progress to download and extract parts ([#16](https://github.com/dankeboy36/get-arduino-tools/issues/16)) ([473d76a](https://github.com/dankeboy36/get-arduino-tools/commit/473d76a26b03547a873935044046e4e8e85315ea))

## [1.2.1](https://github.com/dankeboy36/get-arduino-tools/compare/1.2.0...1.2.1) (2025-02-10)


### Bug Fixes

* incorrect progress event ([#15](https://github.com/dankeboy36/get-arduino-tools/issues/15)) ([899fbe4](https://github.com/dankeboy36/get-arduino-tools/commit/899fbe445a9d834c9727ae18c58e22c4795a14c1))

# [1.2.0](https://github.com/dankeboy36/get-arduino-tools/compare/1.1.1...1.2.0) (2025-02-09)


### Features

* cancellation support ([#14](https://github.com/dankeboy36/get-arduino-tools/issues/14)) ([e6cc22a](https://github.com/dankeboy36/get-arduino-tools/commit/e6cc22a13f46daa07cc8ce57d6b62dbcc6ed679c))

## [1.1.1](https://github.com/dankeboy36/get-arduino-tools/compare/1.1.0...1.1.1) (2025-01-31)


### Bug Fixes

* **doc:** add missing `--silent` option ([#13](https://github.com/dankeboy36/get-arduino-tools/issues/13)) ([87a5a99](https://github.com/dankeboy36/get-arduino-tools/commit/87a5a9983813ff360efc08f34e1d62ae5c9c67ae))

# [1.1.0](https://github.com/dankeboy36/get-arduino-tools/compare/1.0.7...1.1.0) (2025-01-31)


### Features

* add progress support ([#12](https://github.com/dankeboy36/get-arduino-tools/issues/12)) ([23c5453](https://github.com/dankeboy36/get-arduino-tools/commit/23c5453f91f6a40cf391349423c2357f9d66a3be))

## [1.0.7](https://github.com/dankeboy36/get-arduino-tools/compare/1.0.6...1.0.7) (2025-01-26)


### Bug Fixes

* switch to cjs type ([#11](https://github.com/dankeboy36/get-arduino-tools/issues/11)) ([fb6b638](https://github.com/dankeboy36/get-arduino-tools/commit/fb6b6385ce249ccf3466969ffa3322b5e996066c))

## [1.0.6](https://github.com/dankeboy36/get-arduino-tools/compare/1.0.5...1.0.6) (2025-01-26)


### Bug Fixes

* rethrow original error from `getTool` ([#10](https://github.com/dankeboy36/get-arduino-tools/issues/10)) ([1c2d35a](https://github.com/dankeboy36/get-arduino-tools/commit/1c2d35a438e0cffe3b6e5cec5b94ad202d747fbb))

## [1.0.5](https://github.com/dankeboy36/get-arduino-tools/compare/1.0.4...1.0.5) (2025-01-25)


### Bug Fixes

* fail fast before download if file already exists ([#9](https://github.com/dankeboy36/get-arduino-tools/issues/9)) ([dda18f6](https://github.com/dankeboy36/get-arduino-tools/commit/dda18f65d52a9984468c4ff38f78bc2624d98d50))

## [1.0.4](https://github.com/dankeboy36/get-arduino-tools/compare/1.0.3...1.0.4) (2025-01-23)


### Bug Fixes

* omit the error stacktrace from the CLI output ([#8](https://github.com/dankeboy36/get-arduino-tools/issues/8)) ([b940c41](https://github.com/dankeboy36/get-arduino-tools/commit/b940c41f1b6fc09c040e5714b3a594ca4e0f412d))

## [1.0.3](https://github.com/dankeboy36/get-arduino-tools/compare/1.0.2...1.0.3) (2025-01-23)


### Bug Fixes

* **release:** switch to `cjs` format ([#7](https://github.com/dankeboy36/get-arduino-tools/issues/7)) ([0b6e03e](https://github.com/dankeboy36/get-arduino-tools/commit/0b6e03e28a0b5956006a8489d141d1806f00070d))

## [1.0.2](https://github.com/dankeboy36/get-arduino-tools/compare/1.0.1...1.0.2) (2025-01-21)


### Bug Fixes

* **release:** correct `files` declaration in `package.json` ([#6](https://github.com/dankeboy36/get-arduino-tools/issues/6)) ([76525a2](https://github.com/dankeboy36/get-arduino-tools/commit/76525a2f3087820fce26095c857ec5eab53066ea)), closes [#4](https://github.com/dankeboy36/get-arduino-tools/issues/4) [#5](https://github.com/dankeboy36/get-arduino-tools/issues/5)

## [1.0.1](https://github.com/dankeboy36/get-arduino-tools/compare/1.0.0...1.0.1) (2025-01-21)


### Bug Fixes

* **doc:** correct tool names and repository URL in the README ([#3](https://github.com/dankeboy36/get-arduino-tools/issues/3)) ([308db2f](https://github.com/dankeboy36/get-arduino-tools/commit/308db2f9ecf72dc94144a471840837900e72d764))

# 1.0.0 (2025-01-21)


### Bug Fixes

* **release:** rename npm package ([#2](https://github.com/dankeboy36/get-arduino-tools/issues/2)) ([f2fb35b](https://github.com/dankeboy36/get-arduino-tools/commit/f2fb35b8fa7916b624649c5926c09e79689eca0f))


### Features

* can download an Arduino tool ([#1](https://github.com/dankeboy36/get-arduino-tools/issues/1)) ([0ee1537](https://github.com/dankeboy36/get-arduino-tools/commit/0ee1537f28cc45c2539c01f0ccbb117085cd71b0))

# 1.0.0 (2025-01-21)


### Features

* can download an Arduino tool ([#1](https://github.com/dankeboy36/gat/issues/1)) ([0ee1537](https://github.com/dankeboy36/gat/commit/0ee1537f28cc45c2539c01f0ccbb117085cd71b0))
