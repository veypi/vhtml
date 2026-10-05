/* Expression dispatch and diagnostics. Execution policy is fixed by module registration. */
import { recordError } from './errors.js'
import { toPreview } from './compile.js'
import { NativeExecutor } from './execution/native.js'
import { moduleRecord } from './execution/context.js'
const native = new NativeExecutor()

function buildErrorContext(originCode, data, runtime, execArgs, label, error) {
  return {
    label,
    code: toPreview(originCode),
    dataKeys: Object.keys(data || {}),
    runtimeKeys: Object.keys(runtime || {}),
    execArgKeys: Object.keys(execArgs || {}),
    component: runtime?.diagnostic,
    message: error?.message || String(error),
    stack: error?.stack || '',
  }
}

function logError(originCode, data, runtime, execArgs, label, error) {
  const ctx = buildErrorContext(
    originCode,
    data,
    runtime,
    execArgs,
    label,
    error
  )
  recordError({
    kind: error?.name === 'SyntaxError' ? 'compile' : 'expression',
    ...ctx,
  })
  console.error(`${label} error`, ctx)
}

export function Run(code, data, runtime, locals = {}) {
  const execution = moduleRecord(runtime)?.execution || native
  try {
    return execution.evaluate(code, data, runtime, locals)
  } catch (error) {
    logError(code, data, runtime, locals, 'Run', error)
    if (error.name === 'SyntaxError') throw error
  }
}

export async function AsyncRun(
  code,
  data,
  runtime,
  locals = {},
  source = runtime?.source
) {
  const execution = moduleRecord(runtime)?.execution || native
  try {
    return await execution.execute(code, data, runtime, locals, source)
  } catch (error) {
    logError(code, data, runtime, locals, 'AsyncRun', error)
    throw error
  }
}
