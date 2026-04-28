// @ts-check

import { defaultTargetArch } from '../targets.js'

/** @typedef {import('../targets.js').DecodeTarget} DecodeTarget */

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

// --- Backtrace

/** @typedef {CreateDecodeParamsParams & ToolParams & BacktraceMode} CreateDecodeParamsFromToolParams */
/** @typedef {CreateDecodeParamsFromToolParams} CreateDecodeParamsFromParams */

/**
 * @callback CreateDecodeParams
 * @param {CreateDecodeParamsFromParams} params
 * @returns {Promise<DecodeParams>}
 */

// --- Coredump

/** @typedef {CreateDecodeParamsParams & ToolParams & CoredumpMode} CreateCoredumpDecodeParamsFromToolParams */
/** @typedef {CreateCoredumpDecodeParamsFromToolParams} CreateCoredumpDecodeParamsFromParams */

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
  if (!isToolPathParams(params)) {
    throw new Error(
      `Unexpected create decode params input: ${JSON.stringify(params)}`
    )
  }

  /** @type {DecodeParams} */
  const decodeParams = {
    elfPath: params.elfPath,
    toolPath: params.toolPath,
    targetArch: params.targetArch ?? defaultTargetArch,
  }

  if (!isCoredumpModeParams(params)) {
    return decodeParams
  }

  return { ...decodeParams, coredumpMode: true }
}
