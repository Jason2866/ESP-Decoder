// @ts-check

import net from 'node:net'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { __tests, decodeRiscv, GdbServer } from './riscv.js'

const {
  createRegNameValidator,
  parsePanicOutput,
  buildPanicServerArgs,
  getStackAddrAndData,
  parseGDBOutput,
  parseMiFrames,
  parseMiLocals,
  parseMiStackArgs,
  toParsedFrame,
  toHexString,
  gdbRegsInfo,
  gdbRegsInfoRiscvIlp32,
  createDecodeResult,
} = __tests

export const esp32c3Input = `Core  0 panic'ed (Load access fault). Exception was unhandled.

Core  0 register dump:
MEPC    : 0x4200007e  RA      : 0x4200007e  SP      : 0x3fc98300  GP      : 0x3fc8d000  
TP      : 0x3fc98350  T0      : 0x4005890e  T1      : 0x3fc8f000  T2      : 0x00000000  
S0/FP   : 0x420001ea  S1      : 0x3fc8f000  A0      : 0x00000001  A1      : 0x00000001  
A2      : 0x3fc8f000  A3      : 0x3fc8f000  A4      : 0x00000000  A5      : 0x600c0028  
A6      : 0xfa000000  A7      : 0x00000014  S2      : 0x00000000  S3      : 0x00000000  
S4      : 0x00000000  S5      : 0x00000000  S6      : 0x00000000  S7      : 0x00000000  
S8      : 0x00000000  S9      : 0x00000000  S10     : 0x00000000  S11     : 0x00000000  
T3      : 0x3fc8f000  T4      : 0x00000001  T5      : 0x3fc8f000  T6      : 0x00000001  
MSTATUS : 0x00001801  MTVEC   : 0x40380001  MCAUSE  : 0x00000005  MTVAL   : 0x00000000  
MHARTID : 0x00000000  

Stack memory:
3fc98300: 0x00000000 0x00000000 0x00000000 0x42001c4c 0x00000000 0x00000000 0x00000000 0x40385d20
3fc98320: 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000
3fc98340: 0x00000000 0xa5a5a5a5 0xa5a5a5a5 0xa5a5a5a5 0xa5a5a5a5 0xbaad5678 0x00000168 0xabba1234
3fc98360: 0x0000015c 0x3fc98270 0x000007d7 0x3fc8e308 0x3fc8e308 0x3fc98364 0x3fc8e300 0x00000018
3fc98380: 0x00000000 0x00000000 0x3fc98364 0x00000000 0x00000001 0x3fc96354 0x706f6f6c 0x6b736154
3fc983a0: 0x00000000 0x00000000 0x3fc98350 0x00000005 0x00000000 0x00000001 0x00000000 0x00000000
3fc983c0: 0x00000000 0x00000262 0x00000000 0x3fc8fe64 0x3fc8fecc 0x3fc8ff34 0x00000000 0x00000000
3fc983e0: 0x00000001 0x00000000 0x00000000 0x00000000 0x4200917a 0x00000000 0x00000000 0x00000000
3fc98400: 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000
3fc98420: 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000
3fc98440: 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000
3fc98460: 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000
3fc98480: 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000
3fc984a0: 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000
3fc984c0: 0xbaad5678 0x00000068 0xabba1234 0x0000005c 0x00000000 0x3fc984d0 0x00000000 0x00000000
3fc984e0: 0x00000000 0x3fc984e8 0xffffffff 0x3fc984e8 0x3fc984e8 0x00000000 0x3fc984fc 0xffffffff
3fc98500: 0x3fc984fc 0x3fc984fc 0x00000001 0x00000001 0x00000000 0x7700ffff 0x00000000 0x036f2206
3fc98520: 0x51c34501 0x8957fe96 0xdc2f3bf2 0xbaad5678 0x00000088 0xabba1234 0x0000007c 0x00000000
3fc98540: 0x00000014 0x3fc98d94 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000 0x3fc985c8
3fc98560: 0x00000000 0x00000101 0x00000000 0x00000000 0x0000000a 0x3fc98cf0 0x00000000 0x00000000
3fc98580: 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000
3fc985a0: 0x00000000 0x3fc98b40 0x3fc98ad4 0x3fc98c84 0x3fc98c18 0x3fc98bac 0xbaad5678 0x0000020c
3fc985c0: 0xabba1234 0x00000200 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000
3fc985e0: 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000
3fc98600: 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000
3fc98620: 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000
3fc98640: 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000
3fc98660: 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000
3fc98680: 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000
3fc986a0: 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000
3fc986c0: 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000
3fc986e0: 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000
`

