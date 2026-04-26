// @ts-check

import {
  defaultTargetArch,
  findTargetArch,
  resolveBuildProperties,
  resolveToolPath,
} from '../tool.js'

/** @typedef {import('../tool.js').DecodeTarget} DecodeTarget */
/** @typedef {import('fqbn').FQBN} FQBN */

// --- Provides

/**
 * @typedef {Object} DecodeParams
 * @property {string} toolPath
 * @property {string} elfPath
 * @property {DecodeTarget} targetArch
 */

/** @typedef {DecodeParams & CoredumpMode} DecodeCoredumpParams */

// --- Base

/**
 * @typedef {Object} CreateDecodeParamsParams
 * @property {string} elfPath
 */

/**
 * @typedef {Object} ArduinoCliParams
 * @property {string} arduinoCliPath
 * @property {string} [arduinoCliConfigPath]
 * @property {string} [additionalUrls]
 */

/**
 * @typedef {Object} ToolParams
 * @property {string} toolPath
 * @property {DecodeTarget} [targetArch]
 */

/**
 * @typedef {Object} CoredumpMode
 * @property {true} coredumpMode
 */

/**
 * @typedef {Object} BacktraceMode
 * @property {false} [coredumpMode]
 */

/**
 * @typedef {Object} WithFQBN
 * @property {FQBN} fqbn
 */

/**
 * @typedef {WithFQBN & {
 *   buildProperties: Record<string, string>
 * }} WithBuildProperties
 */

// --- Backtrace

/** @typedef {CreateDecodeParamsParams & ToolParams & BacktraceMode} CreateDecodeParamsFromToolParams */
/**
 * @typedef {CreateDecodeParamsParams &
 *   ArduinoCliParams &
 *   WithFQBN &
 *   BacktraceMode} CreateDecodeParamsFromFQBNParams
 */
/** @typedef {CreateDecodeParamsParams & WithBuildProperties & BacktraceMode} CreateDecodeParamsFromBuildPropertiesParams */
/**
 * @typedef {CreateDecodeParamsFromToolParams
 *   | CreateDecodeParamsFromFQBNParams
 *   | CreateDecodeParamsFromBuildPropertiesParams} CreateDecodeParamsFromParams
 */

/**
 * @callback CreateDecodeParams
 * @param {CreateDecodeParamsFromParams} params
 * @returns {Promise<DecodeParams>}
 */

// --- Coredump

/** @typedef {CreateDecodeParamsParams & ToolParams & CoredumpMode} CreateCoredumpDecodeParamsFromToolParams */
/**
 * @typedef {CreateDecodeParamsParams &
 *   ArduinoCliParams &
 *   WithFQBN &
 *   CoredumpMode} CreateCoredumpDecodeParamsFromFQBNParams
 */
/** @typedef {CreateDecodeParamsParams & WithBuildProperties & CoredumpMode} CreateCoredumpDecodeParamsFromBuildPropertiesParams */
/**
 * @typedef {CreateCoredumpDecodeParamsFromToolParams
 *   | CreateCoredumpDecodeParamsFromFQBNParams
 *   | CreateCoredumpDecodeParamsFromBuildPropertiesParams} CreateCoredumpDecodeParamsFromParams
 */

/**
 * @callback CreateCoredumpDecodeParams
 * @param {CreateCoredumpDecodeParamsFromParams} params
 * @returns {Promise<DecodeCoredumpParams>}
 */

/**
 * @param {CreateDecodeParamsParams} params
 * @returns {params is CreateCoredumpDecodeParamsFromParams}
 */
export function isCoredumpModeParams(params) {
  return 'coredumpMode' in params && Boolean(params.coredumpMode)
}

/**
 * @param {CreateDecodeParamsParams} params
 * @returns {params is CreateDecodeParamsFromToolParams|CreateCoredumpDecodeParamsFromToolParams}
 */
function isToolPathParams(params) {
  return 'toolPath' in params && typeof params.toolPath === 'string'
}

/**
 * @param {CreateDecodeParamsParams} params
 * @returns {params is CreateDecodeParamsFromBuildPropertiesParams|CreateCoredumpDecodeParamsFromBuildPropertiesParams}
 */
function isBuildPropertiesParams(params) {
  return (
    'buildProperties' in params && typeof params.buildProperties === 'object'
  )
}

/**
 * @param {CreateDecodeParamsParams} params
 * @returns {params is CreateDecodeParamsFromFQBNParams|CreateCoredumpDecodeParamsFromFQBNParams}
 */
function isArduinoCliParams(params) {
  return 'arduinoCliPath' in params && typeof params.arduinoCliPath === 'string'
}

/**
 * @overload
 * @param {CreateDecodeParamsFromParams} params
 * @returns {Promise<DecodeParams>}
 */
/**
 * @overload
 * @param {CreateCoredumpDecodeParamsFromParams} params
 * @returns {Promise<DecodeCoredumpParams>}
 */
/**
 * @param {CreateDecodeParamsFromParams
 *   | CreateCoredumpDecodeParamsFromParams} params
 * @returns {Promise<DecodeParams | DecodeCoredumpParams>}
 */
export async function createDecodeParams(params) {
  /** @type {string | undefined} */
  let toolPath
  /** @type {DecodeTarget | undefined} */
  let targetArch

  if (isToolPathParams(params)) {
    toolPath = params.toolPath
    targetArch = params.targetArch ?? defaultTargetArch
  } else if (isBuildPropertiesParams(params)) {
    toolPath = await resolveToolPath(params)
    targetArch = findTargetArch(params)
  } else if (isArduinoCliParams(params)) {
    const buildProperties = await resolveBuildProperties(params)
    toolPath = await resolveToolPath({
      fqbn: params.fqbn,
      buildProperties,
    })
    targetArch = findTargetArch({ buildProperties })
  } else {
    throw new Error(
      `Unexpected create decode params input: ${JSON.stringify(params)}`
    )
  }

  /** @type {DecodeParams} */
  const decodeParams = {
    elfPath: params.elfPath,
    toolPath,
    targetArch,
  }

  if (!isCoredumpModeParams(params)) {
    return decodeParams
  }

  return { ...decodeParams, coredumpMode: true }
}
