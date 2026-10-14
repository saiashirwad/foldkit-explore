import type { CheckReport } from './atlas'

export type CheckDecision = Readonly<{
  status: 'passed' | 'counterexample' | 'incomplete' | 'not-exercised' | 'error'
  exitCode: 0 | 1 | 2 | 3 | 4
}>

export const checkDecision = (report: CheckReport): CheckDecision => {
  if (
    report.errors.length !== 0 ||
    report.coverage.reached.status === 'model-error' ||
    report.properties.some(property => property.verdict === 'error')
  ) {
    return { status: 'error', exitCode: 3 }
  }
  if (report.violations.length !== 0) {
    return { status: 'counterexample', exitCode: 1 }
  }
  if (report.coverage.reached.status !== 'complete') {
    return { status: 'incomplete', exitCode: 2 }
  }
  if (
    report.properties.length === 0 ||
    report.properties.some(property => property.verdict === 'not-exercised')
  ) {
    return { status: 'not-exercised', exitCode: 4 }
  }
  if (report.properties.some(property => property.verdict !== 'complete')) {
    return { status: 'incomplete', exitCode: 2 }
  }
  return { status: 'passed', exitCode: 0 }
}