const esp32c3Stdout = `a::geta (this=0x0) at /Users/kittaakos/Documents/Arduino/riscv_1/riscv_1.ino:11
11	    return a;
#0  a::geta (this=0x0) at /Users/kittaakos/Documents/Arduino/riscv_1/riscv_1.ino:11
#1  loop () at /Users/kittaakos/Documents/Arduino/riscv_1/riscv_1.ino:21
#2  0x4c1c0042 in ?? ()
Backtrace stopped: frame did not save the PC`

// https://github.com/dankeboy36/esp-exception-decoder/issues/43#issuecomment-2871334303
const esp32c6Stdout = `0x420000a2 in setup () at /Users/kittaakos/dev/sandbox/trbr/.tests/sketches/eed_issue43/eed_issue43.ino:20
20	  *p3 = 10;                      // Cause exception here
#0  0x420000a2 in setup () at /Users/kittaakos/dev/sandbox/trbr/.tests/sketches/eed_issue43/eed_issue43.ino:20
#1  0x42002024 in loopTask (pvParameters=<optimized out>) at /Users/kittaakos/Library/Arduino15/packages/esp32/hardware/esp32/3.2.0/cores/esp32/main.cpp:59
#2  0x526c8040 in ?? ()
Backtrace stopped: previous frame inner to this frame (corrupt stack?)
`

const miFramesOutput =
  '^done,stack=[frame={level="0",addr="0x4200007e",func="a::geta",file="/path/sketch.ino",fullname="/path/sketch.ino",line="11"},frame={level="1",addr="0x42000088",func="loop",file="/path/sketch.ino",line="21"},frame={level="2",addr="0x4c1c0042"}]'
const miFramesOutputWindows =
  '^done,stack=[frame={level="0",addr="0x420000a0",func="functionC",fullname="C:\\\\Users\\\\xxx\\\\dev\\\\git\\\\boardlab\\\\test_workspace\\\\esp32backtracetest\\\\module2.cpp",line="9"}]'

const miArgsOutput =
  '^done,stack-args=[frame={level="0",args=[{name="this",type="a *",value="0x0"}]},frame={level="1",args=[{name="pvParameters",value="<optimized out>"}]}]'

const miLocalsOutput =
  '^done,variables=[{name="count",type="int",value="42"},{name="ptr",type="char *",value="0x0",addr="0x3fc00000"}]'

