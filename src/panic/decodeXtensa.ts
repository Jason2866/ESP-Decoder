import { addr2line } from './addr2line';
import {
  parseESP32PanicOutput,
  parseESP8266PanicOutput,
  parseXtensaPanicOutput,
} from './panicParse';
import { isGDBLine, type DecodeOptions, type DecodeParams, type DecodeResult, type Debug } from './types';

/**
 * Decode an Xtensa panic output (ESP32/ESP32-S2/S3 "Guru Meditation" dumps and
 * ESP8266 "Exception (N)" dumps): extract candidate code addresses and resolve
 * them via addr2line against the firmware ELF.
 */
export async function decodeXtensa(
  params: DecodeParams,
  input: string,
  options: DecodeOptions = {},
): Promise<DecodeResult> {
  const log: Debug = options.debug ?? (() => {});
  log('decode start', { targetArch: params.targetArch, inputType: typeof input });

  const panicInfo = parseXtensaPanicOutput(input);
  if ('stackBaseAddr' in panicInfo) {
    throw new Error('panicInfo must not contain stackBaseAddr');
  }

  const decodedAddrs = await addr2line(
    params,
    [panicInfo.programCounter, panicInfo.faultAddr, ...(panicInfo.backtraceAddrs ?? [])],
    options,
  );
  const [programCounter, faultAddr, ...addrLines] = decodedAddrs;
  log('addr2line done', {
    programCounter,
    faultAddr,
    frames: addrLines.length,
  });

  let faultMessage: string | undefined;
  if (typeof panicInfo.faultCode === 'number') {
    // Use explicit type check so fault code 0 ("Illegal instruction") is preserved.
    faultMessage = exceptions[panicInfo.faultCode] ?? undefined;
  }

  return {
    faultInfo: {
      coreId: panicInfo.coreId,
      programCounter,
      faultAddr,
      faultCode: panicInfo.faultCode,
      faultMessage,
    },
    regs: panicInfo.regs,
    stacktraceLines: addrLines
      .map((line) => line?.location)
      .filter(isGDBLine),
  };
}

// Taken from https://github.com/me-no-dev/EspExceptionDecoder/blob/ff4fc36bdaf0bfd6e750086ac01554867ede76d3/src/EspExceptionDecoder.java#L59-L90
const reserved = 'reserved';
const exceptions: (string | null)[] = [
  'Illegal instruction',
  'SYSCALL instruction',
  'InstructionFetchError: Processor internal physical address or data error during instruction fetch',
  'LoadStoreError: Processor internal physical address or data error during load or store',
  'Level1Interrupt: Level-1 interrupt as indicated by set level-1 bits in the INTERRUPT register',
  "Alloca: MOVSP instruction, if caller's registers are not in the register file",
  'IntegerDivideByZero: QUOS, QUOU, REMS, or REMU divisor operand is zero',
  reserved,
  'Privileged: Attempt to execute a privileged operation when CRING ? 0',
  'LoadStoreAlignmentCause: Load or store to an unaligned address',
  reserved,
  reserved,
  'InstrPIFDataError: PIF data error during instruction fetch',
  'LoadStorePIFDataError: Synchronous PIF data error during LoadStore access',
  'InstrPIFAddrError: PIF address error during instruction fetch',
  'LoadStorePIFAddrError: Synchronous PIF address error during LoadStore access',
  'InstTLBMiss: Error during Instruction TLB refill',
  'InstTLBMultiHit: Multiple instruction TLB entries matched',
  'InstFetchPrivilege: An instruction fetch referenced a virtual address at a ring level less than CRING',
  reserved,
  'InstFetchProhibited: An instruction fetch referenced a page mapped with an attribute that does not permit instruction fetch',
  reserved,
  reserved,
  reserved,
  'LoadStoreTLBMiss: Error during TLB refill for a load or store',
  'LoadStoreTLBMultiHit: Multiple TLB entries matched for a load or store',
  'LoadStorePrivilege: A load or store referenced a virtual address at a ring level less than CRING',
  reserved,
  'LoadProhibited: A load referenced a page mapped with an attribute that does not permit loads',
  'StoreProhibited: A store referenced a page mapped with an attribute that does not permit stores',
];

export { parseESP32PanicOutput, parseESP8266PanicOutput };