describe('riscv', () => {
  describe('createRegNameValidator', () => {
    it('should validate the register name', () => {
      Object.keys(gdbRegsInfo).forEach((target) => {
        const validator = createRegNameValidator(
          /** @type {keyof typeof gdbRegsInfo} */ (target)
        )
        gdbRegsInfoRiscvIlp32.forEach((reg) => {
          expect(validator(reg)).toBe(true)
        })
      })
    })

    it('should fail for invalid target', () => {
      // @ts-ignore
      expect(() => createRegNameValidator('foo')).toThrow()
    })

    it('should detect invalid', () => {
      const actual = createRegNameValidator('esp32c3')('foo')
      expect(actual).toBe(false)
    })
  })

  describe('createDecodeResult', () => {
    it('should create a decode result', () => {
      const panicInfo = parsePanicOutput({
        input: esp32c3Input,
        target: 'esp32c3',
      })
      const actual = createDecodeResult(
        panicInfo,
        { addr: 0x4200007e, location: '0x4200007e' },
        { addr: 0x00000000, location: '0x00000000' },
        parseGDBOutput(esp32c3Stdout),
        []
      )
      expect(actual).toStrictEqual({
        faultInfo: {
          coreId: 0,
          programCounter: {
            addr: 1107296382,
            location: '0x4200007e',
          },
          faultAddr: {
            addr: 0,
            location: '0x00000000',
          },
          faultCode: 5,
          faultMessage: 'Load access fault',
        },
        regs: {
          MEPC: 0x4200007e,
          RA: 0x4200007e,
          SP: 0x3fc98300,
          GP: 0x3fc8d000,
          TP: 0x3fc98350,
          T0: 0x4005890e,
          T1: 0x3fc8f000,
          'S0/FP': 0x420001ea,
          S1: 0x3fc8f000,
          A0: 0x00000001,
          A1: 0x00000001,
          A2: 0x3fc8f000,
          A3: 0x3fc8f000,
          A5: 0x600c0028,
          A6: 0xfa000000,
          A7: 0x00000014,
          T3: 0x3fc8f000,
          T4: 0x00000001,
          T5: 0x3fc8f000,
          T6: 0x00000001,
        },
        stacktraceLines: [
          {
            method: 'a::geta',
            args: [{ name: 'this', value: '0x0' }],
            regAddr: '??',
            file: '/Users/kittaakos/Documents/Arduino/riscv_1/riscv_1.ino',
            lineNumber: '11',
          },
          {
            method: 'a::geta',
            args: [{ name: 'this', value: '0x0' }],
            regAddr: '??',
            file: '/Users/kittaakos/Documents/Arduino/riscv_1/riscv_1.ino',
            lineNumber: '11',
          },
          {
            method: 'loop',
            regAddr: '??',
            file: '/Users/kittaakos/Documents/Arduino/riscv_1/riscv_1.ino',
            lineNumber: '21',
          },
          {
            regAddr: '0x4c1c0042',
            lineNumber: '??',
          },
        ],
        allocInfo: undefined,
        globals: [],
      })
    })
  })

  describe('GdbServer', () => {
    const panicInfo = parsePanicOutput({
      input: esp32c3Input,
      target: 'esp32c3',
    })
    const params = /** @type {const} */ ({ panicInfo })
    /** @type {GdbServer} */
    let server
    /** @type {net.Socket} */
    let client

    beforeEach(async () => {
      server = new GdbServer(params)
      const address = await server.start()
      client = await new Promise((resolve) => {
        const socket = net.createConnection({ port: address.port }, () =>
          resolve(socket)
        )
      })
    })

    afterEach(() => {
      server.close()
      client.destroy()
      vi.resetAllMocks()
    })

    it('should error when address is null', async () => {
      const originalModule = await import('node:net')
      const originalCreateServer = originalModule.createServer
      vi.spyOn(net, 'createServer').mockImplementation(() => {
        const server = originalCreateServer()
        vi.spyOn(server, 'address').mockImplementation(() => null)
        return server
      })

      const willFailServer = new GdbServer(params)

      await expect(willFailServer.start()).to.rejects.toThrow(
        /failed to start server/gi
      )
      expect(willFailServer.server).toBeUndefined()
    })

    it('should error when address is string', async () => {
      const originalModule = await import('node:net')
      const originalCreateServer = originalModule.createServer
      vi.spyOn(net, 'createServer').mockImplementation(() => {
        const server = originalCreateServer()
        vi.spyOn(server, 'address').mockImplementation(() => 'localhost:1234')
        return server
      })

      const willFailServer = new GdbServer(params)

      await expect(willFailServer.start()).to.rejects.toThrow(
        /expected an address info object. got a string: localhost:1234/gi
      )
      expect(willFailServer.server).toBeUndefined()
    })

    it('should fail when the server is already started', async () => {
      await expect(server.start()).rejects.toThrow(/server already started/gi)
    })

    it('should end the connection when message starts with minus', async () => {
      const message = '-'
      client.write(message)
      let received = ''
      await new Promise((resolve) => {
        client.on('end', resolve)
        client.on('data', (data) => {
          received += data.toString()
        })
      })
      expect(received).toBe('-')
    })
    ;[
      ['+$?#3f', '+$T05#b9'],
      [
        '+$qSupported:multiprocess+;swbreak+;hwbreak+;qRelocInsn+;fork-events+;vfork-events+;exec-events+;vContSupported+;QThreadEvents+;no-resumed+;memory-tagging+#ec', //  unhandled
        '+$#00',
      ],
      ['+$Hg0#df', '+$OK#9a'],
      ['+$Hc0#df', '+$OK#9a'],
      ['+$qfThreadInfo#bb', '+$m1#9e'],
      ['+$qC#b4', '+$QC1#c5'],
      [
        '+$g#67',
        '+$000000007e0000420083c93f00d0c83f5083c93f0e89054000f0c83f00000000ea01004200f0c83f010000000100000000f0c83f00f0c83f0000000028000c60000000fa140000000000000000000000000000000000000000000000000000000000000000000000000000000000000000f0c83f0100000000f0c83f010000007e000042#1c',
      ],
      [
        '+$m3fc98300,40#fd',
        '+$0000000000000000000000004c1c0042000000000000000000000000205d38400000000000000000000000000000000000000000000000000000000000000000#bb',
      ],
      ['+$k#33', '+$OK#9a'],
      ['+$vKill;a410#33', '+$OK#9a'],
    ].map(([message, expected]) =>
      it(`should respond with ${expected} to ${message}`, async () => {
        client.write(message)
        client.end()
        let received = ''
        await new Promise((resolve) => {
          client.on('end', resolve)
          client.on('data', (data) => {
            received += data.toString()
          })
        })
        expect(received).toBe(expected)
      })
    )

    it('should handle multiple packets in a single chunk', async () => {
      client.write('+$?#3f+$qC#b4')
      client.end()
      let received = ''
      await new Promise((resolve) => {
        client.on('end', resolve)
        client.on('data', (data) => {
          received += data.toString()
        })
      })
      expect(received).toBe('+$T05#b9+$QC1#c5')
    })

    it('should handle packets split across chunks', async () => {
      client.write('+$qfTh')
      await new Promise((resolve) => setTimeout(resolve, 5))
      client.write('readInfo#bb')
      client.end()
      let received = ''
      await new Promise((resolve) => {
        client.on('end', resolve)
        client.on('data', (data) => {
          received += data.toString()
        })
      })
      expect(received).toBe('+$m1#9e')
    })

    describe('abort signal', () => {
      /** @type {GdbServer | undefined} */
      let otherServer
      /** @type {AbortController} */
      let abortController
      /** @type {AbortSignal} */
      let signal

      beforeEach(() => {
        abortController = new AbortController()
        signal = abortController.signal
      })

      afterEach(() => {
        otherServer?.close()
      })

      it('after start', async () => {
        otherServer = new GdbServer(params)
        const startPromise = otherServer.start({ signal })
        abortController.abort()
        await expect(startPromise).rejects.toThrow(/user abort/gi)
      })

      it('before start', async () => {
        otherServer = new GdbServer(params)
        abortController.abort()
        const startPromise = otherServer.start({ signal })
        await expect(startPromise).rejects.toThrow(/user abort/gi)
      })
    })
  })

  describe('decodeRiscv', () => {
    it('should error on invalid target', async () => {
      await expect(
        decodeRiscv(
          {
            elfPath: '',
            // @ts-ignore
            targetArch: 'invalid',
            toolPath: '',
          },
          '',
          {}
        )
      ).rejects.toThrow(/unsupported target: invalid/gi)
    })
  })

  describe('parsePanicOutput', () => {
    it('multi-code is not yet supported', () => {
      expect(() =>
        parsePanicOutput({
          input: `Core  0 register dump:
MEPC    : 0x42000074  RA      : 0x42000072  SP      : 0x3fc94f70  GP      : 0x3fc8c000  

Stack memory:
3fc94f70: 0x00000000 0x00000000 0x00000000 0x4200360a 0x00000000 0x00000000 0x00000000 0x403872d8

Core  1 register dump:
MEPC    : 0x42000074  RA      : 0x42000072  SP      : 0x3fc94f70  GP      : 0x3fc8c000  

Stack memory:
3fc94f70: 0x00000000 0x00000000 0x00000000 0x4200360a 0x00000000 0x00000000 0x00000000 0x403872d8`,
          target: 'esp32c3',
        })
      ).toThrow()
    })

    it('should handle incomplete panic info (for example, __attribute__((noinline)))', () => {
      expect(() =>
        parsePanicOutput({
          input: `MSTATUS : 0x00001881  MTVEC   : 0x40800001  MCAUSE  : 0x00000007  MTVAL   : 0x00000000  
MHARTID : 0x00000000  

Stack memory:
40816ac0: 0x00000000 0x00000000 0xa0000000 0x420000cc 0x00000000 0x20001090 0x00000000 0x42000088`,
          target: 'esp32h2',
        })
      ).toThrow(/no register dumps found/gi)
    })

    it('should parse the panic output', () => {
      const result = parsePanicOutput({
        input: esp32c3Input,
        target: 'esp32c3',
      })
      expect(result.coreId).toBe(0)
      expect(result.regs).toStrictEqual({
        MEPC: 0x4200007e,
        RA: 0x4200007e,
        SP: 0x3fc98300,
        GP: 0x3fc8d000,
        TP: 0x3fc98350,
        T0: 0x4005890e,
        T1: 0x3fc8f000,
        'S0/FP': 0x420001ea,
        S1: 0x3fc8f000,
        A0: 0x00000001,
        A1: 0x00000001,
        A2: 0x3fc8f000,
        A3: 0x3fc8f000,
        A5: 0x600c0028,
        A6: 0xfa000000,
        A7: 0x00000014,
        T3: 0x3fc8f000,
        T4: 0x00000001,
        T5: 0x3fc8f000,
        T6: 0x00000001,
      })
      expect(result.stackBaseAddr).toBe(0x3fc98300)
    })
  })

  describe('buildPanicServerArgs', () => {
    it('should build the panic server args', () => {
      expect(buildPanicServerArgs('path/to/elf', 36)).toStrictEqual([
        '--batch',
        '-n',
        'path/to/elf',
        '-ex',
        'target remote :36',
        '-ex',
        'bt',
      ])
    })
  })

  describe('getStackAddrAndData', () => {
    it('should throw when base address does not add up', () => {
      expect(() =>
        getStackAddrAndData({
          stackDump: [
            { baseAddr: 0x1000, data: [] },
            { baseAddr: 0x3000, data: [1, 2] },
          ],
        })
      ).toThrow(/invalid base address/gi)
    })
  })

  describe('parseGDBOutput', () => {
    it('should parse the GDB output (C3)', () => {
      const lines = parseGDBOutput(esp32c3Stdout)
      expect(lines).toStrictEqual([
        {
          method: 'a::geta',
          args: [{ name: 'this', value: '0x0' }],
          regAddr: '??',
          file: '/Users/kittaakos/Documents/Arduino/riscv_1/riscv_1.ino',
          lineNumber: '11',
        },
        {
          method: 'a::geta',
          args: [{ name: 'this', value: '0x0' }],
          regAddr: '??',
          file: '/Users/kittaakos/Documents/Arduino/riscv_1/riscv_1.ino',
          lineNumber: '11',
        },
        {
          method: 'loop',
          regAddr: '??',
          file: '/Users/kittaakos/Documents/Arduino/riscv_1/riscv_1.ino',
          lineNumber: '21',
        },
        {
          regAddr: '0x4c1c0042',
          lineNumber: '??',
        },
      ])
    })

    it('should parse the GDB output (C6)', () => {
      const lines = parseGDBOutput(esp32c6Stdout)
      expect(lines).toStrictEqual([
        {
          method: 'setup',
          regAddr: '0x420000a2',
          file: '/Users/kittaakos/dev/sandbox/trbr/.tests/sketches/eed_issue43/eed_issue43.ino',
          lineNumber: '20',
        },
        {
          method: 'setup',
          regAddr: '0x420000a2',
          file: '/Users/kittaakos/dev/sandbox/trbr/.tests/sketches/eed_issue43/eed_issue43.ino',
          lineNumber: '20',
        },
        {
          method: 'loopTask',
          args: [{ name: 'pvParameters', value: '<optimized out>' }],
          regAddr: '0x42002024',
          file: '/Users/kittaakos/Library/Arduino15/packages/esp32/hardware/esp32/3.2.0/cores/esp32/main.cpp',
          lineNumber: '59',
        },
        {
          lineNumber: '??',
          regAddr: '0x526c8040',
        },
      ])
    })
  })

  describe('MI parsing', () => {
    it('should parse MI frames', () => {
      const frames = parseMiFrames(miFramesOutput)
      expect(frames).toStrictEqual([
        {
          level: '0',
          addr: '0x4200007e',
          func: 'a::geta',
          file: '/path/sketch.ino',
          fullname: '/path/sketch.ino',
          line: '11',
        },
        {
          level: '1',
          addr: '0x42000088',
          func: 'loop',
          file: '/path/sketch.ino',
          line: '21',
        },
        {
          level: '2',
          addr: '0x4c1c0042',
        },
      ])
    })

    it('should map MI frames to parsed lines', () => {
      const frames = parseMiFrames(miFramesOutput)
      const parsed = frames.map(toParsedFrame)
      expect(parsed).toStrictEqual([
        {
          regAddr: '0x4200007e',
          method: 'a::geta',
          file: '/path/sketch.ino',
          lineNumber: '11',
        },
        {
          regAddr: '0x42000088',
          method: 'loop',
          file: '/path/sketch.ino',
          lineNumber: '21',
        },
        {
          regAddr: '0x4c1c0042',
          lineNumber: '??',
        },
      ])
    })

    it('should preserve Windows path separators when parsing MI frames', () => {
      const frames = parseMiFrames(miFramesOutputWindows)
      const parsed = frames.map(toParsedFrame)
      expect(parsed).toStrictEqual([
        {
          regAddr: '0x420000a0',
          method: 'functionC',
          file: String.raw`C:\Users\xxx\dev\git\boardlab\test_workspace\esp32backtracetest\module2.cpp`,
          lineNumber: '9',
        },
      ])
      expect(parsed[0].file.includes('\t')).toBe(false)
    })

    it('should parse MI stack arguments', () => {
      const args = parseMiStackArgs(miArgsOutput, '1')
      expect(args).toStrictEqual([
        { name: 'pvParameters', value: '<optimized out>' },
      ])
    })

    it('should parse MI locals', () => {
      const locals = parseMiLocals(miLocalsOutput)
      expect(locals).toStrictEqual([
        { scope: 'local', name: 'count', type: 'int', value: '42' },
        {
          scope: 'local',
          name: 'ptr',
          type: 'char *',
          value: '0x0',
          address: '0x3fc00000',
        },
      ])
    })
  })

  describe('toHexString', () => {
    it('should convert to hex string', () => {
      expect(toHexString(0x12345678)).toBe('0x12345678')
    })
    it('should pad 0', () => {
      expect(toHexString(0)).toBe('0x00000000')
    })
  })
})
